// lib/stocks.ts

const BASE_URL = "https://api.twelvedata.com";

export type USStockAnalysisData = {
  symbol: string;

  // From /quote
  market_cap?: number;
  close?: number;
  fifty_two_week_high?: number;
  fifty_two_week_low?: number;

  // From /time_series
  sma_50?: number;
  sma_200?: number;
  rsi_14?: number;

  // Returns (percent)
  return_1m?: number;
  return_6m?: number;
  return_1y?: number;
};

// Safely convert unknown → number | undefined
function toNumber(val: unknown): number | undefined {
  if (val === null || val === undefined) return undefined;
  const n = Number(val);
  return Number.isNaN(n) ? undefined : n;
}

// Simple SMA over last N closes (array is oldest → newest)
function sma(closes: number[], period: number): number | undefined {
  if (closes.length < period) return undefined;
  const slice = closes.slice(-period);
  const sum = slice.reduce((acc, v) => acc + v, 0);
  return sum / period;
}

// Classic 14-day RSI from closes (array is oldest → newest)
function rsi(closes: number[], period = 14): number | undefined {
  if (closes.length <= period) return undefined;

  const slice = closes.slice(-(period + 1)); // need period+1 prices
  let gains = 0;
  let losses = 0;

  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff; // diff negative, add magnitude to losses
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;

  if (avgLoss === 0) return 100; // only gains, RSI maxed
  const rs = avgGain / avgLoss;
  const rsiVal = 100 - 100 / (1 + rs);
  return rsiVal;
}

// Percent return over N trading days (array is oldest → newest)
function returnPercent(closes: number[], days: number): number | undefined {
  if (closes.length <= days) return undefined;
  const latest = closes[closes.length - 1];
  const past = closes[closes.length - 1 - days];
  if (past === 0) return undefined;
  const ratio = latest / past;
  return (ratio - 1) * 100;
}

/**
 * For now, this assumes US stocks like AAPL, MSFT etc.
 * It uses:
 *  - /quote      → close, 52w high/low, market cap
 *  - /time_series → closes for SMA, RSI, returns
 */
export async function fetchStockAnalysis(symbol: string): Promise<USStockAnalysisData> {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    throw new Error("TWELVEDATA_API_KEY is not set in environment variables");
  }

  // 1) /quote: latest close, 52w range, market cap
  const quoteUrl = `${BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;

  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) {
    throw new Error(`TwelveData quote error: ${quoteRes.status} ${quoteRes.statusText}`);
  }
  const quoteData = await quoteRes.json();
  if ((quoteData as any).code) {
    throw new Error(
      `TwelveData quote API error: ${(quoteData as any).message || "Unknown error"}`
    );
  }

  const fiftyTwoWeek = (quoteData as any).fifty_two_week || {};

  // 2) /time_series: daily closes to compute SMA, RSI, returns
  // 260 days ~ 1 trading year (enough for 1Y returns and SMA-200)
  const tsUrl =
    `${BASE_URL}/time_series?symbol=${encodeURIComponent(
      symbol
    )}&interval=1day&outputsize=260&apikey=${apiKey}`;

  const tsRes = await fetch(tsUrl);
  if (!tsRes.ok) {
    throw new Error(`TwelveData time_series error: ${tsRes.status} ${tsRes.statusText}`);
  }
  const tsData = await tsRes.json();
  if ((tsData as any).code) {
    throw new Error(
      `TwelveData time_series API error: ${(tsData as any).message || "Unknown error"}`
    );
  }

  const values = (tsData as any).values as { close: string }[] | undefined;
  let closes: number[] = [];

  if (Array.isArray(values) && values.length > 0) {
    // TwelveData returns NEWEST first → reverse to OLDEST → NEWEST
    closes = values
      .slice()
      .reverse()
      .map((v) => Number(v.close))
      .filter((n) => !Number.isNaN(n));
  }

  const result: USStockAnalysisData = {
    symbol,

    // From quote
    market_cap: toNumber((quoteData as any).market_cap),
    close: toNumber((quoteData as any).close),
    fifty_two_week_high: toNumber(fiftyTwoWeek.high),
    fifty_two_week_low: toNumber(fiftyTwoWeek.low),

    // From time series
    sma_50: sma(closes, 50),
    sma_200: sma(closes, 200),
    rsi_14: rsi(closes, 14),

    // Returns (approx trading days: 1M≈21, 6M≈126, 1Y≈252)
    return_1m: returnPercent(closes, 21),
    return_6m: returnPercent(closes, 126),
    return_1y: returnPercent(closes, 252),
  };

  return result;
}
