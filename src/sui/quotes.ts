import { Aftermath } from "aftermath-ts-sdk";
import type { Protocol } from "./config.js";

let router: Awaited<ReturnType<Aftermath["Router"]>> | null = null;

export async function initRouter(): Promise<void> {
  const af = await Aftermath.create({ network: "MAINNET" });
  router = af.Router();
}

export type PerDexQuote = {
  protocol: Protocol;
  amountOut: bigint;
};

export async function getQuotesPerProtocol(
  coinInType: string,
  coinOutType: string,
  amountIn: bigint,
  protocols: Protocol[],
): Promise<PerDexQuote[]> {
  if (!router) throw new Error("Router not initialized");

  const results = await Promise.allSettled(
    protocols.map(async (protocol) => {
      const route = await router!.getCompleteTradeRouteGivenAmountIn({
        coinInType,
        coinOutType,
        coinInAmount: amountIn,
        protocolWhitelist: [protocol],
      });
      return { protocol, amountOut: route.coinOut.amount };
    }),
  );

  const quotes: PerDexQuote[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      quotes.push(result.value);
    }
  }
  return quotes;
}
