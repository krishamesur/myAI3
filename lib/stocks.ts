// lib/stocks.ts
// 1) US stock data from TwelveData
// 2) Indian stock fundamentals from local NIFTY 500 CSV

import fs from "fs";
import path from "path";
import Papa from "papaparse";

// -------------------------------------------------------------
// Types
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
    if (!apiKey) throw new Error("Missing TwelveData API key.");

    // 1. Quote (close + 52w range)
    const quoteUrl = `https://api.twelvedata.com/quote?symbol=${symbol}&apikey=${apiKey}`;
    const quoteResp = await fetch(quoteUrl);
    const quoteJson = await quoteResp.json();

    if (quoteJson.status === "error") {
      console.error("TwelveData quote API error:", quoteJson.message);
      return null;
    }

    // 2. SMA 50
    const sma50Url = `https://api.twelvedata.com/sma?symbol=${symbol}&interval=1day&time_period=50&apikey=${apiKey}`;
    const sma50Resp = await fetch(sma50Url);
    const sma50Json = await sma50Resp.json();
    const sma50 = sma50Json.values?.[0]?.sma
      ? Number(sma50Json.values[0].sma)
      : null;

    // 3. SMA 200
    const sma200Url = `https://api.twelvedata.com/sma?symbol=${symbol}&interval=1day&time_period=200&apikey=${apiKey}`;
    const sma200Resp = await fetch(sma200Url);
    const sma200Json = await sma200Resp.json();
    const sma200 = sma200Json.values?.[0]?.sma
      ? Number(sma200Json.values[0].sma)
      : null;

    // 4. RSI 14
    const rsiUrl = `https://api.twelvedata.com/rsi?symbol=${symbol}&interval=1day&time_period=14&apikey=${apiKey}`;
    const rsiResp = await fetch(rsiUrl);
    const rsiJson = await rsiResp.json();
    const rsi14 = rsiJson.values?.[0]?.rsi
      ? Number(rsiJson.values[0].rsi)
      : null;

    // 5. 1M / 6M / 1Y returns from time_series
    async function getPastPrice(outputsize: number): Promise<number | null> {
      const tsUrl = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day&outputsize=${outputsize}&apikey=${apiKey}`;
      const tsResp = await fetch(tsUrl);
      const tsJson = await tsResp.json();

      if (!tsJson.values || !Array.isArray(tsJson.values)) return null;
      const values = tsJson.values;
      const lastIndex = values.length - 1;
      if (lastIndex < 1) return null;

      return Number(values[lastIndex].close);
    }

    const closeNow = Number(quoteJson.close);
    const price1m = await getPastPrice(22); // ~1M trading days
    const price6m = await getPastPrice(130);
    const price1y = await getPastPrice(260);

    function calcReturn(oldPrice: number | null): number | null {
      if (!oldPrice || !isFinite(oldPrice)) return null;
      return ((closeNow - oldPrice) / oldPrice) * 100;
    }

    return {
      symbol: quoteJson.symbol,
      close: closeNow,
      fifty_two_week_high: Number(quoteJson.fifty_two_week.high),
      fifty_two_week_low: Number(quoteJson.fifty_two_week.low),
      sma_50: sma50,
      sma_200: sma200,
      rsi_14: rsi14,
      return_1m: calcReturn(price1m),
      return_6m: calcReturn(price6m),
      return_1y: calcReturn(price1y),
    };
  } catch (err) {
    console.error("Error in fetchStockAnalysis:", err);
    return null;
  }
}

// -------------------------------------------------------------
// INDIAN STOCK CSV LOADING (NIFTY 500)
// -------------------------------------------------------------

let nifty500Cache: IndiaStockFundamentals[] | null = null;

function loadNifty500FromCsv() {
  if (nifty500Cache) return;

  try {
    const csvPath = path.join(process.cwd(), "data", "nifty500.csv");
    const file = fs.readFileSync(csvPath, "utf8");

    const parsed = Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
    });

    const rows = parsed.data as any[];

    nifty500Cache = rows.map((row) => {
      const num = (v: any): number | null => {
        if (v === undefined || v === null || v === "") return null;
        const cleaned = String(v).replace(/,/g, "");
        const n = Number(cleaned);
        return isNaN(n) ? null : n;
      };

      return {
        company_name: (row["Company"] || "").toString().trim(),
        symbol: (row["Symbol"] || "").toString().trim(), // if you added a Symbol column
        market_cap: num(row["MarketCap"]),
        cmp: num(row["CMP"]),
        pe: num(row["PE"]),
        pb: num(row["PB"]),
        roe: num(row["ROE"]),
        roce: num(row["ROCE"]),
        return_1m: num(row["Ret_1M"]),
        return_6m: num(row["Ret_6M"]),
        return_1y: num(row["Ret_1Y"]),
      };
    });
  } catch (err) {
    console.error("Error loading nifty500.csv:", err);
    nifty500Cache = null;
  }
}

export function fetchIndianStockFundamentals(
  input: string
): IndiaStockFundamentals | null {
  loadNifty500FromCsv();
  if (!nifty500Cache) return null;

  const q = input.trim().toLowerCase();

  // 1) Exact symbol match (if Symbol column exists)
  const bySymbol = nifty500Cache.find(
    (row) => row.symbol && row.symbol.toLowerCase() === q
  );
  if (bySymbol) return bySymbol;

  // 2) Company name contains search text
  const byName = nifty500Cache.find((row) =>
    row.company_name.toLowerCase().includes(q)
  );
  return byName || null;
}
