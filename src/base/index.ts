import { createPublicClient, createWalletClient, formatUnits, http, type Address } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config, type Pair, type Route } from "./config.js";
import { logToNotion } from "./notion.js";
import { batchQuote, batchQuoteWithMeta, type Quote, type QuoteRequest } from "./multicall.js";
import { findOptimalSize } from "./optimal-size.js";
import { encodeSwapCalldata, encodeArbData, getSwapRouter, getSellAmountInOffset, executorAbi } from "./executor.js";

type Opportunity = {
  pair: string;
  pairRef: Pair;
  buyRoute: Route;
  sellRoute: Route;
  buy: string;
  sell: string;
  grossOutput: bigint;
  gasCost: bigint;
  netProfit: bigint;
  grossBps: bigint;
};

const client = createPublicClient({
  chain: base,
  cacheTime: 0,
  transport: http(config.rpcUrl, { retryCount: 2, timeout: 20_000 }),
});

// Dead pool cache: skip route+pair combos that fail N times in a row
const DEAD_THRESHOLD = 5;
const failCounts = new Map<string, number>();

function poolKey(pair: Pair, route: Route): string {
  return `${pair.name}:${route.name}`;
}

function isDead(pair: Pair, route: Route): boolean {
  return (failCounts.get(poolKey(pair, route)) ?? 0) >= DEAD_THRESHOLD;
}

function recordResult(pair: Pair, route: Route, success: boolean): void {
  const key = poolKey(pair, route);
  if (success) {
    failCounts.delete(key);
  } else {
    failCounts.set(key, (failCounts.get(key) ?? 0) + 1);
  }
}

// Pre-filter: skip buys that are >30 bps worse than the best for that pair
const BUY_FILTER_BPS = 30n;

function usdc(value: bigint): string {
  return `$${Number(formatUnits(value, 6)).toFixed(4)}`;
}

function printOpportunity(opportunity: Opportunity): void {
  const marker = opportunity.netProfit >= config.minimumProfit ? "OPPORTUNITY" : "candidate";
  console.log(
    `  ${marker}: [${opportunity.pair}] ${opportunity.buy} -> ${opportunity.sell}` +
      ` | output ${usdc(opportunity.grossOutput)}` +
      ` | gas ${usdc(opportunity.gasCost)}` +
      ` | buffer ${usdc(config.executionCostBuffer)}` +
      ` | net ${usdc(opportunity.netProfit)}` +
      ` | gross ${opportunity.grossBps} bps`,
  );
}

