// lib/stocks.ts
// Handles:
// 1) US stock data from TwelveData API
// 2) Indian stock fundamentals from NIFTY 500 CSV

import fs from "fs";
import path from "path";
import Papa from "papaparse";

// -------------------------------------------------------------
// TYPES
// -------------------------------------------------------------

export interface USStockData {
  symbol: string;
  close: number;
  fifty_two_week_high: number;
  fifty_two_week_low: number;
  sma_50: number | null;
  sma_200: number | null;
  rsi_14: number | null;
  return_1m: number | null;
  return_6m: number | null;
  return_1y: number | null;
}

export interface IndiaStockFundamentals {
  company_name: string;
  symbol: string;
  market_cap: number | null;
  cmp: number | null;
  pe: number | null;
  pb: number | null;
  roe: number | null;
  roce: number | null;
  return_1m: number | null;
  return_6m: number | null;
  return_1y: number | null;
}

// -------------------------------------------------------------
// US STOCK FETCH (TwelveData)
// -------------------------------------------------------------

export async function fetchStockAnalysis(
  symbol: string
): Promise<USStockData | null> {
  try {
    const apiKey = process.env.TWELVEDATA_API_KEY;
    if (!apiKey) throw new Error("Missing TwelveData API key");

    // Quote API
    const quoteUrl = `https://api.twelvedata.com/quote?symbol=${symbol}&apikey=${apiKey}`;
    const quoteResp = await fetch(quoteUrl);
    const quoteJson = await quoteResp.json();

    if (quoteJson.status === "error") {
      return null;
    }

    const closeNow = Number(quoteJson.close);

    // SMA helper
    async function getIndicator(url: string): Promise<number | null> {
      const resp = await fetch(url);
      const json = await resp.json();
      return json.values?.[0]?.[Object.keys(json.values[0])[1]]
        ? Number(json.values[0][Object.keys(json.values[0])[1]])
        : null;
    }

    const sma50 = await getIndicator(
      `https://api.twelvedata.com/sma?symbol=${symbol}&interval=1day&time_period=50&apikey=${apiKey}`
    );

    const sma200 = await getIndicator(
      `https://api.twelvedata.com/sma?symbol=${symbol}&interval=1day&time_period=200&apikey=${apiKey}`
    );

    const rsi14 = await getIndicator(
      `https://api.twelvedata.com/rsi?symbol=${symbol}&interval=1day&time_period=14&apikey=${apiKey}`
    );

    // Returns helper
    async function getPastPrice(days: number): Promise<number | null> {
      const url = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day&outputsize=${days}&apikey=${apiKey}`;
      const resp = await fetch(url);
      const json = await resp.json();
      if (!json.values) return null;
      return Number(json.values.at(-1).close);
    }

    function pct(oldPrice: number | null): number | null {
      if (!oldPrice) return null;
      return ((closeNow - oldPrice) / oldPrice) * 100;
    }

    const price1m = await getPastPrice(22);
    const price6m = await getPastPrice(130);
    const price1y = await getPastPrice(260);

    return {
      symbol: quoteJson.symbol,
      close: closeNow,
      fifty_two_week_high: Number(quoteJson.fifty_two_week.high),
      fifty_two_week_low: Number(quoteJson.fifty_two_week.low),
      sma_50: sma50,
      sma_200: sma200,
      rsi_14: rsi14,
      return_1m: pct(price1m),
      return_6m: pct(price6m),
      return_1y: pct(price1y),
    };
  } catch (err) {
    console.error("US fetch error:", err);
    return null;
  }
}

// -------------------------------------------------------------
// INDIA STOCK CSV LOADING
// -------------------------------------------------------------

let nifty500Cache: IndiaStockFundamentals[] | null = null;

function loadNiftyCSV() {
  if (nifty500Cache) return;

  try {
    const filePath = path.join(process.cwd(), "data", "nifty500.csv");
    const csv = fs.readFileSync(filePath, "utf8");

    const parsed = Papa.parse(csv, {
      header: true,
      skipEmptyLines: true,
    });

    nifty500Cache = parsed.data.map((row: any) => ({
      company_name: row.Company?.trim() || "",
      symbol: row.Symbol?.trim() || "",
      market_cap: row.MarketCap ? Number(row.MarketCap) : null,
      cmp: row.CMP ? Number(row.CMP) : null,
      pe: row.PE ? Number(row.PE) : null,
      pb: row.PB ? Number(row.PB) : null,
      roe: row.ROE ? Number(row.ROE) : null,
      roce: row.ROCE ? Number(row.ROCE) : null,
      return_1m: row.Ret_1M ? Number(row.Ret_1M) : null,
      return_6m: row.Ret_6M ? Number(row.Ret_6M) : null,
      return_1y: row.Ret_1Y ? Number(row.Ret_1Y) : null,
    }));
  } catch (err) {
    console.error("CSV load error:", err);
    nifty500Cache = [];
  }
}

// -------------------------------------------------------------
// INDIA STOCK MATCHING (SYMBOL + NAME)
// -------------------------------------------------------------

export function fetchIndianStockFundamentals(
  input: string
): IndiaStockFundamentals | null {
  loadNiftyCSV();
  if (!nifty500Cache) return null;

  const t = input.trim().toLowerCase();

  // 1. Exact symbol match
  let match = nifty500Cache.find((r) => r.symbol.toLowerCase() === t);
  if (match) return match;

  // 2. Exact company name
  match = nifty500Cache.find((r) => r.company_name.toLowerCase() === t);
  if (match) return match;

  // 3. Partial name (HDFC Bank → matches “HDFC Bank Ltd”)
  match = nifty500Cache.find((r) =>
    r.company_name.toLowerCase().includes(t)
  );
  if (match) return match;

  return null;
}
