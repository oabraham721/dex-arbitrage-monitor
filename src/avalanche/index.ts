import {
  createPublicClient,
  encodeFunctionData,
  decodeFunctionResult,
  formatUnits,
  http,
  type Address,
  type PublicClient,
  type Transport,
  type Chain,
} from "viem";
import { avalanche } from "viem/chains";
import { config, type Pair, type Route } from "./config.js";
import { logToNotion } from "./notion.js";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const multicall3Abi = [
  {
    type: "function",
    name: "tryAggregate",
    stateMutability: "payable",
    inputs: [
      { name: "requireSuccess", type: "bool" },
      { name: "calls", type: "tuple[]", components: [{ name: "target", type: "address" }, { name: "callData", type: "bytes" }] },
    ],
    outputs: [{ name: "returnData", type: "tuple[]", components: [{ name: "success", type: "bool" }, { name: "returnData", type: "bytes" }] }],
  },
  { type: "function", name: "getBlockNumber", stateMutability: "view", inputs: [], outputs: [{ name: "blockNumber", type: "uint256" }] },
  { type: "function", name: "getBasefee", stateMutability: "view", inputs: [], outputs: [{ name: "basefee", type: "uint256" }] },
] as const;

const uniV3Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [{
      name: "params", type: "tuple",
      components: [
        { name: "tokenIn", type: "address" },
        { name: "tokenOut", type: "address" },
        { name: "amountIn", type: "uint256" },
        { name: "fee", type: "uint24" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const joeLBAbi = [
  {
    type: "function",
    name: "findBestPathFromAmountIn",
    stateMutability: "view",
    inputs: [
      { name: "route", type: "address[]" },
      { name: "amountIn", type: "uint128" },
    ],
    outputs: [{
      name: "quote", type: "tuple",
      components: [
        { name: "route", type: "address[]" },
        { name: "pairs", type: "address[]" },
        { name: "binSteps", type: "uint256[]" },
        { name: "versions", type: "uint8[]" },
        { name: "amounts", type: "uint128[]" },
        { name: "virtualAmountsWithoutSlippage", type: "uint128[]" },
        { name: "fees", type: "uint128[]" },
      ],
    }],
  },
] as const;

type Quote = { amountOut: bigint; gasEstimate: bigint };
type QuoteRequest = { quoter: Address; quoterType: string; tokenIn: Address; tokenOut: Address; amountIn: bigint; param: number };

type Opportunity = {
  pair: string;
  buy: string;
  sell: string;
  buyRoute: Route;
  sellRoute: Route;
  pairRef: Pair;
  netProfit: bigint;
  grossOutput: bigint;
  gasCost: bigint;
  grossBps: bigint;
};

const client = createPublicClient({
  chain: avalanche,
  cacheTime: 0,
  transport: http(config.rpcUrl, { retryCount: 2, timeout: 15_000 }),
});

// Dead pool tracking
const failCounts = new Map<string, number>();
const DEAD_THRESHOLD = 3;

function poolKey(pair: Pair, route: Route): string { return `${pair.name}:${route.name}`; }
function isDead(pair: Pair, route: Route): boolean { return (failCounts.get(poolKey(pair, route)) ?? 0) >= DEAD_THRESHOLD; }
function recordResult(pair: Pair, route: Route, success: boolean): void {
  const key = poolKey(pair, route);
  if (success) { failCounts.delete(key); }
  else { failCounts.set(key, (failCounts.get(key) ?? 0) + 1); }
}

function usdc(value: bigint): string { return `$${Number(formatUnits(value, 6)).toFixed(4)}`; }

// Cached buy outputs for single-multicall sell estimation
const lastBuyOutputs = new Map<string, bigint>();
function buyOutputKey(pair: Pair, route: Route): string { return `${pair.name}:${route.name}`; }

const MAX_CALLS_PER_BATCH = 50;

async function callMulticall(calls: { target: Address; callData: `0x${string}` }[]): Promise<{ success: boolean; returnData: `0x${string}` }[]> {
  const results: { success: boolean; returnData: `0x${string}` }[] = [];
  for (let i = 0; i < calls.length; i += MAX_CALLS_PER_BATCH) {
    const chunk = calls.slice(i, i + MAX_CALLS_PER_BATCH);
    const data = encodeFunctionData({ abi: multicall3Abi, functionName: "tryAggregate", args: [false, chunk] });
    const response = await client.call({ to: MULTICALL3, data, gas: 500_000_000n });
    if (!response.data) throw new Error("Multicall returned no data");
    const decoded = decodeFunctionResult({ abi: multicall3Abi, functionName: "tryAggregate", data: response.data }) as any;
    results.push(...decoded);
  }
  return results;
}

function encodeQuote(req: QuoteRequest): { target: Address; callData: `0x${string}` } {
  if (req.quoterType === "joeLB") {
    const callData = encodeFunctionData({
      abi: joeLBAbi,
      functionName: "findBestPathFromAmountIn",
      args: [[req.tokenIn, req.tokenOut], req.amountIn],
    });
    return { target: req.quoter, callData };
  }
  const callData = encodeFunctionData({
    abi: uniV3Abi,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountIn: req.amountIn, fee: req.param, sqrtPriceLimitX96: 0n }],
  });
  return { target: req.quoter, callData };
}

function decodeQuote(data: `0x${string}`, quoterType: string): Quote {
  if (quoterType === "joeLB") {
    const decoded = decodeFunctionResult({ abi: joeLBAbi, functionName: "findBestPathFromAmountIn", data }) as any;
    const amounts: bigint[] = decoded.amounts;
    const amountOut = amounts[amounts.length - 1]!;
    return { amountOut, gasEstimate: 200_000n };
  }
  const [amountOut, , , gasEstimate] = decodeFunctionResult({ abi: uniV3Abi, functionName: "quoteExactInputSingle", data });
  return { amountOut, gasEstimate };
}

async function scan(): Promise<void> {
  const buyRequests: QuoteRequest[] = [];
  const buyIndex: { pair: Pair; route: Route }[] = [];
  const sellRequests: QuoteRequest[] = [];
  const sellIndex: { pair: Pair; buyRoute: Route; sellRoute: Route; cachedBuyOutput: bigint }[] = [];

  for (const pair of config.pairs) {
    const amountIn = pair.decimalsA === 18 ? config.tradeSizeWavax : config.tradeSize;
    for (const route of config.routes) {
      if (isDead(pair, route)) continue;
      buyRequests.push({ quoter: route.quoter as Address, quoterType: route.quoterType, tokenIn: pair.tokenA, tokenOut: pair.tokenB, amountIn, param: route.param });
      buyIndex.push({ pair, route });

      const cachedOutput = lastBuyOutputs.get(buyOutputKey(pair, route));
      if (cachedOutput && cachedOutput > 0n) {
        for (const sellRoute of config.routes) {
          if (sellRoute === route) continue;
          if (isDead(pair, sellRoute)) continue;
          sellRequests.push({ quoter: sellRoute.quoter as Address, quoterType: sellRoute.quoterType, tokenIn: pair.tokenB, tokenOut: pair.tokenA, amountIn: cachedOutput, param: sellRoute.param });
          sellIndex.push({ pair, buyRoute: route, sellRoute, cachedBuyOutput: cachedOutput });
        }
      }
    }
  }

  // Single RPC: meta + all quotes
  const metaCalls: { target: Address; callData: `0x${string}` }[] = [
    { target: MULTICALL3, callData: encodeFunctionData({ abi: multicall3Abi, functionName: "getBlockNumber", args: [] }) },
    { target: MULTICALL3, callData: encodeFunctionData({ abi: multicall3Abi, functionName: "getBasefee", args: [] }) },
  ];
  const allCalls = [...metaCalls, ...buyRequests.map(encodeQuote), ...sellRequests.map(encodeQuote)];
  const allResults = await callMulticall(allCalls);

  const blockNumber = BigInt(allResults[0]!.returnData);
  if (blockNumber === lastBlock) return; // same block, skip processing
  lastBlock = blockNumber;
  const basefee = BigInt(allResults[1]!.returnData);
  const buyResults = allResults.slice(metaCalls.length, metaCalls.length + buyRequests.length);
  const sellResults = allResults.slice(metaCalls.length + buyRequests.length);

  // Update caches
  for (let i = 0; i < buyResults.length; i++) {
    const { pair, route } = buyIndex[i]!;
    const success = buyResults[i]!.success && buyResults[i]!.returnData !== "0x";
    recordResult(pair, route, success);
    if (success) {
      try {
        const q = decodeQuote(buyResults[i]!.returnData, buyRequests[i]!.quoterType);
        lastBuyOutputs.set(buyOutputKey(pair, route), q.amountOut);
      } catch { lastBuyOutputs.delete(buyOutputKey(pair, route)); }
    }
  }
  for (let i = 0; i < sellResults.length; i++) {
    const { pair, sellRoute } = sellIndex[i]!;
    recordResult(pair, sellRoute, sellResults[i]!.success && sellResults[i]!.returnData !== "0x");
  }

  // Find opportunities
  const profitable: Opportunity[] = [];
  let bestSpreadBps = -999999n;
  let bestSpreadLabel = "";

  for (let i = 0; i < sellResults.length; i++) {
    if (!sellResults[i]!.success || sellResults[i]!.returnData === "0x") continue;
    const { pair, buyRoute, sellRoute, cachedBuyOutput } = sellIndex[i]!;
    let sellOutput: bigint;
    try { sellOutput = decodeQuote(sellResults[i]!.returnData, sellRequests[i]!.quoterType).amountOut; } catch { continue; }

    const amountIn = pair.decimalsA === 18 ? config.tradeSizeWavax : config.tradeSize;
    const spreadBps = (sellOutput - amountIn) * 10000n / amountIn;
    if (spreadBps > bestSpreadBps) {
      bestSpreadBps = spreadBps;
      bestSpreadLabel = `[${pair.name}] ${buyRoute.name} -> ${sellRoute.name} (${spreadBps} bps)`;
    }

    if (sellOutput <= amountIn) continue;

    const grossProfit = sellOutput - amountIn;
    const gasCost = basefee * config.gasOverhead / 10n ** 12n; // Convert to USDC (AVAX ~$25, rough)
    const netProfit = grossProfit - gasCost - config.executionCostBuffer;
    const grossBps = grossProfit * 10000n / amountIn;

    if (netProfit > 0n) {
      profitable.push({
        pair: pair.name,
        buy: buyRoute.name,
        sell: sellRoute.name,
        buyRoute,
        sellRoute,
        pairRef: pair,
        netProfit,
        grossOutput: sellOutput,
        gasCost,
        grossBps,
      });
    }
  }

  // Print
  const dead = failCounts.size > 0 ? ` | ${failCounts.size} dead pools cached` : "";
  const routeCount = sellIndex.length;
  console.log(`\n[${new Date().toISOString()}] Avalanche block ${blockNumber} | ${routeCount} routes | ${allCalls.length} quotes in 1 RPC${dead}`);

  if (bestSpreadLabel) console.log(`  Best spread: ${bestSpreadLabel}`);
  if (profitable.length === 0) {
    console.log("  No net-profitable route at the configured threshold.");
  } else {
    profitable.sort((a, b) => Number(b.netProfit - a.netProfit));
    for (const opp of profitable.slice(0, 10)) {
      console.log(
        `  OPPORTUNITY: [${opp.pair}] ${opp.buy} -> ${opp.sell}` +
        ` | output ${usdc(opp.grossOutput)} | gas ${usdc(opp.gasCost)}` +
        ` | buffer ${usdc(config.executionCostBuffer)} | net ${usdc(opp.netProfit)} | gross ${opp.grossBps} bps`,
      );
      await logToNotion(opp, blockNumber);
    }
    if (profitable.length > 10) console.log(`  ... and ${profitable.length - 10} more`);
  }
}

// Main loop
let lastBlock = 0n;

async function main(): Promise<void> {
  console.log("Avalanche Arbitrage Monitor");
  console.log(`  Pairs: ${config.pairs.map(p => p.name).join(", ")}`);
  console.log(`  Routes: ${config.routes.map(r => r.name).join(", ")}`);
  console.log(`  Trade size: ${usdc(config.tradeSize)} USDC / ${formatUnits(config.tradeSizeWavax, 18)} WAVAX`);
  console.log(`  Min profit: ${usdc(config.minimumProfit)} | Buffer: ${usdc(config.executionCostBuffer)}`);
  console.log("");

  while (true) {
    try {
      await scan();
    } catch (error) {
      console.error(`Scan error: ${error instanceof Error ? error.message : error}`);
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
  }
}

main().catch(console.error);
