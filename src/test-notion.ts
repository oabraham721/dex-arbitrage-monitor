import "dotenv/config";
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

await notion.pages.create({
  parent: { database_id: process.env.NOTION_DATABASE_ID! },
  properties: {
    Route: { title: [{ text: { content: "Uniswap V3 0.05% → Uniswap V3 0.30%" } }] },
    "Net Profit ($)": { number: 0.37 },
    "Gross (bps)": { number: 37 },
    "Trade Size ($)": { number: 100 },
    "Flash Profit ($)": { number: 3700 },
    "Output ($)": { number: 100.37 },
    "Gas Cost ($)": { number: 0.003 },
    Block: { number: 50115942 },
    Timestamp: { date: { start: new Date().toISOString() } },
    Status: { select: { name: "detected" } },
    Chain: { select: { name: "Base" } },
    Pair: { select: { name: "WETH/USDC" } },
  },
});

console.log("Test entry created in Notion.");
