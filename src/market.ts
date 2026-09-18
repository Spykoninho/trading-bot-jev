import { config } from "./config.js";

export type Candle = { time: number; open: number; high: number; low: number; close: number };

export const INTERVALS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 } as const;
export type Interval = keyof typeof INTERVALS;

// Bougies réelles depuis l'API publique Binance (mainnet, sans clé) ; la dernière est encore en cours
export async function fetchCandles(symbol: string, interval: Interval, limit = 300, startTime?: number): Promise<Candle[]> {
  const url = `${config.binance.data}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}${startTime ? `&startTime=${startTime}` : ""}`;
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

// Historique long pour le backtest : l'API plafonne à 1000 bougies, on pagine par startTime
export async function fetchHistory(symbol: string, interval: Interval, years: number): Promise<Candle[]> {
  const step = INTERVALS[interval] * 1000;
  const out: Candle[] = [];
  let start = Date.now() - years * 365 * 86_400_000;
  while (start < Date.now() - step) {
    const page = await fetchCandles(symbol, interval, 1000, start);
    if (!page.length) break;
    out.push(...page);
    start = page.at(-1)!.time + step;
  }
  return out.slice(0, -1);
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
