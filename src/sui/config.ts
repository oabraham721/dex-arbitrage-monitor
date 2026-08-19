import "dotenv/config";

export type Protocol =
  | "Aftermath"
  | "Cetus"
  | "DeepBookV3"
  | "Turbos"
  | "FlowX"
  | "FlowXClmm"
  | "Bluefin"
  | "Kriya"
  | "KriyaClmm";

export type Pair = {
  name: string;
  coinIn: string;
  coinOut: string;
  decimalsIn: number;
};

const SUI = "0x2::sui::SUI";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const WUSDC = "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN";
const USDT = "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN";
const WETH = "0xaf8cd5edc19c4512f4259f0bee101a40d41ebed738ade5874359610ef8eeced5::coin::COIN";
const AFSUI = "0xf325ce1300e8dac124071d3152c5c5ee6174914f8bc2161e88329cf579246efc::afsui::AFSUI";

const defaultProtocols: Protocol[] = [
  "Aftermath",
  "Cetus",
  "DeepBookV3",
  "Turbos",
  "FlowX",
  "FlowXClmm",
  "Bluefin",
  "Kriya",
  "KriyaClmm",
];

const defaultPairs: Pair[] = [
  { name: "SUI/USDC", coinIn: USDC, coinOut: SUI, decimalsIn: 6 },
  { name: "SUI/wUSDC", coinIn: WUSDC, coinOut: SUI, decimalsIn: 6 },
  { name: "WETH/USDC", coinIn: USDC, coinOut: WETH, decimalsIn: 6 },
  { name: "USDT/USDC", coinIn: USDC, coinOut: USDT, decimalsIn: 6 },
  { name: "afSUI/SUI", coinIn: SUI, coinOut: AFSUI, decimalsIn: 9 },
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
  tradeSizeUsdc: numberFromEnv("SUI_TRADE_SIZE_USDC", 100),
  tradeSizeSui: numberFromEnv("SUI_TRADE_SIZE_SUI", 150),
  minimumProfitUsd: numberFromEnv("SUI_MIN_NET_PROFIT_USD", 0.03),
  pollIntervalMs: numberFromEnv("SUI_POLL_INTERVAL_MS", 3000),
  showAll: booleanFromEnv("SUI_SHOW_ALL"),
  once: booleanFromEnv("ONCE"),
  protocols: defaultProtocols,
  pairs: defaultPairs,
};
