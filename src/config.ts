import "dotenv/config";
import { getAddress, parseUnits, type Address } from "viem";

export type Route = {
  name: string;
  quoter: Address;
  fee: number;
};

type RawRoute = {
  name: unknown;
  quoter: unknown;
  fee: unknown;
};

const DEFAULT_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";

const defaultRoutes: Route[] = [
  { name: "Uniswap V3 0.05%", quoter: DEFAULT_QUOTER, fee: 500 },
  { name: "Uniswap V3 0.30%", quoter: DEFAULT_QUOTER, fee: 3000 },
];

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return value;
}

function booleanFromEnv(name: string): boolean {
  return process.env[name]?.toLowerCase() === "true";
}

function parseSmsConfig() {
  const values = {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    from: process.env.TWILIO_FROM_NUMBER,
    to: process.env.ALERT_TO_NUMBER,
  };
  const configured = Object.values(values).filter(Boolean).length;
  if (configured === 0) return null;
  if (configured !== Object.keys(values).length) {
    throw new Error("SMS alerts require all TWILIO_* and ALERT_TO_NUMBER settings");
  }
  return values as { accountSid: string; authToken: string; from: string; to: string };
}

function parseRoutes(): Route[] {
  if (!process.env.ROUTES_JSON) return defaultRoutes;

  const parsed: unknown = JSON.parse(process.env.ROUTES_JSON);
  if (!Array.isArray(parsed) || parsed.length < 2) {
    throw new Error("ROUTES_JSON must contain at least two routes");
  }

  return parsed.map((candidate: RawRoute, index) => {
    const fee = Number(candidate.fee);
    if (typeof candidate.name !== "string" || typeof candidate.quoter !== "string") {
      throw new Error(`ROUTES_JSON route ${index} has an invalid name or quoter`);
    }
    if (!Number.isInteger(fee) || fee <= 0 || fee >= 1_000_000) {
      throw new Error(`ROUTES_JSON route ${index} has an invalid fee`);
    }
    return { name: candidate.name, quoter: getAddress(candidate.quoter), fee };
  });
}

export const config = {
  rpcUrl: process.env.RPC_URL ?? "https://mainnet.base.org",
  tradeSize: parseUnits(process.env.TRADE_SIZE_USDC ?? "100", 6),
  minimumProfit: parseUnits(process.env.MIN_NET_PROFIT_USDC ?? "0.25", 6),
  executionCostBuffer: parseUnits(process.env.EXECUTION_COST_BUFFER_USDC ?? "0.02", 6),
  pollIntervalMs: numberFromEnv("POLL_INTERVAL_MS", 12_000),
  gasOverhead: BigInt(Math.floor(numberFromEnv("GAS_OVERHEAD", 100_000))),
  showAll: booleanFromEnv("SHOW_ALL"),
  once: booleanFromEnv("ONCE"),
  sms: parseSmsConfig(),
  alertCooldownMs: numberFromEnv("ALERT_COOLDOWN_MINUTES", 15) * 60_000,
  notionDatabaseId: process.env.NOTION_DATABASE_ID ?? null,
  routes: parseRoutes(),
  weth: getAddress("0x4200000000000000000000000000000000000006"),
  usdc: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
};