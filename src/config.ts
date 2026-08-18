import "dotenv/config";
import { getAddress, parseUnits, type Address } from "viem";

export type QuoterType = "uniV3" | "aerodrome";

export type Route = {
  name: string;
  quoter: Address;
  quoterType: QuoterType;
  param: number; // fee (uniV3) or tickSpacing (aerodrome)
};

export type Pair = {
  name: string;
  tokenA: Address;
  tokenB: Address;
};

const UNISWAP_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const PANCAKE_QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const SUSHI_QUOTER = "0xb1E835Dc2785b52265711e17fCCb0fd018226a6e";
const AERO_QUOTER = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0";

const defaultRoutes: Route[] = [
  { name: "Uniswap 0.05%", quoter: UNISWAP_QUOTER, quoterType: "uniV3", param: 500 },
  { name: "Uniswap 0.3%", quoter: UNISWAP_QUOTER, quoterType: "uniV3", param: 3000 },
  { name: "PancakeSwap 0.01%", quoter: PANCAKE_QUOTER, quoterType: "uniV3", param: 100 },
  { name: "PancakeSwap 0.05%", quoter: PANCAKE_QUOTER, quoterType: "uniV3", param: 500 },
  { name: "PancakeSwap 0.25%", quoter: PANCAKE_QUOTER, quoterType: "uniV3", param: 2500 },
  { name: "SushiSwap 0.05%", quoter: SUSHI_QUOTER, quoterType: "uniV3", param: 500 },
  { name: "SushiSwap 0.3%", quoter: SUSHI_QUOTER, quoterType: "uniV3", param: 3000 },
  { name: "Aerodrome tick=1", quoter: AERO_QUOTER, quoterType: "aerodrome", param: 1 },
  { name: "Aerodrome tick=100", quoter: AERO_QUOTER, quoterType: "aerodrome", param: 100 },
];

const WETH = getAddress("0x4200000000000000000000000000000000000006");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const CBBTC = getAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf");
const DAI = getAddress("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb");

const defaultPairs: Pair[] = [
  { name: "WETH/USDC", tokenA: USDC, tokenB: WETH },
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

export const config = {
  rpcUrl: process.env.RPC_URL ?? "https://mainnet.base.org",
  tradeSize: parseUnits(process.env.TRADE_SIZE_USDC ?? "100", 6),
  minimumProfit: parseUnits(process.env.MIN_NET_PROFIT_USDC ?? "0.25", 6),
  executionCostBuffer: parseUnits(process.env.EXECUTION_COST_BUFFER_USDC ?? "0.02", 6),
  pollIntervalMs: numberFromEnv("POLL_INTERVAL_MS", 12_000),
  gasOverhead: BigInt(Math.floor(numberFromEnv("GAS_OVERHEAD", 100_000))),
  showAll: booleanFromEnv("SHOW_ALL"),
  once: booleanFromEnv("ONCE"),
  notionDatabaseId: process.env.NOTION_DATABASE_ID ?? null,
  routes: defaultRoutes,
  pairs: defaultPairs,
};