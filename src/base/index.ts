import { createPublicClient, createWalletClient, formatUnits, http, webSocket, type Address } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { config, type Pair, type Route } from "./config.js";
import { logToNotion } from "./notion.js";
import { batchQuote, batchQuoteWithMeta, type Quote, type QuoteRequest } from "./multicall.js";
import { findOptimalSize } from "./optimal-size.js";
import { encodeSwapCalldata, encodeArbData, getSwapRouter, getSellAmountInOffset, patchCalldata, executorAbi } from "./executor.js";

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

  const { blockNumber, basefee, quotes: buyResults } = await batchQuoteWithMeta(client, buyRequests);
  const gasPrice = basefee;

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
  const MIN_EXEC_PROFIT = 100_000n; // $0.10 USDC minimum to attempt execution

  // Execute only the best opportunity per block (avoids nonce collisions)
  const best = profitable.filter(r => r.netProfit >= MIN_EXEC_PROFIT).sort((a, b) => Number(b.netProfit - a.netProfit))[0];
  if (config.execute && best) {
    const cacheKey = `${best.pair}:${best.buy}:${best.sell}`;
    const cached = optimalSizeCache.get(cacheKey);
    const execSize = cached?.size ?? DEFAULT_EXEC_SIZE;
    const execBuyOutput = cached?.buyOutput ?? execSize;
    executeArb(best, execSize, execBuyOutput).catch(() => {});
  }

  for (const result of profitable) {
    const cacheKey = `${result.pair}:${result.buy}:${result.sell}`;

    // SLOW PATH: run optimal size search, update cache for next time
    findOptimalSize(client, result.pairRef, result.buyRoute, result.sellRoute, gasPrice, wethBest)
      .then(async (optimal) => {
        // Update cache for next opportunity on this route
        if (optimal.peakNetProfit > 0n) {
          optimalSizeCache.set(cacheKey, { size: optimal.optimalSize, buyOutput: optimal.buyOutputAtOptimal });
        }
        console.log(
          `    optimal: ${usdc(optimal.optimalSizeUsdc)} trade → ${usdc(optimal.peakNetProfit)} peak profit` +
          ` | breakeven at ${usdc(optimal.maxBreakevenSize)}`,
        );
        await logToNotion(result, blockNumber, optimal.peakNetProfit, optimal.optimalSizeUsdc);
      })
      .catch(async (error) => {
        console.error(`    optimal size search failed: ${error instanceof Error ? error.message : error}`);
        await logToNotion(result, blockNumber, null, null);
      });
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

// Hybrid execution: cache last-known optimal size per route combo
const DEFAULT_EXEC_SIZE = 10_000_000_000n; // $10K USDC (conservative default for cold cache)
const optimalSizeCache = new Map<string, { size: bigint; buyOutput: bigint }>();

// Pre-encoded calldata templates keyed by "pairIdx:routeIdx" with placeholder amountIn=1
type CalldataTemplate = { calldata: `0x${string}`; amountInOffset: number };
const calldataTemplates = new Map<string, CalldataTemplate>();

function getTemplate(pair: Pair, route: Route, isBuyLeg: boolean): CalldataTemplate {
  const key = `${pair.name}:${route.name}:${isBuyLeg ? "buy" : "sell"}`;
  let tpl = calldataTemplates.get(key);
  if (!tpl) {
    const executorAddr = config.executorAddress!;
    const [tokenIn, tokenOut] = isBuyLeg ? [pair.tokenA, pair.tokenB] : [pair.tokenB, pair.tokenA];
    const calldata = encodeSwapCalldata(route, tokenIn, tokenOut, 1n, 0n, executorAddr);
    const offset = Number(getSellAmountInOffset(route.quoter));
    tpl = { calldata, amountInOffset: offset };
    calldataTemplates.set(key, tpl);
  }
  return tpl;
}

async function executeArb(opp: Opportunity, optimalSize: bigint, buyOutput: bigint): Promise<void> {
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

    // Patch pre-encoded templates with actual amounts (avoids full ABI encoding)
    const buyTpl = getTemplate(opp.pairRef, opp.buyRoute, true);
    const buyCalldata = patchCalldata(buyTpl.calldata, buyTpl.amountInOffset, optimalSize);
    const sellTpl = getTemplate(opp.pairRef, opp.sellRoute, false);
    const sellCalldata = patchCalldata(sellTpl.calldata, sellTpl.amountInOffset, buyOutput);

    const minProfit = 1n;
    const sellAmountInOffset = BigInt(sellTpl.amountInOffset);

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
      gas: 500_000n,
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

  process.on("SIGINT", () => {
    console.log("\nMonitor stopped.");
    process.exit(0);
  });
  process.on("SIGTERM", () => process.exit(0));

  // WebSocket mode: scan immediately on each new block
  if (config.wsUrl) {
    console.log("Using WebSocket for block notifications.");
    const wsClient = createPublicClient({
      chain: base,
      transport: webSocket(config.wsUrl, { retryCount: 5 }),
    });
    let scanning = false;
    wsClient.watchBlockNumber({
      onBlockNumber: async () => {
        if (scanning) return;
        scanning = true;
        try { await scan(); } catch (e) {
          console.error(e instanceof Error ? e.message : e);
        }
        scanning = false;
      },
    });
    // Keep process alive
    await new Promise(() => {});
  }

  // HTTP fallback: tight loop, no artificial delay
  let lastBlock = 0n;
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
    await new Promise((r) => setTimeout(r, 250));
  }
}

await main();