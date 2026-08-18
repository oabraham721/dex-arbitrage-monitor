import "dotenv/config";
import twilio from "twilio";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const messages = await client.messages.list({ limit: 5 });
for (const msg of messages) {
  console.log(`${msg.dateSent?.toISOString() ?? "pending"} | status: ${msg.status} | to: ${msg.to} | error: ${msg.errorCode ?? "none"} (${msg.errorMessage ?? ""})`);
}
