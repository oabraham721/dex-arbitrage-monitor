import {
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
  type PublicClient,
  type Transport,
} from "viem";
import { base } from "viem/chains";
import type { QuoterType } from "./config.js";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const multicall3Abi = [
  {
    type: "function",
    name: "tryAggregate",
    stateMutability: "payable",
    inputs: [
      { name: "requireSuccess", type: "bool" },
      {
        name: "calls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      {
        name: "returnData",
        type: "tuple[]",
        components: [
          { name: "success", type: "bool" },
          { name: "returnData", type: "bytes" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getBlockNumber",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "blockNumber", type: "uint256" }],
  },
  {
    type: "function",
    name: "getBasefee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "basefee", type: "uint256" }],
  },
] as const;

const uniV3Abi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const aerodromeAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "tickSpacing", type: "int24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const balancerRouterAbi = [
  {
    type: "function",
    name: "querySwapSingleTokenExactIn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "exactAmountIn", type: "uint256" },
      { name: "sender", type: "address" },
      { name: "userData", type: "bytes" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export type Quote = {
  amountOut: bigint;
  gasEstimate: bigint;
};

export type QuoteRequest = {
  quoter: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  param: number;
  quoterType: QuoterType;
  pool?: Address;
};

function encodeQuoteCall(req: QuoteRequest): { target: Address; callData: `0x${string}` } {
  if (req.quoterType === "balancer") {
    const callData = encodeFunctionData({
      abi: balancerRouterAbi,
      functionName: "querySwapSingleTokenExactIn",
      args: [req.pool!, req.tokenIn, req.tokenOut, req.amountIn, "0x0000000000000000000000000000000000000000", "0x"],
    });
    return { target: req.quoter, callData };
  }

  const abi = req.quoterType === "aerodrome" ? aerodromeAbi : uniV3Abi;
  const args = req.quoterType === "aerodrome"
    ? [{ tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountIn: req.amountIn, tickSpacing: req.param, sqrtPriceLimitX96: 0n }]
    : [{ tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountIn: req.amountIn, fee: req.param, sqrtPriceLimitX96: 0n }];

  const callData = encodeFunctionData({ abi, functionName: "quoteExactInputSingle", args: args as any });
  return { target: req.quoter, callData };
}

function decodeQuoteResult(data: `0x${string}`, quoterType: QuoterType): Quote {
  if (quoterType === "balancer") {
    const amountOut = decodeFunctionResult({
      abi: balancerRouterAbi,
      functionName: "querySwapSingleTokenExactIn",
      data,
    }) as unknown as bigint;
    return { amountOut, gasEstimate: 150_000n }; // Balancer doesn't return gas estimate; use conservative default
  }

  const abi = quoterType === "aerodrome" ? aerodromeAbi : uniV3Abi;
  const [amountOut, , , gasEstimate] = decodeFunctionResult({
    abi,
    functionName: "quoteExactInputSingle",
    data,
  });
  return { amountOut, gasEstimate };
}

const MAX_CALLS_PER_BATCH = 300;

async function callMulticall(
  client: PublicClient<Transport, typeof base>,
  calls: { target: Address; callData: `0x${string}` }[],
): Promise<{ success: boolean; returnData: `0x${string}` }[]> {
  const multicallData = encodeFunctionData({
    abi: multicall3Abi,
    functionName: "tryAggregate",
    args: [false, calls],
  });
  const response = await client.call({ to: MULTICALL3, data: multicallData });
  if (!response.data) throw new Error("Multicall returned no data");
  return decodeFunctionResult({
    abi: multicall3Abi,
    functionName: "tryAggregate",
    data: response.data,
  }) as unknown as { success: boolean; returnData: `0x${string}` }[];
}

export async function batchQuote(
  client: PublicClient<Transport, typeof base>,
  requests: QuoteRequest[],
): Promise<(Quote | null)[]> {
  if (requests.length === 0) return [];

  const calls = requests.map(encodeQuoteCall);
  const results: { success: boolean; returnData: `0x${string}` }[] = [];

  for (let i = 0; i < calls.length; i += MAX_CALLS_PER_BATCH) {
    const chunk = calls.slice(i, i + MAX_CALLS_PER_BATCH);
    const decoded = await callMulticall(client, chunk);
    results.push(...decoded);
  }

  return results.map((result, i) => {
    if (!result.success || result.returnData === "0x") return null;
    try {
      return decodeQuoteResult(result.returnData, requests[i]!.quoterType);
    } catch {
      return null;
    }
  });
}

export type BatchMetaResult = {
  blockNumber: bigint;
  basefee: bigint;
  quotes: (Quote | null)[];
};

/** Batches quote requests + blockNumber + basefee into a single RPC call (chunked if large). */
export async function batchQuoteWithMeta(
  client: PublicClient<Transport, typeof base>,
  requests: QuoteRequest[],
): Promise<BatchMetaResult> {
  const metaCalls: { target: Address; callData: `0x${string}` }[] = [
    { target: MULTICALL3, callData: encodeFunctionData({ abi: multicall3Abi, functionName: "getBlockNumber", args: [] }) },
    { target: MULTICALL3, callData: encodeFunctionData({ abi: multicall3Abi, functionName: "getBasefee", args: [] }) },
  ];
  const quoteCalls = requests.map(encodeQuoteCall);

  // First chunk includes meta calls
  const firstChunkSize = MAX_CALLS_PER_BATCH - metaCalls.length;
  const firstCalls = [...metaCalls, ...quoteCalls.slice(0, firstChunkSize)];
  const firstDecoded = await callMulticall(client, firstCalls);

  const blockNumber = BigInt(firstDecoded[0]!.returnData);
  const basefee = BigInt(firstDecoded[1]!.returnData);
  const allQuoteResults = firstDecoded.slice(metaCalls.length);

  // Remaining chunks
  for (let i = firstChunkSize; i < quoteCalls.length; i += MAX_CALLS_PER_BATCH) {
    const chunk = quoteCalls.slice(i, i + MAX_CALLS_PER_BATCH);
    const decoded = await callMulticall(client, chunk);
    allQuoteResults.push(...decoded);
  }

  const quotes = allQuoteResults.map((result, i) => {
    if (!result.success || result.returnData === "0x") return null;
    try {
      return decodeQuoteResult(result.returnData, requests[i]!.quoterType);
    } catch {
      return null;
    }
  });

  return { blockNumber, basefee, quotes };
}
