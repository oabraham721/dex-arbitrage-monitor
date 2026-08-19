import { Client } from "@notionhq/client";
import { config } from "./config.js";
import { formatUnits } from "viem";

const notion = config.notionDatabaseId
  ? new Client({ auth: process.env.NOTION_API_KEY })
  : null;

let seqGlobal = 0;

function dollars(value: bigint): number {
  return Number(formatUnits(value, 6));
}

export type NotionOpportunity = {
  pair: string;
  buy: string;
  sell: string;
  netProfit: bigint;
  grossOutput: bigint;
  gasCost: bigint;
  grossBps: bigint;
};

export async function logToNotion(
  opportunity: NotionOpportunity,
  blockNumber: bigint,
  flashProfit: bigint | null = null,
  optimalSize: bigint | null = null,
): Promise<void> {
  if (!notion || !config.notionDatabaseId) return;

  seqGlobal++;
  const title = `Opportunity #${seqGlobal}`;
  const peakProfit = flashProfit ?? (opportunity.netProfit * 1_000_000_000_000n) / config.tradeSize;

  try {
    await notion.pages.create({
      parent: { database_id: config.notionDatabaseId },
      properties: {
        Route: { title: [{ text: { content: title } }] },
        Oppurtunity: { number: seqGlobal },
        "Flash Profit ($)": { number: dollars(peakProfit) },
        "Gross (bps)": { number: Number(opportunity.grossBps) },
        "Trade Size ($)": { number: dollars(optimalSize ? optimalSize : config.tradeSize) },
        "Output ($)": { number: dollars(opportunity.grossOutput) },
        "Gas Cost ($)": { number: dollars(opportunity.gasCost) },
        Block: { number: Number(blockNumber) },
        Timestamp: { date: { start: new Date().toISOString() } },
        Status: { select: { name: "detected" } },
        Chain: { select: { name: "Base" } },
        Pair: { select: { name: opportunity.pair } },
      },
    });
    console.log(`  Logged to Notion: ${opportunity.buy} → ${opportunity.sell}`);
  } catch (error) {
    console.error(`  Notion log failed: ${error instanceof Error ? error.message : error}`);
  }
}
