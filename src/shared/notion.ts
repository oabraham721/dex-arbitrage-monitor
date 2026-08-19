import { Client } from "@notionhq/client";

const notion = process.env.NOTION_DATABASE_ID
  ? new Client({ auth: process.env.NOTION_API_KEY })
  : null;

let seqGlobal = 0;

function usd(value: number): number {
  return Number(value.toFixed(6));
}

export type NotionOpportunity = {
  pair: string;
  buy: string;
  sell: string;
  netProfitUsd: number;
  grossOutputUsd: number;
  gasCostUsd: number;
  grossBps: number;
  tradeSizeUsd: number;
};

export async function logToNotion(
  opportunity: NotionOpportunity,
  chain: string,
  blockOrCheckpoint: number,
): Promise<void> {
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!notion || !databaseId) return;

  seqGlobal++;
  const title = `Opportunity #${seqGlobal}`;
  const flashProfit = opportunity.tradeSizeUsd > 0
    ? (opportunity.netProfitUsd / opportunity.tradeSizeUsd) * 1_000_000
    : 0;

  try {
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        Route: { title: [{ text: { content: title } }] },
        Opportunity: { number: seqGlobal },
        "Net Profit ($)": { number: usd(opportunity.netProfitUsd) },
        "Gross (bps)": { number: opportunity.grossBps },
        "Trade Size ($)": { number: usd(opportunity.tradeSizeUsd) },
        "Flash Profit ($)": { number: usd(flashProfit) },
        "Output ($)": { number: usd(opportunity.grossOutputUsd) },
        "Gas Cost ($)": { number: usd(opportunity.gasCostUsd) },
        Block: { number: blockOrCheckpoint },
        Timestamp: { date: { start: new Date().toISOString() } },
        Status: { select: { name: "detected" } },
        Chain: { select: { name: chain } },
        Pair: { select: { name: opportunity.pair } },
      },
    });
    console.log(`  Logged to Notion: ${opportunity.buy} → ${opportunity.sell}`);
  } catch (error) {
    console.error(`  Notion log failed: ${error instanceof Error ? error.message : error}`);
  }
}
