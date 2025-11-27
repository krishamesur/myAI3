// lib/stocks.ts

import fs from "fs";
import path from "path";
const BASE_URL = "https://api.twelvedata.com";

export type USStockAnalysisData = {
  symbol: string;

  // From /quote
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

export type IndiaStockFundamentals = {
  symbol: string;
  company_name?: string;
  market_cap?: number;
  cmp?: number;
  pe?: number;
  pb?: number;
  roe?: number;
  roce?: number;
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
// ---------- India NIFTY 500 CSV loading ----------

let nifty500Cache: Map<string, IndiaStockFundamentals> | null = null;

function loadNifty500FromCsv() {
  if (nifty500Cache) return; // already loaded

  nifty500Cache = new Map();

  try {
    const csvPath = path.join(process.cwd(), "data", "nifty500.csv");
    const raw = fs.readFileSync(csvPath, "utf8");

    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return;

    const header = lines[0].split(",").map((h) => h.trim());
    const idx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());

    // Adjust these names if your CSV headers are different
    const symbolIdx = idx("Symbol");
    const nameIdx = idx("Company") !== -1 ? idx("Company") : idx("Name");
    const mcapIdx = idx("MarketCap");
    const cmpIdx = idx("CMP");
    const peIdx = idx("PE");
    const pbIdx = idx("PB");
    const roeIdx = idx("ROE");
    const roceIdx = idx("ROCE");
    const r1mIdx = idx("Ret_1M");
    const r6mIdx = idx("Ret_6M");
    const r1yIdx = idx("Ret_1Y");

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(",");
      if (parts.length < 2) continue;

      const symbolRaw = parts[symbolIdx] || "";
      const symbol = symbolRaw.trim().toUpperCase();
      if (!symbol) continue;

      const rec: IndiaStockFundamentals = {
        symbol,
        company_name: nameIdx !== -1 ? parts[nameIdx].trim() : undefined,
        market_cap: mcapIdx !== -1 ? toNumber(parts[mcapIdx]) : undefined,
        cmp: cmpIdx !== -1 ? toNumber(parts[cmpIdx]) : undefined,
        pe: peIdx !== -1 ? toNumber(parts[peIdx]) : undefined,
        pb: pbIdx !== -1 ? toNumber(parts[pbIdx]) : undefined,
        roe: roeIdx !== -1 ? toNumber(parts[roeIdx]) : undefined,
        roce: roceIdx !== -1 ? toNumber(parts[roceIdx]) : undefined,
        return_1m: r1mIdx !== -1 ? toNumber(parts[r1mIdx]) : undefined,
        return_6m: r6mIdx !== -1 ? toNumber(parts[r6mIdx]) : undefined,
        return_1y: r1yIdx !== -1 ? toNumber(parts[r1yIdx]) : undefined,
      };

      nifty500Cache.set(symbol, rec);
    }
  } catch (err) {
    console.error("Error loading NIFTY 500 CSV", err);
  }
}
/**
 * Look up an Indian stock from NIFTY 500 CSV using fuzzy company-name matching.
 * - User may type "HDFCBANK", "HDFC Bank", "reliance", "tcs" etc.
 * - We match input text to company name (case-insensitive, contains check)
 */
export function fetchIndianStockFundamentals(input: string): IndiaStockFundamentals | null {
  loadNifty500FromCsv();
  if (!nifty500Cache) return null;

  const query = input.trim().toLowerCase();
  if (!query) return null;

  let bestMatch: IndiaStockFundamentals | null = null;

  for (const rec of nifty500Cache.values()) {
    if (!rec.company_name) continue;

    const name = rec.company_name.toLowerCase();

    // simple fuzzy match: contains
    if (name.includes(query)) {
      bestMatch = rec;
      break; // return the first match (good enough for now)
    }
  }

  return bestMatch;
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
