import { Client } from "@notionhq/client";
import { formatUnits } from "viem";
import { config } from "./config.js";

const dbId = process.env.NOTION_DATABASE_ID ?? null;
const notion = dbId ? new Client({ auth: process.env.NOTION_API_KEY }) : null;

let seqGlobal = 0;
let seqInitialized = false;

async function initSeq(): Promise<void> {
  if (seqInitialized || !notion) return;
  seqInitialized = true;
  try {
    const res = await notion.search({ filter: { property: "object", value: "page" }, query: "Opportunity" });
    for (const page of res.results as any[]) {
      const n = page.properties?.Oppurtunity?.number ?? 0;
      if (n > seqGlobal) seqGlobal = n;
    }
  } catch {}
}

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
): Promise<void> {
  if (!notion || !dbId) return;
  await initSeq();

  seqGlobal++;
  const title = `Opportunity #${seqGlobal}`;

  try {
    await notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        Route: { title: [{ text: { content: title } }] },
        Oppurtunity: { number: seqGlobal },
        "Flash Profit ($)": { number: dollars(opportunity.netProfit) },
        "Gross (bps)": { number: Number(opportunity.grossBps) },
        "Trade Size ($)": { number: dollars(config.tradeSize) },
        "Output ($)": { number: dollars(opportunity.grossOutput) },
        "Gas Cost ($)": { number: dollars(opportunity.gasCost) },
        Block: { number: Number(blockNumber) },
        Timestamp: { date: { start: new Date().toISOString() } },
        Status: { select: { name: "detected" } },
        Chain: { select: { name: "Avalanche" } },
        Pair: { select: { name: opportunity.pair } },
      },
    });
    console.log(`  Logged to Notion: ${opportunity.buy} → ${opportunity.sell}`);
  } catch (error) {
    console.error(`  Notion log failed: ${error instanceof Error ? error.message : error}`);
  }
}
