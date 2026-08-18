# DEX Arbitrage Monitor

A read-only Base monitor that compares atomic WETH/USDC round trips using Uniswap V3 Quoter V2-compatible routes. It does not use a wallet or submit transactions.

## Run

```bash
cp .env.example .env
npm install
npm run check
ONCE=true SHOW_ALL=true npm run dev
```

For continuous monitoring, use `npm run dev`. A dedicated Base RPC URL is strongly recommended because the public endpoint is rate limited.

## SMS alerts

Create a Twilio account and an SMS-capable Twilio number, then set these values in `.env`:

```dotenv
TWILIO_ACCOUNT_SID=AC...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+15551234567
ALERT_TO_NUMBER=+15557654321
ALERT_COOLDOWN_MINUTES=15
```

Phone numbers must use E.164 format. Trial Twilio accounts can generally text only verified destination numbers. The monitor sends an SMS when estimated net profit passes `MIN_NET_PROFIT_USDC`; the cooldown suppresses repeated texts for the same route. Credentials remain local because `.env` is gitignored.

The defaults compare Uniswap V3's 0.05% and 0.30% WETH/USDC pools. Set `ROUTES_JSON` to compare compatible quoters on other DEXs. Each entry needs a label, Quoter V2 contract address, and pool fee in hundredths of a basis point.

## Profit model

The monitor requests executable quotes for USDC -> WETH -> USDC, then subtracts estimated swap gas, `GAS_OVERHEAD`, and `EXECUTION_COST_BUFFER_USDC`. The buffer covers Base L1 data fees and other costs the quoter cannot predict; tune it using real transaction simulations. A route is reported only when the remaining amount exceeds `MIN_NET_PROFIT_USDC`.

Quoter results are estimates, not guaranteed execution. A production executor also needs atomic swaps, slippage limits, preflight simulation, private submission where available, and a contract-level minimum-profit revert.