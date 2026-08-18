import "dotenv/config";
import { getAddress, parseUnits, type Address } from "viem";

export type QuoterType = "uniV3" | "aerodrome" | "balancer";

export type Route = {
  name: string;
  quoter: Address;
  quoterType: QuoterType;
  param: number; // fee (uniV3) or tickSpacing (aerodrome) or unused (balancer)
  pool?: Address; // required for balancer
};

export type Pair = {
  name: string;
  tokenA: Address;
  tokenB: Address;
  decimalsA: number;
};

const UNISWAP_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const PANCAKE_QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const SUSHI_QUOTER = "0xb1E835Dc2785b52265711e17fCCb0fd018226a6e";
const AERO_QUOTER = "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0";
const BAL_ROUTER = "0x3f170631ed9821Ca51A59D996aB095162438DC10";

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
  { name: "Balancer 0.05%", quoter: BAL_ROUTER, quoterType: "balancer", param: 0, pool: "0x3f31e580Eb590DaB16a10A0808D33bCbc5d3D608" },
];

const WETH = getAddress("0x4200000000000000000000000000000000000006");
const USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const CBBTC = getAddress("0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf");
const USDT = getAddress("0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2");
const WSTETH = getAddress("0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452");
const CBETH = getAddress("0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DeC22");
const AERO = getAddress("0x940181a94A35A4569E4529A3CDFb74e38FD98631");
const DAI = getAddress("0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb");

const defaultPairs: Pair[] = [
  { name: "WETH/USDC", tokenA: USDC, tokenB: WETH, decimalsA: 6 },
  { name: "cbBTC/USDC", tokenA: USDC, tokenB: CBBTC, decimalsA: 6 },
  { name: "USDT/USDC", tokenA: USDC, tokenB: USDT, decimalsA: 6 },
  { name: "wstETH/USDC", tokenA: USDC, tokenB: WSTETH, decimalsA: 6 },
  { name: "cbETH/USDC", tokenA: USDC, tokenB: CBETH, decimalsA: 6 },
  { name: "AERO/USDC", tokenA: USDC, tokenB: AERO, decimalsA: 6 },
  { name: "DAI/USDC", tokenA: USDC, tokenB: DAI, decimalsA: 6 },
  { name: "wstETH/WETH", tokenA: WETH, tokenB: WSTETH, decimalsA: 18 },
  { name: "cbETH/WETH", tokenA: WETH, tokenB: CBETH, decimalsA: 18 },
  { name: "cbBTC/WETH", tokenA: WETH, tokenB: CBBTC, decimalsA: 18 },
  { name: "AERO/WETH", tokenA: WETH, tokenB: AERO, decimalsA: 18 },
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
  tradeSizeWeth: parseUnits(process.env.TRADE_SIZE_WETH ?? "0.03", 18),
  minimumProfit: parseUnits(process.env.MIN_NET_PROFIT_USDC ?? "0.25", 6),
  executionCostBuffer: parseUnits(process.env.EXECUTION_COST_BUFFER_USDC ?? "0.02", 6),
  pollIntervalMs: numberFromEnv("POLL_INTERVAL_MS", 2_000),
  gasOverhead: BigInt(Math.floor(numberFromEnv("GAS_OVERHEAD", 100_000))),
  showAll: booleanFromEnv("SHOW_ALL"),
  once: booleanFromEnv("ONCE"),
  notionDatabaseId: process.env.NOTION_DATABASE_ID ?? null,
  routes: defaultRoutes,
  pairs: defaultPairs,
};