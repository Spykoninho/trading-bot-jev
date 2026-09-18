import { config } from "./config.js";

export type Candle = { time: number; open: number; high: number; low: number; close: number };

export const INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type Interval = (typeof INTERVALS)[number];

// Bougies réelles depuis l'API publique Binance (mainnet, sans clé)
export async function fetchCandles(symbol: string, interval: Interval, limit = 300): Promise<Candle[]> {
  const url = `${config.binance.data}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${symbol}: ${res.status}`);
  const rows = (await res.json()) as [number, string, string, string, string][];
  return rows.map(([time, open, high, low, close]) => ({
    time,
    open: Number(open),
    high: Number(high),
    low: Number(low),
    close: Number(close),
  }));
}

// Flux temps réel : miniTicker pousse le dernier prix de chaque symbole environ une fois par seconde
export function startPriceFeed(symbols: string[], onPrice: (symbol: string, price: number) => void): void {
  const streams = symbols.map((s) => `${s.toLowerCase()}@miniTicker`).join("/");
  const connect = () => {
    const ws = new WebSocket(`${config.binance.stream}/stream?streams=${streams}`);
    ws.onmessage = (event) => {
      const { data } = JSON.parse(String(event.data)) as { data: { s: string; c: string } };
      onPrice(data.s, Number(data.c));
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => setTimeout(connect, 2000);
  };
  connect();
}

export function ema(values: number[], period: number): number {
  const k = 2 / (period + 1);
  return values.reduce((prev, value) => value * k + prev * (1 - k));
}

// Signal micro borné à [-1, 1] : écart relatif entre EMA rapide et EMA lente des prix à la seconde
export function microSignal(prices: number[], m: { fast: number; slow: number; saturation: number }): number {
  if (prices.length < m.slow) return 0;
  const slow = ema(prices.slice(-m.slow * 3), m.slow);
  const fast = ema(prices.slice(-m.fast * 3), m.fast);
  return Math.max(-1, Math.min(1, (fast - slow) / slow / m.saturation));
}
