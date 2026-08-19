import { config, type Pair, type Protocol } from "./config.js";
import { initRouter, getQuotesPerProtocol, type PerDexQuote } from "./quotes.js";
import { logToNotion, type NotionOpportunity } from "../shared/notion.js";
import { parseUnits } from "viem";

type Opportunity = {
  pair: string;
  buy: string;
  sell: string;
  netProfitUsd: number;
  grossOutputUsd: number;
  gasCostUsd: number;
  grossBps: number;
  tradeSizeUsd: number;
};

const SUI_GAS_COST_USD = 0.002;

function tradeAmountIn(pair: Pair): bigint {
  return pair.decimalsIn === 9
    ? parseUnits(String(config.tradeSizeSui), 9)
    : parseUnits(String(config.tradeSizeUsdc), pair.decimalsIn);
}

function tradeSizeUsd(pair: Pair): number {
  return pair.decimalsIn === 9 ? config.tradeSizeSui * suiPriceUsd : config.tradeSizeUsdc;
}

let suiPriceUsd = 0;
let scanCount = 0;

async function scan(): Promise<void> {
  scanCount++;
  const results: Opportunity[] = [];

  for (const pair of config.pairs) {
    const amountIn = tradeAmountIn(pair);
    const sizeUsd = tradeSizeUsd(pair);
    if (sizeUsd <= 0) continue;

    // Get buy quotes from all protocols
    const buyQuotes = await getQuotesPerProtocol(
      pair.coinIn,
      pair.coinOut,
      amountIn,
      config.protocols,
    );

    if (buyQuotes.length < 2) continue;

    // For each buy, get sell quotes on all other protocols
    for (const buy of buyQuotes) {
      const sellQuotes = await getQuotesPerProtocol(
        pair.coinOut,
        pair.coinIn,
        buy.amountOut,
        config.protocols.filter((p) => p !== buy.protocol),
      );

      for (const sell of sellQuotes) {
        const returnedRaw = Number(sell.amountOut);
        const inputRaw = Number(amountIn);
        const grossProfit = returnedRaw - inputRaw;
        const grossProfitUsd = (grossProfit / inputRaw) * sizeUsd;
        const grossBps = Math.round((grossProfit / inputRaw) * 10_000);
        const netProfitUsd = grossProfitUsd - SUI_GAS_COST_USD;
        const grossOutputUsd = (returnedRaw / inputRaw) * sizeUsd;

        results.push({
          pair: pair.name,
          buy: buy.protocol,
          sell: sell.protocol,
          netProfitUsd,
          grossOutputUsd,
          gasCostUsd: SUI_GAS_COST_USD,
          grossBps,
          tradeSizeUsd: sizeUsd,
        });
      }
    }
  }

  results.sort((a, b) => b.netProfitUsd - a.netProfitUsd);

  const profitable = results.filter((r) => r.netProfitUsd >= config.minimumProfitUsd);
  const shown = config.showAll ? results.slice(0, 20) : profitable;

  console.log(
    `\n[${new Date().toISOString()}] Sui scan #${scanCount} | ${results.length} routes`,
  );
  if (profitable.length === 0) {
    console.log("  No net-profitable route at the configured threshold.");
  }
  for (const r of shown) {
    const marker = r.netProfitUsd >= config.minimumProfitUsd ? "OPPORTUNITY" : "candidate";
    console.log(
      `  ${marker}: [${r.pair}] ${r.buy} -> ${r.sell}` +
        ` | output $${r.grossOutputUsd.toFixed(4)}` +
        ` | gas $${r.gasCostUsd.toFixed(4)}` +
        ` | net $${r.netProfitUsd.toFixed(4)}` +
        ` | gross ${r.grossBps} bps`,
    );
  }

  const notionOpps: NotionOpportunity[] = profitable.map((r) => ({
    pair: r.pair,
    buy: r.buy,
    sell: r.sell,
    netProfitUsd: r.netProfitUsd,
    grossOutputUsd: r.grossOutputUsd,
    gasCostUsd: r.gasCostUsd,
    grossBps: r.grossBps,
    tradeSizeUsd: r.tradeSizeUsd,
  }));
  await Promise.all(notionOpps.map((o) => logToNotion(o, "Sui", scanCount)));
}

async function updateSuiPrice(): Promise<void> {
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd");
    const data = await res.json() as { sui: { usd: number } };
    suiPriceUsd = data.sui.usd;
  } catch {
    if (suiPriceUsd === 0) suiPriceUsd = 0.65;
  }
}

async function main(): Promise<void> {
  console.log("Initializing Aftermath Router...");
  await initRouter();
  await updateSuiPrice();
  console.log(
    `Monitoring ${config.protocols.length} protocols x ${config.pairs.length} pairs on Sui` +
      ` | SUI price: $${suiPriceUsd.toFixed(2)}` +
      ` | trade size: $${config.tradeSizeUsdc}` +
      ` | min profit: $${config.minimumProfitUsd}`,
  );

  if (config.once) {
    await scan();
    return;
  }

  let priceUpdateCounter = 0;
  const loop = async () => {
    while (true) {
      try {
        await scan();
        priceUpdateCounter++;
        if (priceUpdateCounter % 100 === 0) await updateSuiPrice();
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      await new Promise((r) => setTimeout(r, config.pollIntervalMs));
    }
  };

  process.on("SIGINT", () => {
    console.log("\nSui monitor stopped.");
    process.exit(0);
  });

  await loop();
}

main().catch(console.error);
