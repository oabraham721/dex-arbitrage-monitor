import { Client } from "@notionhq/client";
import "dotenv/config";

const notion = new Client({ auth: process.env.NOTION_API_KEY });

const res = await notion.databases.query({
  database_id: process.env.NOTION_DATABASE_ID!,
  filter: { or: [
    { property: "Opportunity", number: { equals: 7 } },
    { property: "Opportunity", number: { equals: 8 } },
  ]},
});

for (const page of res.results) {
  const p = (page as any).properties;
  console.log("---");
  console.log("Title:", p.Route?.title?.[0]?.text?.content);
  console.log("Opportunity:", p.Opportunity?.number);
  console.log("Net Profit ($):", p["Net Profit ($)"]?.number);
  console.log("Flash Profit ($):", p["Flash Profit ($)"]?.number);
  console.log("Trade Size ($):", p["Trade Size ($)"]?.number);
  console.log("Gross (bps):", p["Gross (bps)"]?.number);
  console.log("Pair:", p.Pair?.select?.name);
  console.log("Chain:", p.Chain?.select?.name);
}
