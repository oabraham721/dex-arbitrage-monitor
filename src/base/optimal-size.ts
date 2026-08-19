import { type Address, type PublicClient, type Transport } from "viem";
import { base } from "viem/chains";
import { config, type Route, type Pair } from "./config.js";
import { batchQuote, type QuoteRequest, type Quote } from "./multicall.js";

export type OptimalResult = {
  optimalSize: bigint; // trade size in native decimals (6 for USDC, 18 for WETH)
  optimalSizeUsdc: bigint; // in USDC 6-decimal terms
  peakNetProfit: bigint; // USDC 6-decimals
  maxBreakevenSize: bigint; // largest size still profitable
};

// Trade sizes to probe (USDC). Binary search after coarse sweep.
const PROBE_SIZES_USDC = [
  1_000n, 2_500n, 5_000n, 10_000n, 25_000n, 50_000n,
  100_000n, 250_000n, 500_000n, 1_000_000n, 2_000_000n,
];

/**
 * Given a detected arb (buyRoute, sellRoute, pair), probe increasing trade sizes
 * to find the peak profit and max breakeven size.
 */
export async function findOptimalSize(
  client: PublicClient<Transport, typeof base>,
  pair: Pair,
  buyRoute: Route,
  sellRoute: Route,
  gasPrice: bigint,
  wethBest: bigint, // WETH received for config.tradeSize USDC (18 decimals)
): Promise<OptimalResult> {
  const isWethPair = pair.decimalsA === 18;

  // Build probe amounts in native token decimals
  const probes = PROBE_SIZES_USDC.map((usdcAmount) => {
    const usdc6 = usdcAmount * 1_000_000n;
    if (isWethPair && wethBest > 0n) {
      // Convert USDC amount to WETH: scale relative to config.tradeSize
      const wethAmount = (usdc6 * wethBest) / config.tradeSize;
      return { native: wethAmount, usdc6 };
    }
    return { native: usdc6, usdc6 };
  });

  // Phase 1: quote buy leg at all probe sizes
  const buyRequests: QuoteRequest[] = probes.map((p) => ({
    quoter: buyRoute.quoter,
    tokenIn: pair.tokenA,
    tokenOut: pair.tokenB,
    amountIn: p.native,
    param: buyRoute.param,
    quoterType: buyRoute.quoterType,
    pool: buyRoute.pool,
  }));

  const buyResults = await batchQuote(client, buyRequests);

  // Phase 2: quote sell leg using buy outputs
  const sellRequests: QuoteRequest[] = [];
  const validIndices: number[] = [];
  for (let i = 0; i < buyResults.length; i++) {
    const buyQuote = buyResults[i];
    if (!buyQuote) continue;
    sellRequests.push({
      quoter: sellRoute.quoter,
      tokenIn: pair.tokenB,
      tokenOut: pair.tokenA,
      amountIn: buyQuote.amountOut,
      param: sellRoute.param,
      quoterType: sellRoute.quoterType,
      pool: sellRoute.pool,
    });
    validIndices.push(i);
  }

  const sellResults = await batchQuote(client, sellRequests);

  // Phase 3: compute net profit at each size
  let peakNetProfit = 0n;
  let optimalIdx = 0;
  let maxBreakevenIdx = 0;

  for (let j = 0; j < sellResults.length; j++) {
    const sellQuote = sellResults[j];
    if (!sellQuote) continue;
    const i = validIndices[j]!;
    const buyQuote = buyResults[i]!;
    const probe = probes[i]!;

    const gasUnits = buyQuote.gasEstimate + sellQuote.gasEstimate + config.gasOverhead;
    const gasWei = gasUnits * gasPrice;
    // Same conversion as main loop: gasWei * tradeSize / wethBest
    const gasCostUsdc = wethBest > 0n
      ? (gasWei * config.tradeSize) / wethBest
      : 0n;

    const grossNative = sellQuote.amountOut - probe.native;

    // Convert profit to USDC 6-decimals (same as main loop)
    const profitUsdc = isWethPair && wethBest > 0n
      ? (grossNative * config.tradeSize) / wethBest
      : grossNative;

    const netProfit = profitUsdc - gasCostUsdc - config.executionCostBuffer;

    if (netProfit > peakNetProfit) {
      peakNetProfit = netProfit;
      optimalIdx = i;
    }
    if (netProfit > 0n) {
      maxBreakevenIdx = i;
    }
  }

  return {
    optimalSize: probes[optimalIdx]!.native,
    optimalSizeUsdc: probes[optimalIdx]!.usdc6,
    peakNetProfit,
    maxBreakevenSize: probes[maxBreakevenIdx]!.usdc6,
  };
}
