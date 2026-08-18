import { createPublicClient, formatUnits, http } from "viem";
import { base } from "viem/chains";
import { config, type Pair, type Route } from "./config.js";
import { logToNotion } from "./notion.js";
import { getQuote } from "./quoter.js";

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
  transport: http(config.rpcUrl, { retryCount: 2, timeout: 10_000 }),
});

async function evaluate(pair: Pair, buy: Route, sell: Route, gasPrice: bigint): Promise<Opportunity> {
  const first = await getQuote(
    client,
    buy.quoter,
    pair.tokenA,
    pair.tokenB,
    config.tradeSize,
    buy.param,
    buy.quoterType,
  );
  const second = await getQuote(
    client,
    sell.quoter,
    pair.tokenB,
    pair.tokenA,
    first.amountOut,
    sell.param,
    sell.quoterType,
  );

  const gasUnits = first.gasEstimate + second.gasEstimate + config.gasOverhead;
  const gasInWei = gasUnits * gasPrice;
  const gasCostUsdc = (gasInWei * second.amountOut) / first.amountOut / 1_000_000_000_000n;
  const grossProfit = second.amountOut - config.tradeSize;
  const netProfit = grossProfit - gasCostUsdc - config.executionCostBuffer;

  return {
    pair: pair.name,
    buy: buy.name,
    sell: sell.name,
    grossOutput: second.amountOut,
    gasCost: gasCostUsdc,
    netProfit,
    grossBps: (grossProfit * 10_000n) / config.tradeSize,
  };
}

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

const RPC_DELAY = 500; // ms between RPC calls to avoid public endpoint rate limits
const delay = () => new Promise((r) => setTimeout(r, RPC_DELAY));

async function scan(): Promise<void> {
  const blockNumber = await client.getBlockNumber();
  await delay();
  const gasPrice = await client.getGasPrice();
  await delay();
  const results: Opportunity[] = [];

  for (const pair of config.pairs) {
    const buyQuotes = new Map<Route, { amountOut: bigint; gasEstimate: bigint }>();
    for (const route of config.routes) {
      try {
        const quote = await getQuote(client, route.quoter, pair.tokenA, pair.tokenB, config.tradeSize, route.param, route.quoterType);
        buyQuotes.set(route, quote);
      } catch {
        // Pool doesn't exist for this route+pair
      }
      await delay();
    }

    for (const [buyRoute, buyQuote] of buyQuotes) {
      for (const sellRoute of config.routes) {
        if (sellRoute === buyRoute) continue;
        try {
          const sellQuote = await getQuote(client, sellRoute.quoter, pair.tokenB, pair.tokenA, buyQuote.amountOut, sellRoute.param, sellRoute.quoterType);
          const gasUnits = buyQuote.gasEstimate + sellQuote.gasEstimate + config.gasOverhead;
          const gasInWei = gasUnits * gasPrice;
          const gasCostUsdc = (gasInWei * sellQuote.amountOut) / buyQuote.amountOut / 1_000_000_000_000n;
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
        } catch {
          // Pool doesn't exist for this route+pair
        }
        await delay();
      }
    }
  }

  results.sort((left, right) => (left.netProfit > right.netProfit ? -1 : 1));

  const profitable = results.filter((result) => result.netProfit >= config.minimumProfit);
  const shown = config.showAll ? results.slice(0, 20) : profitable;
  console.log(`\n[${new Date().toISOString()}] Base block ${blockNumber} | ${results.length} routes evaluated`);
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

  do {
    try {
      await scan();
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
    }
    if (!config.once) await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
  } while (!config.once);
}

process.on("SIGINT", () => {
  console.log("\nMonitor stopped.");
  process.exit(0);
});

await main();