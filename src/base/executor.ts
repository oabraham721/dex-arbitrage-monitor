import {
  encodeFunctionData,
  encodeAbiParameters,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import type { QuoterType, Route } from "./config.js";

// Swap routers on Base (distinct from quoters)
const SWAP_ROUTERS: Record<string, Address> = {
  // Uniswap V3 SwapRouter02
  "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a": "0x2626664c2603336E57B271c5C0b26F421741e481",
  // PancakeSwap V3 SmartRouter
  "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997": "0x678Aa4bF4E210cf2166753e054d5b7c31cc7fa86",
  // SushiSwap V3 Router
  "0xb1E835Dc2785b52265711e17fCCb0fd018226a6e": "0xFB7eF66a7e61224DD6FcD0D7d9C3be5C8B049b9f",
  // Aerodrome Slipstream Router
  "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0": "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
  // Balancer V2 Router (same for query and swap)
  "0x3f170631ed9821Ca51A59D996aB095162438DC10": "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
};

export function getSwapRouter(quoter: Address): Address {
  const router = SWAP_ROUTERS[quoter];
  if (!router) throw new Error(`No swap router mapped for quoter ${quoter}`);
  return router;
}

export function getAllSwapRouters(): Address[] {
  return [...new Set(Object.values(SWAP_ROUTERS))];
}

// Uniswap V3 SwapRouter02: exactInputSingle (no deadline)
const uniV3SwapAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
] as const;

// PancakeSwap V3 SmartRouter: exactInputSingle (with deadline)
const pancakeSwapAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "payable",
  },
] as const;

// Aerodrome Slipstream Router: exactInputSingle
const aeroSwapAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
    stateMutability: "nonpayable",
  },
] as const;

// Balancer V2 Vault: swap
const balancerSwapAbi = [
  {
    type: "function",
    name: "swap",
    inputs: [
      {
        name: "singleSwap",
        type: "tuple",
        components: [
          { name: "poolId", type: "bytes32" },
          { name: "kind", type: "uint8" },
          { name: "assetIn", type: "address" },
          { name: "assetOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "userData", type: "bytes" },
        ],
      },
      {
        name: "funds",
        type: "tuple",
        components: [
          { name: "sender", type: "address" },
          { name: "fromInternalBalance", type: "bool" },
          { name: "recipient", type: "address" },
          { name: "toInternalBalance", type: "bool" },
        ],
      },
      { name: "limit", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
    outputs: [{ name: "amountCalculated", type: "uint256" }],
    stateMutability: "payable",
  },
] as const;

const PANCAKE_QUOTER = "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997";
const SUSHI_QUOTER = "0xb1E835Dc2785b52265711e17fCCb0fd018226a6e";
const DEADLINE_FAR_FUTURE = BigInt(Math.floor(Date.now() / 1000) + 3600);

export function encodeSwapCalldata(
  route: Route,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  amountOutMin: bigint,
  recipient: Address,
): Hex {
  if (route.quoterType === "uniV3") {
    // PancakeSwap and SushiSwap use deadline-style interface
    if (route.quoter === PANCAKE_QUOTER || route.quoter === SUSHI_QUOTER) {
      return encodeFunctionData({
        abi: pancakeSwapAbi,
        functionName: "exactInputSingle",
        args: [{
          tokenIn, tokenOut, fee: route.param,
          recipient, deadline: DEADLINE_FAR_FUTURE,
          amountIn, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n,
        }],
      });
    }
    // Uniswap SwapRouter02 (no deadline)
    return encodeFunctionData({
      abi: uniV3SwapAbi,
      functionName: "exactInputSingle",
      args: [{
        tokenIn, tokenOut, fee: route.param,
        recipient, amountIn, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n,
      }],
    });
  }

  if (route.quoterType === "aerodrome") {
    return encodeFunctionData({
      abi: aeroSwapAbi,
      functionName: "exactInputSingle",
      args: [{
        tokenIn, tokenOut, tickSpacing: route.param,
        recipient, deadline: DEADLINE_FAR_FUTURE,
        amountIn, amountOutMinimum: amountOutMin, sqrtPriceLimitX96: 0n,
      }],
    });
  }

  if (route.quoterType === "balancer" && route.pool) {
    // Balancer V2 poolId = pool address + suffix (need to query on-chain, use pool address padded for now)
    // Actually Balancer V2 poolId is returned by pool.getPoolId() — we'd need to query this
    // For now, this is a placeholder — Balancer execution needs the poolId
    throw new Error("Balancer execution not yet supported — needs poolId lookup");
  }

  throw new Error(`Unsupported quoter type: ${route.quoterType}`);
}

// ABI for the ArbitrageExecutor contract
export const executorAbi = [
  {
    type: "function",
    name: "execute",
    inputs: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setRouter",
    inputs: [
      { name: "router", type: "address" },
      { name: "allowed", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [{ name: "token", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Encode the full flash loan callback data for onMorphoFlashLoan.
 */
export function encodeArbData(
  buyRouter: Address,
  buyCalldata: Hex,
  sellRouter: Address,
  sellCalldata: Hex,
  tokenIn: Address,
  tokenOut: Address,
  minProfit: bigint,
  sellAmountInOffset: bigint,
): Hex {
  return encodeAbiParameters(
    parseAbiParameters("address, bytes, address, bytes, address, address, uint256, uint256"),
    [buyRouter, buyCalldata, sellRouter, sellCalldata, tokenIn, tokenOut, minProfit, sellAmountInOffset],
  );
}

/**
 * Byte offset of amountIn inside the sell calldata.
 * Uniswap V3 SwapRouter02 (no deadline): selector(4) + 4 fields × 32 = 132
 * PancakeSwap / SushiSwap / Aerodrome (with deadline): selector(4) + 5 fields × 32 = 164
 */
export function getSellAmountInOffset(quoter: Address): bigint {
  const UNISWAP_QUOTER = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
  return quoter.toLowerCase() === UNISWAP_QUOTER.toLowerCase() ? 132n : 164n;
}