async function scan(): Promise<void> {
  // Phase 1: batch all buy quotes + metadata in one RPC call
  const buyRequests: QuoteRequest[] = [];
  const buyIndex: { pair: Pair; route: Route }[] = [];

  for (const pair of config.pairs) {
    const amountIn = pair.decimalsA === 18 ? config.tradeSizeWeth : config.tradeSize;
    for (const route of config.routes) {
      if (isDead(pair, route)) continue;
      buyRequests.push({
        quoter: route.quoter,
        tokenIn: pair.tokenA,
        tokenOut: pair.tokenB,
        amountIn,
        param: route.param,
        quoterType: route.quoterType,
        pool: route.pool,
      });
      buyIndex.push({ pair, route });
    }
  }

  const { blockNumber, quotes: buyResults } = await batchQuoteWithMeta(client, buyRequests);
  const gasPrice = await client.getGasPrice();

  // Update dead pool cache from buy results
  for (let i = 0; i < buyResults.length; i++) {
    const { pair, route } = buyIndex[i]!;
    recordResult(pair, route, buyResults[i] !== null);
  }

  // Pre-filter: find best buy per pair, skip any >30 bps worse
  const bestBuyPerPair = new Map<string, bigint>();
  for (let i = 0; i < buyResults.length; i++) {
    const quote = buyResults[i];
    if (!quote) continue;
    const pairName = buyIndex[i]!.pair.name;
    const current = bestBuyPerPair.get(pairName) ?? 0n;
    if (quote.amountOut > current) bestBuyPerPair.set(pairName, quote.amountOut);
  }

  // Derive ETH price from WETH/USDC pair for gas cost conversion
  const wethBest = bestBuyPerPair.get("WETH/USDC") ?? 0n;
  const ethPriceValid = wethBest > 0n;

  // Phase 2: build sell requests from filtered buys
  const sellRequests: QuoteRequest[] = [];
  const sellIndex: { pair: Pair; buyRoute: Route; sellRoute: Route; buyQuote: Quote }[] = [];

  for (let i = 0; i < buyResults.length; i++) {
    const buyQuote = buyResults[i];
    if (!buyQuote) continue;
    const { pair, route: buyRoute } = buyIndex[i]!;

    const best = bestBuyPerPair.get(pair.name)!;
    if ((best - buyQuote.amountOut) * 10_000n / best > BUY_FILTER_BPS) continue;

    for (const sellRoute of config.routes) {
      if (sellRoute === buyRoute) continue;
      if (isDead(pair, sellRoute)) continue;
      sellRequests.push({
        quoter: sellRoute.quoter,
        tokenIn: pair.tokenB,
        tokenOut: pair.tokenA,
        amountIn: buyQuote.amountOut,
        param: sellRoute.param,
        quoterType: sellRoute.quoterType,
        pool: sellRoute.pool,
      });
      sellIndex.push({ pair, buyRoute, sellRoute, buyQuote });
    }
  }

  const sellResults = await batchQuote(client, sellRequests);

  // Update dead pool cache from sell results
  for (let i = 0; i < sellResults.length; i++) {
    const { pair, sellRoute } = sellIndex[i]!;
    recordResult(pair, sellRoute, sellResults[i] !== null);
  }

  // Phase 3: calculate profits (all values normalized to USDC 6 decimals)
  const results: Opportunity[] = [];
  for (let i = 0; i < sellResults.length; i++) {
    const sellQuote = sellResults[i];
    if (!sellQuote) continue;
    const { pair, buyRoute, sellRoute, buyQuote } = sellIndex[i]!;

    const gasUnits = buyQuote.gasEstimate + sellQuote.gasEstimate + config.gasOverhead;
    const gasInWei = gasUnits * gasPrice;
    const gasCostUsdc = ethPriceValid ? (gasInWei * config.tradeSize) / wethBest : 0n;

    const isWethPair = pair.decimalsA === 18;
    const tradeSize = isWethPair ? config.tradeSizeWeth : config.tradeSize;
    const grossProfitNative = sellQuote.amountOut - tradeSize;
    const grossBps = (grossProfitNative * 10_000n) / tradeSize;

    // Convert WETH-denominated profit to USDC; USDC pairs are already in USDC
    const grossProfitUsdc = isWethPair && ethPriceValid
      ? (grossProfitNative * config.tradeSize) / wethBest
      : grossProfitNative;
    const grossOutputUsdc = isWethPair && ethPriceValid
      ? (sellQuote.amountOut * config.tradeSize) / wethBest
      : sellQuote.amountOut;

    const netProfit = grossProfitUsdc - gasCostUsdc - config.executionCostBuffer;
    results.push({
      pair: pair.name,
      pairRef: pair,
      buyRoute,
      sellRoute,
      buy: buyRoute.name,
      sell: sellRoute.name,
      grossOutput: grossOutputUsdc,
      gasCost: gasCostUsdc,
      netProfit,
      grossBps,
    });
  }

  results.sort((left, right) => (left.netProfit > right.netProfit ? -1 : 1));

  const profitable = results.filter((result) => result.netProfit >= config.minimumProfit);
  const shown = config.showAll ? results.slice(0, 20) : profitable;
  const dead = failCounts.size > 0 ? ` | ${failCounts.size} dead pools cached` : "";
  console.log(`\n[${new Date().toISOString()}] Base block ${blockNumber} | ${results.length} routes | ${buyRequests.length + sellRequests.length} quotes in 3 RPC calls${dead}`);
  if (profitable.length === 0) console.log("  No net-profitable route at the configured threshold.");
  for (const result of shown) printOpportunity(result);

  // For profitable opportunities, find optimal flash loan size
  for (const result of profitable) {
    try {
      const optimal = await findOptimalSize(
        client, result.pairRef, result.buyRoute, result.sellRoute,
        gasPrice, wethBest,
      );
      console.log(
        `    optimal: ${usdc(optimal.optimalSizeUsdc)} trade → ${usdc(optimal.peakNetProfit)} peak profit` +
        ` | breakeven at ${usdc(optimal.maxBreakevenSize)}`,
      );
      await logToNotion(result, blockNumber, optimal.peakNetProfit, optimal.optimalSizeUsdc);

      // Execute via flash loan if enabled and profitable at optimal size
      if (config.execute && optimal.peakNetProfit > 0n) {
        await executeArb(result, optimal.optimalSize);
      }
    } catch (error) {
      console.error(`    optimal size search failed: ${error instanceof Error ? error.message : error}`);
      await logToNotion(result, blockNumber, null, null);
    }
  }
}

