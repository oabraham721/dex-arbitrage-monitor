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
};

function encodeQuoteCall(req: QuoteRequest): { target: Address; callData: `0x${string}` } {
  const abi = req.quoterType === "aerodrome" ? aerodromeAbi : uniV3Abi;
  const args = req.quoterType === "aerodrome"
    ? [{ tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountIn: req.amountIn, tickSpacing: req.param, sqrtPriceLimitX96: 0n }]
    : [{ tokenIn: req.tokenIn, tokenOut: req.tokenOut, amountIn: req.amountIn, fee: req.param, sqrtPriceLimitX96: 0n }];

  const callData = encodeFunctionData({ abi, functionName: "quoteExactInputSingle", args: args as any });
  return { target: req.quoter, callData };
}

function decodeQuoteResult(data: `0x${string}`, quoterType: QuoterType): Quote {
  const abi = quoterType === "aerodrome" ? aerodromeAbi : uniV3Abi;
  const [amountOut, , , gasEstimate] = decodeFunctionResult({
    abi,
    functionName: "quoteExactInputSingle",
    data,
  });
  return { amountOut, gasEstimate };
}

export async function batchQuote(
  client: PublicClient<Transport, typeof base>,
  requests: QuoteRequest[],
): Promise<(Quote | null)[]> {
  if (requests.length === 0) return [];

  const calls = requests.map(encodeQuoteCall);
  const multicallData = encodeFunctionData({
    abi: multicall3Abi,
    functionName: "tryAggregate",
    args: [false, calls],
  });

  const response = await client.call({ to: MULTICALL3, data: multicallData });
  if (!response.data) throw new Error("Multicall returned no data");

  const decoded = decodeFunctionResult({
    abi: multicall3Abi,
    functionName: "tryAggregate",
    data: response.data,
  }) as unknown as { success: boolean; returnData: `0x${string}` }[];

  return decoded.map((result, i) => {
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
  quotes: (Quote | null)[];
};

/** Batches quote requests + blockNumber into a single RPC call. */
export async function batchQuoteWithMeta(
  client: PublicClient<Transport, typeof base>,
  requests: QuoteRequest[],
): Promise<BatchMetaResult> {
  const metaCalls: { target: Address; callData: `0x${string}` }[] = [
    { target: MULTICALL3, callData: encodeFunctionData({ abi: multicall3Abi, functionName: "getBlockNumber", args: [] }) },
  ];
  const quoteCalls = requests.map(encodeQuoteCall);
  const allCalls = [...metaCalls, ...quoteCalls];

  const multicallData = encodeFunctionData({
    abi: multicall3Abi,
    functionName: "tryAggregate",
    args: [false, allCalls],
  });

  const response = await client.call({ to: MULTICALL3, data: multicallData });
  if (!response.data) throw new Error("Multicall returned no data");

  const decoded = decodeFunctionResult({
    abi: multicall3Abi,
    functionName: "tryAggregate",
    data: response.data,
  }) as unknown as { success: boolean; returnData: `0x${string}` }[];

  const blockNumber = BigInt(decoded[0]!.returnData);

  const quotes = decoded.slice(1).map((result, i) => {
    if (!result.success || result.returnData === "0x") return null;
    try {
      return decodeQuoteResult(result.returnData, requests[i]!.quoterType);
    } catch {
      return null;
    }
  });

  return { blockNumber, quotes };
}
