import { Client } from "@notionhq/client";

const notion = process.env.NOTION_DATABASE_ID
  ? new Client({ auth: process.env.NOTION_API_KEY })
  : null;

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
  await initSeq();

  seqGlobal++;
  const title = `Opportunity #${seqGlobal}`;
  const peakProfit = opportunity.tradeSizeUsd > 0
    ? (opportunity.netProfitUsd / opportunity.tradeSizeUsd) * 1_000_000
    : 0;

  try {
    await notion.pages.create({
      parent: { database_id: databaseId },
      properties: {
        Route: { title: [{ text: { content: title } }] },
        Oppurtunity: { number: seqGlobal },
        "Flash Profit ($)": { number: usd(peakProfit) },
        "Gross (bps)": { number: opportunity.grossBps },
        "Trade Size ($)": { number: usd(opportunity.tradeSizeUsd) },
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