// Wallet client for execution (only created if EXECUTE=true)
const walletClient = config.execute && config.privateKey && config.executorAddress
  ? createWalletClient({
      account: privateKeyToAccount(config.privateKey),
      chain: base,
      transport: http(config.rpcUrl, { retryCount: 2, timeout: 20_000 }),
    })
  : null;

async function executeArb(opp: Opportunity, optimalSize: bigint): Promise<void> {
  if (!walletClient || !config.executorAddress) {
    console.log("    EXECUTE mode enabled but missing PRIVATE_KEY or EXECUTOR_ADDRESS");
    return;
  }

  try {
    const buyRouter = getSwapRouter(opp.buyRoute.quoter);
    const sellRouter = getSwapRouter(opp.sellRoute.quoter);
    const executorAddr = config.executorAddress;

    const tokenIn = opp.pairRef.tokenA;
    const tokenOut = opp.pairRef.tokenB;

    // Quote the buy at optimal size to get expected output for sell input
    const [buyQuote] = await batchQuote(client, [{
      quoter: opp.buyRoute.quoter, tokenIn, tokenOut, amountIn: optimalSize,
      param: opp.buyRoute.param, quoterType: opp.buyRoute.quoterType, pool: opp.buyRoute.pool,
    }]);
    if (!buyQuote) {
      console.log("    Buy quote failed at optimal size, skipping execution");
      return;
    }

    const buyCalldata = encodeSwapCalldata(
      opp.buyRoute, tokenIn, tokenOut, optimalSize, 0n, executorAddr,
    );
    const sellCalldata = encodeSwapCalldata(
      opp.sellRoute, tokenOut, tokenIn, buyQuote.amountOut, 0n, executorAddr,
    );

    // min profit = 1 unit (safety net — the on-chain check prevents loss)
    const minProfit = 1n;
    const sellAmountInOffset = getSellAmountInOffset(opp.sellRoute.quoter);

    const arbData = encodeArbData(
      buyRouter, buyCalldata, sellRouter, sellCalldata,
      tokenIn, tokenOut, minProfit, sellAmountInOffset,
    );

    console.log(`    EXECUTING: ${opp.buy} → ${opp.sell} | size ${usdc(optimalSize)}`);

    const hash = await walletClient.writeContract({
      address: executorAddr,
      abi: executorAbi,
      functionName: "execute",
      args: [tokenIn, optimalSize, arbData],
    });

    console.log(`    TX submitted: ${hash}`);
    const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
    console.log(`    TX ${receipt.status}: gas used ${receipt.gasUsed}`);
  } catch (error) {
    console.error(`    Execution failed: ${error instanceof Error ? error.message : error}`);
  }
}

async function main(): Promise<void> {
  const combos = config.pairs.length * config.routes.length * (config.routes.length - 1);
  console.log(
    `Monitoring ${config.routes.length} routes x ${config.pairs.length} pairs (${combos} combinations)` +
      ` with ${usdc(config.tradeSize)} paper trades` +
      `; minimum net profit ${usdc(config.minimumProfit)}` +
      `; execution buffer ${usdc(config.executionCostBuffer)}` +
      `${config.execute ? "; EXECUTION ENABLED" : ""}.`,
  );

  if (config.once) {
    await scan();
    return;
  }

  let lastBlock = 0n;
  const loop = async () => {
    while (true) {
      try {
        const block = await client.getBlockNumber();
        if (block > lastBlock) {
          lastBlock = block;
          await scan();
        }
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      await new Promise((r) => setTimeout(r, config.pollIntervalMs));
    }
  };

  process.on("SIGINT", () => {
    console.log("\nMonitor stopped.");
    process.exit(0);
  });
  process.on("SIGTERM", () => process.exit(0));

  await loop();
}

await main();