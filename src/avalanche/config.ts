import "dotenv/config";
import { getAddress, parseUnits, type Address } from "viem";

export type QuoterType = "uniV3" | "joeLB";

export type Route = {
  name: string;
  quoter: Address;
  quoterType: QuoterType;
  param: number; // fee tier
};

export type Pair = {
  name: string;
  tokenA: Address;
  tokenB: Address;
  decimalsA: number;
};

const UNISWAP_QUOTER = "0xbe0F5544EC67e9B3b2D979aaA43f18Fd87E6257F";
const SUSHI_QUOTER = "0xb1E835Dc2785b52265711e17fCCb0fd018226a6e";
const PANGOLIN_QUOTER = "0xA86522CCc412dBC4FA10991900FE46De95983822";
const JOE_LB_QUOTER = "0x64b57F4249aA99a812212cee7DAEFEDC40B203cD";

const defaultRoutes: Route[] = [
  { name: "Uniswap 0.01%", quoter: UNISWAP_QUOTER, quoterType: "uniV3", param: 100 },
  { name: "Uniswap 0.05%", quoter: UNISWAP_QUOTER, quoterType: "uniV3", param: 500 },
  { name: "Uniswap 0.3%", quoter: UNISWAP_QUOTER, quoterType: "uniV3", param: 3000 },
  { name: "Uniswap 1%", quoter: UNISWAP_QUOTER, quoterType: "uniV3", param: 10000 },
  { name: "SushiSwap 0.05%", quoter: SUSHI_QUOTER, quoterType: "uniV3", param: 500 },
  { name: "SushiSwap 0.3%", quoter: SUSHI_QUOTER, quoterType: "uniV3", param: 3000 },
  { name: "SushiSwap 1%", quoter: SUSHI_QUOTER, quoterType: "uniV3", param: 10000 },
  { name: "Pangolin 0.01%", quoter: PANGOLIN_QUOTER, quoterType: "uniV3", param: 100 },
  { name: "Pangolin 0.05%", quoter: PANGOLIN_QUOTER, quoterType: "uniV3", param: 500 },
  { name: "Pangolin 0.3%", quoter: PANGOLIN_QUOTER, quoterType: "uniV3", param: 3000 },
  { name: "Trader Joe", quoter: JOE_LB_QUOTER, quoterType: "joeLB", param: 0 },
];

// Tokens
const WAVAX = getAddress("0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7");
const USDC = getAddress("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E");
const USDCe = getAddress("0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664");
const USDt = getAddress("0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7");
const WETHe = getAddress("0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB");
const WBTCe = getAddress("0x50b7545627a5162F82A992c33b87aDc75187B218");
const sAVAX = getAddress("0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE");
const JOE = getAddress("0x6e84a6216eA6dACC71eE8E6b0a5B7322EEbC0fDd");

const defaultPairs: Pair[] = [
  { name: "WAVAX/USDC", tokenA: USDC, tokenB: WAVAX, decimalsA: 6 },
  { name: "WETH.e/USDC", tokenA: USDC, tokenB: WETHe, decimalsA: 6 },
  { name: "WBTC.e/USDC", tokenA: USDC, tokenB: WBTCe, decimalsA: 6 },
  { name: "USDt/USDC", tokenA: USDC, tokenB: USDt, decimalsA: 6 },
  { name: "USDC.e/USDC", tokenA: USDC, tokenB: USDCe, decimalsA: 6 },
  { name: "sAVAX/WAVAX", tokenA: WAVAX, tokenB: sAVAX, decimalsA: 18 },
  { name: "WETH.e/WAVAX", tokenA: WAVAX, tokenB: WETHe, decimalsA: 18 },
  { name: "WBTC.e/WAVAX", tokenA: WAVAX, tokenB: WBTCe, decimalsA: 18 },
  { name: "JOE/WAVAX", tokenA: WAVAX, tokenB: JOE, decimalsA: 18 },
  { name: "JOE/USDC", tokenA: USDC, tokenB: JOE, decimalsA: 6 },
];

export const config = {
  rpcUrl: process.env.AVAX_RPC_URL ?? "https://api.avax.network/ext/bc/C/rpc",
  tradeSize: parseUnits(process.env.AVAX_TRADE_SIZE_USDC ?? "1000", 6),
  tradeSizeWavax: parseUnits(process.env.AVAX_TRADE_SIZE_WAVAX ?? "50", 18),
  minimumProfit: parseUnits(process.env.AVAX_MIN_NET_PROFIT_USDC ?? "0.01", 6),
  executionCostBuffer: parseUnits(process.env.AVAX_EXECUTION_COST_BUFFER ?? "0.05", 6),
  pollIntervalMs: 2_000,
  gasOverhead: 150_000n,
  routes: defaultRoutes,
  pairs: defaultPairs,
};
