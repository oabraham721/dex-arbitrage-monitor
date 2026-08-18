import {
  decodeFunctionResult,
  encodeFunctionData,
  type Address,
  type PublicClient,
  type Transport,
} from "viem";
import { base } from "viem/chains";
import type { QuoterType } from "./config.js";

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

export async function getQuote(
  client: PublicClient<Transport, typeof base>,
  quoter: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  param: number,
  quoterType: QuoterType,
): Promise<Quote> {
  const abi = quoterType === "aerodrome" ? aerodromeAbi : uniV3Abi;
  const args = quoterType === "aerodrome"
    ? [{ tokenIn, tokenOut, amountIn, tickSpacing: param, sqrtPriceLimitX96: 0n }]
    : [{ tokenIn, tokenOut, amountIn, fee: param, sqrtPriceLimitX96: 0n }];

  const callData = encodeFunctionData({
    abi,
    functionName: "quoteExactInputSingle",
    args: args as any,
  });
  const response = await client.call({ to: quoter, data: callData });
  if (!response.data) throw new Error("Quoter returned no data");

  const [amountOut, , , gasEstimate] = decodeFunctionResult({
    abi,
    functionName: "quoteExactInputSingle",
    data: response.data,
  });
  return { amountOut, gasEstimate };
}