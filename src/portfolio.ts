import type { Side } from "./broker.js";

// `exitAt` : sortie programmée du circuit événementiel ; `exchangeQty` : quantité réellement détenue sur l'exchange (--live, --real)
export type Position = { symbol: string; qty: number; entryPrice: number; entryTime: string; cost: number; exitAt?: string; exchangeQty?: number };

export type Trade = {
  time: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  usdt: number;
  fee: number;
  reason: string;
  pnl?: number;
  exchangeQty?: number;
};

type EquityPoint = { time: string; equity: number };

type Portfolio = {
  startedAt: string;
  startCash: number;
  cash: number;
  // Clé = symbole pour la tendance, `event:<symbole>` pour le circuit événementiel : les deux livres ne se gênent pas
  positions: Record<string, Position>;
  trades: Trade[];
  history: EquityPoint[];
};

const MIN_NOTIONAL = 10;
const MAX_HISTORY = 5000;
const MAX_TRADES = 1000;

export function newPortfolio(startCash: number, now = new Date()): Portfolio {
  return { startedAt: now.toISOString(), startCash, cash: startCash, positions: {}, trades: [], history: [] };
}

export function equity(p: Portfolio, prices: Record<string, number>): number {
  return Object.values(p.positions).reduce((sum, pos) => sum + pos.qty * (prices[pos.symbol] ?? pos.entryPrice), p.cash);
}

function record(p: Portfolio, trade: Trade): Trade {
  p.trades.push(trade);
  if (p.trades.length > MAX_TRADES) p.trades.shift();
  return trade;
}

type Order = { symbol: string; price: number; fee: number; reason: string; book?: "event" };

const slot = (o: { symbol: string; book?: string }) => (o.book ? `${o.book}:${o.symbol}` : o.symbol);

// Achat papier au prix réel du moment, plafonné par le cash ; null si montant trop faible ou déjà en position
export function buy(p: Portfolio, o: Order & { usdt: number; exitAt?: string }, now = new Date()): Trade | null {
  const cost = Math.min(o.usdt, p.cash);
  if (cost < MIN_NOTIONAL || p.positions[slot(o)]) return null;
  const fee = cost * o.fee;
  const qty = (cost - fee) / o.price;
  p.cash -= cost;
  p.positions[slot(o)] = { symbol: o.symbol, qty, entryPrice: o.price, entryTime: now.toISOString(), cost, ...(o.exitAt ? { exitAt: o.exitAt } : {}) };
  return record(p, { time: now.toISOString(), symbol: o.symbol, side: "BUY", qty, price: o.price, usdt: cost, fee, reason: o.reason });
}

// Clôture toute la position ; le P&L est net des frais d'entrée et de sortie
export function close(p: Portfolio, o: Order, now = new Date()): Trade | null {
  const pos = p.positions[slot(o)];
  if (!pos) return null;
  const gross = pos.qty * o.price;
  const fee = gross * o.fee;
  p.cash += gross - fee;
  delete p.positions[slot(o)];
  return record(p, { time: now.toISOString(), symbol: o.symbol, side: "SELL", qty: pos.qty, price: o.price, usdt: gross, fee, reason: o.reason, pnl: gross - fee - pos.cost, exchangeQty: pos.exchangeQty });
}

export function recordEquity(p: Portfolio, prices: Record<string, number>, now = new Date()): void {
  p.history.push({ time: now.toISOString(), equity: equity(p, prices) });
  if (p.history.length > MAX_HISTORY) p.history.shift();
}

export function stats(p: Portfolio) {
  const closed = p.trades.filter((t) => t.pnl !== undefined);
  return {
    closed: closed.length,
    wins: closed.filter((t) => t.pnl! > 0).length,
    realized: closed.reduce((sum, t) => sum + t.pnl!, 0),
    fees: p.trades.reduce((sum, t) => sum + t.fee, 0),
  };
}
