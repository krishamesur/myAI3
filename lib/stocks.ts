// lib/stocks.ts

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

export async function fetchStockAnalysis(symbol: string): Promise<StockAnalysisData> {
  // TEMPORARY: dummy data just to test the flow.
  // Later we will replace this with real TwelveData calls.

  return {
    symbol,
    close: 1500,
    pe: 18.5,
    pb: 2.7,
    roe: 15.2,
    roce: 18.0,
    return_1m: 3.5,
    return_6m: 12.0,
    return_1y: 22.0,
    industry_pe: 16.0,
    industry_pb: 2.2,
    net_profit_margin: 20.0,
    ev_ebitda: 7.5,
  };
}
