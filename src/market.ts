import { config } from "./config.js";

export type Candle = { time: number; close: number };

export type MarketSnapshot = {
  symbol: string;
  price: number;
  change24h: number;
  sma24: number;
  signal: number;
};

export function sma(values: number[], period: number): number {
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// Signal technique borné à [-1, 1] : écart du prix à sa SMA 24h, saturé à ±3 %
export function techSignal(candles: Candle[]): Omit<MarketSnapshot, "symbol"> {
  const closes = candles.map((c) => c.close);
  const price = closes.at(-1)!;
  const dayAgo = closes.at(-25) ?? closes[0]!;
  const sma24 = sma(closes, 24);
  const signal = Math.max(-1, Math.min(1, (price - sma24) / sma24 / 0.03));
  return { price, change24h: (price - dayAgo) / dayAgo, sma24, signal };
}

// Bougies 1h réelles depuis l'API publique Binance (mainnet, sans clé)
export async function fetchCandles(symbol: string, limit = 48): Promise<Candle[]> {
  const url = `${config.binance.data}/api/v3/klines?symbol=${symbol}&interval=1h&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${symbol}: ${res.status}`);
  const rows = (await res.json()) as [number, string, string, string, string][];
  return rows.map(([time, , , , close]) => ({ time, close: Number(close) }));
}

export async function marketSnapshot(symbol: string): Promise<MarketSnapshot> {
  return { symbol, ...techSignal(await fetchCandles(symbol)) };
}
