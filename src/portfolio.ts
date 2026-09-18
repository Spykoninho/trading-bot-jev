import type { Side } from "./broker.js";

export type Trade = {
  time: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  usdt: number;
  fee: number;
  reason: string;
};

export type EquityPoint = { time: string; equity: number; cash: number };

export type Portfolio = {
  startedAt: string;
  startCash: number;
  cash: number;
  positions: Record<string, number>;
  trades: Trade[];
  history: EquityPoint[];
};

const MIN_NOTIONAL = 10;
const MAX_HISTORY = 2000;

export function newPortfolio(startCash: number, now = new Date()): Portfolio {
  return { startedAt: now.toISOString(), startCash, cash: startCash, positions: {}, trades: [], history: [] };
}

export function equity(p: Portfolio, prices: Record<string, number>): number {
  return Object.entries(p.positions).reduce((sum, [symbol, qty]) => sum + qty * (prices[symbol] ?? 0), p.cash);
}

type OrderInput = { symbol: string; side: Side; usdt: number; price: number; fee: number; reason: string };

// Ordre papier exécuté au prix réel du moment ; renvoie null si le montant est trop faible
export function applyOrder(p: Portfolio, o: OrderInput, now = new Date()): Trade | null {
  const held = p.positions[o.symbol] ?? 0;
  // BUY plafonné par le cash, SELL plafonné par la position : ni découvert ni vente à vide
  const gross = o.side === "BUY" ? Math.min(o.usdt, p.cash) : Math.min(o.usdt, held * o.price);
  if (gross < MIN_NOTIONAL) return null;

  const fee = gross * o.fee;
  const qty = o.side === "BUY" ? (gross - fee) / o.price : gross / o.price;
  p.cash += o.side === "BUY" ? -gross : gross - fee;
  const left = o.side === "BUY" ? held + qty : held - qty;
  if (left > 1e-12) p.positions[o.symbol] = left;
  else delete p.positions[o.symbol];

  const trade: Trade = { time: now.toISOString(), symbol: o.symbol, side: o.side, qty, price: o.price, usdt: gross, fee, reason: o.reason };
  p.trades.push(trade);
  return trade;
}

export function recordEquity(p: Portfolio, prices: Record<string, number>, now = new Date()): void {
  p.history.push({ time: now.toISOString(), equity: equity(p, prices), cash: p.cash });
  if (p.history.length > MAX_HISTORY) p.history.shift();
}
