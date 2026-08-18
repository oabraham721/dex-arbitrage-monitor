import { createPublicClient, formatUnits, http } from "viem";
import { base } from "viem/chains";
import { config, type Route } from "./config.js";
import { logToNotion } from "./notion.js";
import { getQuote } from "./quoter.js";

type Opportunity = {
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

async function evaluate(buy: Route, sell: Route, gasPrice: bigint): Promise<Opportunity> {
  const first = await getQuote(
    client,
    buy.quoter,
    config.usdc,
    config.weth,
    config.tradeSize,
    buy.fee,
  );
  const second = await getQuote(
    client,
    sell.quoter,
    config.weth,
    config.usdc,
    first.amountOut,
    sell.fee,
  );

  const gasUnits = first.gasEstimate + second.gasEstimate + config.gasOverhead;
  const gasInWei = gasUnits * gasPrice;
  const gasCostUsdc = (gasInWei * second.amountOut) / first.amountOut / 1_000_000_000_000n;
  const grossProfit = second.amountOut - config.tradeSize;
  const netProfit = grossProfit - gasCostUsdc - config.executionCostBuffer;

  return {
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
    `  ${marker}: ${opportunity.buy} -> ${opportunity.sell}` +
      ` | output ${usdc(opportunity.grossOutput)}` +
      ` | gas ${usdc(opportunity.gasCost)}` +
      ` | buffer ${usdc(config.executionCostBuffer)}` +
      ` | net ${usdc(opportunity.netProfit)}` +
      ` | gross ${opportunity.grossBps} bps`,
  );
}

async function scan(): Promise<void> {
  const blockNumber = await client.getBlockNumber();
  const gasPrice = await client.getGasPrice();
  const jobs: Promise<Opportunity>[] = [];

  for (const buy of config.routes) {
    for (const sell of config.routes) {
      if (buy !== sell) jobs.push(evaluate(buy, sell, gasPrice));
    }
  }

  const results = (await Promise.allSettled(jobs))
    .flatMap((result) => {
      if (result.status === "fulfilled") return [result.value];
      console.error(`  Quote failed: ${result.reason instanceof Error ? result.reason.message : result.reason}`);
      return [];
    })
    .sort((left, right) => (left.netProfit > right.netProfit ? -1 : 1));

  const profitable = results.filter((result) => result.netProfit >= config.minimumProfit);
  console.log(`\n[${new Date().toISOString()}] Base block ${blockNumber}`);
  if (profitable.length === 0) console.log("  No net-profitable route at the configured threshold.");
  for (const result of config.showAll ? results : profitable) printOpportunity(result);
  await Promise.all(profitable.map((result) => logToNotion(result, blockNumber)));
}

async function main(): Promise<void> {
  console.log(
    `Monitoring ${config.routes.length} routes with ${usdc(config.tradeSize)} paper trades` +
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