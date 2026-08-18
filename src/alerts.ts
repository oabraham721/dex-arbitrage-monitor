import twilio from "twilio";
import { config } from "./config.js";

export type AlertOpportunity = {
  buy: string;
  sell: string;
  netProfit: bigint;
  grossOutput: bigint;
};

const lastSentAt = new Map<string, number>();
const client = config.sms ? twilio(config.sms.accountSid, config.sms.authToken) : null;

function dollars(value: bigint): string {
  return (Number(value) / 1_000_000).toFixed(4);
}

export async function sendOpportunityAlert(
  opportunity: AlertOpportunity,
  blockNumber: bigint,
): Promise<void> {
  if (!client || !config.sms) return;

  const routeKey = `${opportunity.buy}->${opportunity.sell}`;
  const now = Date.now();
  if (now - (lastSentAt.get(routeKey) ?? 0) < config.alertCooldownMs) return;

  const flashSize = 1_000_000n * 1_000_000n;
  const flashProfit = (opportunity.netProfit * flashSize) / config.tradeSize;

  try {
    await client.messages.create({
      from: config.sms.from,
      to: config.sms.to,
      body:
        `Base arbitrage opportunity\n${opportunity.buy} -> ${opportunity.sell}` +
        `\nEstimated net: $${dollars(opportunity.netProfit)}` +
        `\nFinal output: $${dollars(opportunity.grossOutput)}` +
        `\nBlock: ${blockNumber}` +
        `\n\n$${dollars(config.tradeSize)} trade → $${dollars(opportunity.netProfit)} profit` +
        `\n$1,000,000 flash → $${dollars(flashProfit)} profit`,
    });
    lastSentAt.set(routeKey, now);
    console.log(`  SMS alert sent for ${routeKey}.`);
  } catch (error) {
    console.error(`  SMS alert failed: ${error instanceof Error ? error.message : error}`);
  }
}