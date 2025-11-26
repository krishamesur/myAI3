// lib/stocks.ts

const BASE_URL = "https://api.twelvedata.com";

export type StockAnalysisData = {
  symbol: string;
  close?: number;
  pe?: number;
  pb?: number;
  roe?: number;
  roce?: number;
  return_1m?: number;
  return_6m?: number;
  return_1y?: number;
  industry_pe?: number;
  industry_pb?: number;
  net_profit_margin?: number;
  ev_ebitda?: number;
};

// Helper to safely convert strings to numbers
function toNumber(val: unknown): number | undefined {
  if (val === null || val === undefined) return undefined;
  const n = Number(val);
  return Number.isNaN(n) ? undefined : n;
}

export async function fetchStockAnalysis(symbol: string): Promise<StockAnalysisData> {
  const apiKey = process.env.TWELVEDATA_API_KEY;
  if (!apiKey) {
    throw new Error("TWELVEDATA_API_KEY is not set in environment variables");
  }

  // 1) Quote endpoint, gives price, some ratios and maybe simple returns
  const quoteUrl = `${BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&apikey=${apiKey}`;

  const quoteRes = await fetch(quoteUrl);
  if (!quoteRes.ok) {
    throw new Error(`TwelveData quote error: ${quoteRes.status} ${quoteRes.statusText}`);
  }
  const quoteData = await quoteRes.json();

  if ((quoteData as any).code) {
    // TwelveData style error
    throw new Error(`TwelveData quote API error: ${(quoteData as any).message || "Unknown error"}`);
  }

  // 2) Fundamentals / ratios endpoint
  // Check TwelveData docs for the exact path and fields, then adjust this URL
  const fundamentalsUrl = `${BASE_URL}/fundamentals?symbol=${encodeURIComponent(
    symbol,
  )}&apikey=${apiKey}`;

  const fundamentalsRes = await fetch(fundamentalsUrl);
  if (!fundamentalsRes.ok) {
    throw new Error(
      `TwelveData fundamentals error: ${fundamentalsRes.status} ${fundamentalsRes.statusText}`,
    );
  }
  const fundamentalsData = await fundamentalsRes.json();

  if ((fundamentalsData as any).code) {
    throw new Error(
      `TwelveData fundamentals API error: ${(fundamentalsData as any).message || "Unknown error"}`,
    );
  }

  // Here you or your coder friend will map the actual field names
  // from TwelveData to our clean object.
  // The field names below are examples and must be adjusted
  // according to the real JSON you see from TwelveData.

  const result: StockAnalysisData = {
    symbol,
    close: toNumber((quoteData as any).close),
    pe: toNumber((quoteData as any).pe ?? (fundamentalsData as any).pe_ratio),
    pb: toNumber((quoteData as any).pb ?? (fundamentalsData as any).pb_ratio),
    roe: toNumber((fundamentalsData as any).roe),
    roce: toNumber((fundamentalsData as any).roce),
    return_1m: toNumber((fundamentalsData as any).return_1m),
    return_6m: toNumber((fundamentalsData as any).return_6m),
    return_1y: toNumber((fundamentalsData as any).return_1y),
    industry_pe: toNumber((fundamentalsData as any).industry_pe),
    industry_pb: toNumber((fundamentalsData as any).industry_pb),
    net_profit_margin: toNumber((fundamentalsData as any).net_profit_margin),
    ev_ebitda: toNumber((fundamentalsData as any).ev_ebitda),
  };

  return result;
}
