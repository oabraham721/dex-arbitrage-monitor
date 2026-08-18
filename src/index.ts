import { createPublicClient, formatUnits, http } from "viem";
import { base } from "viem/chains";
import { config, type Pair, type Route } from "./config.js";
import { logToNotion } from "./notion.js";
import { batchQuote, batchQuoteWithMeta, type Quote, type QuoteRequest } from "./multicall.js";

type Opportunity = {
  pair: string;
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
    for (const route of config.routes) {
      if (isDead(pair, route)) continue;
      buyRequests.push({
        quoter: route.quoter,
        tokenIn: pair.tokenA,
        tokenOut: pair.tokenB,
        amountIn: config.tradeSize,
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

  // Phase 3: calculate profits
  const results: Opportunity[] = [];
  for (let i = 0; i < sellResults.length; i++) {
    const sellQuote = sellResults[i];
    if (!sellQuote) continue;
    const { pair, buyRoute, sellRoute, buyQuote } = sellIndex[i]!;

    const gasUnits = buyQuote.gasEstimate + sellQuote.gasEstimate + config.gasOverhead;
    const gasInWei = gasUnits * gasPrice;
    const gasCostUsdc = ethPriceValid ? (gasInWei * config.tradeSize) / wethBest : 0n;
    const grossProfit = sellQuote.amountOut - config.tradeSize;
    const netProfit = grossProfit - gasCostUsdc - config.executionCostBuffer;
    results.push({
      pair: pair.name,
      buy: buyRoute.name,
      sell: sellRoute.name,
      grossOutput: sellQuote.amountOut,
      gasCost: gasCostUsdc,
      netProfit,
      grossBps: (grossProfit * 10_000n) / config.tradeSize,
    });
  }

  results.sort((left, right) => (left.netProfit > right.netProfit ? -1 : 1));

  const profitable = results.filter((result) => result.netProfit >= config.minimumProfit);
  const shown = config.showAll ? results.slice(0, 20) : profitable;
  const dead = failCounts.size > 0 ? ` | ${failCounts.size} dead pools cached` : "";
  console.log(`\n[${new Date().toISOString()}] Base block ${blockNumber} | ${results.length} routes | ${buyRequests.length + sellRequests.length} quotes in 3 RPC calls${dead}`);
  if (profitable.length === 0) console.log("  No net-profitable route at the configured threshold.");
  for (const result of shown) printOpportunity(result);
  await Promise.all(profitable.map((result) => logToNotion(result, blockNumber)));
}

async function main(): Promise<void> {
  const combos = config.pairs.length * config.routes.length * (config.routes.length - 1);
  console.log(
    `Monitoring ${config.routes.length} routes x ${config.pairs.length} pairs (${combos} combinations)` +
      ` with ${usdc(config.tradeSize)} paper trades` +
      `; minimum net profit ${usdc(config.minimumProfit)}` +
      `; execution buffer ${usdc(config.executionCostBuffer)}.`,
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