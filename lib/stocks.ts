// lib/stocks.ts
// Handles: 
// 1) US stock data from TwelveData API
// 2) Indian stock fundamentals from NIFTY 500 CSV

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
  sma_50: number;
  sma_200: number;
  rsi_14: number;
  return_1m: number;
  return_6m: number;
  return_1y: number;
}

export interface IndiaStockFundamentals {
  company_name: string;
  symbol: string;
  market_cap: string | number | null;
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

export async function fetchStockAnalysis(symbol: string): Promise<USStockData | null> {
  try {
    const apiKey = process.env.TWELVEDATA_API_KEY;
    if (!apiKey) throw new Error("Missing TwelveData API key.");

    // 1. Quote (close price + 52w high/low)
    const quoteUrl = `https://api.twelvedata.com/quote?symbol=${symbol}&apikey=${apiKey}`;
    const quoteResp = await fetch(quoteUrl);
    const quoteJson = await quoteResp.json();

    if (quoteJson.status === "error") {
      console.error("Quote API error:", quoteJson.message);
      return null;
    }

    // 2. SMA 50
    const sma50Url = `https://api.twelvedata.com/sma?symbol=${symbol}&interval=1day&time_period=50&apikey=${apiKey}`;
    const sma50Resp = await fetch(sma50Url);
    const sma50Json = await sma50Resp.json();
    const sma50 = sma50Json.values?.[0]?.sma ? Number(sma50Json.values[0].sma) : null;

    // 3. SMA 200
    const sma200Url = `https://api.twelvedata.com/sma?symbol=${symbol}&interval=1day&time_period=200&apikey=${apiKey}`;
    const sma200Resp = await fetch(sma200Url);
    const sma200Json = await sma200Resp.json();
    const sma200 = sma200Json.values?.[0]?.sma ? Number(sma200Json.values[0].sma) : null;

    // 4. RSI 14
    const rsiUrl = `https://api.twelvedata.com/rsi?symbol=${symbol}&interval=1day&time_period=14&apikey=${apiKey}`;
    const rsiResp = await fetch(rsiUrl);
    const rsiJson = await rsiResp.json();
    const rsi14 = rsiJson.values?.[0]?.rsi ? Number(rsiJson.values[0].rsi) : null;

    // 5. 1M / 6M / 1Y returns via time series
    // -----------------------------------------------------------
    async function getPastPrice(offsetDays: number): Promise<number | null> {
      const tsUrl = `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day&outputsize=${offsetDays}&apikey=${apiKey}`;
      const tsResp = await fetch(tsUrl);
      const tsJson = await tsResp.json();

      if (!tsJson.values) return null;

      const values = tsJson.values;
      const lastIndex = values.length - 1;

      if (lastIndex < 1) return null;

      return Number(values[lastIndex].close);
    }

    const closeNow = Number(quoteJson.close);
    const price1m = await getPastPrice(22);      // ~1 month
    const price6m = await getPastPrice(130);     // ~6 months
    const price1y = await getPastPrice(260);     // ~1 year

    function calcReturn(oldPrice: number | null): number | null {
      if (!oldPrice) return null;
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
  } catch (error) {
    console.error("Error in fetchStockAnalysis:", error);
    return null;
  }
}

// -------------------------------------------------------------
// INDIAN STOCK CSV LOADING (NIFTY 500)
// -------------------------------------------------------------

let nifty500Cache: any[] | null = null;

function loadNifty500FromCsv() {
  if (nifty500Cache) re
