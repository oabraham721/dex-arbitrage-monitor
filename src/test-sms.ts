import "dotenv/config";
import twilio from "twilio";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

await client.messages.create({
  from: process.env.TWILIO_FROM_NUMBER!,
  to: process.env.ALERT_TO_NUMBER!,
  body:
    `Base arbitrage opportunity\n` +
    `Uniswap V3 0.05% -> Uniswap V3 0.30%\n` +
    `Estimated net: $0.3700\n` +
    `Final output: $100.3700\n` +
    `Block: 50115942\n\n` +
    `$100 trade → $0.37 profit\n` +
    `$1,000,000 flash → $3,700.00 profit`,
});

console.log("Test SMS sent.");
