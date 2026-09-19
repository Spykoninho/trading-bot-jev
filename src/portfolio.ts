import type { Side } from "./broker.js";

// `exitAt` : sortie programmée du circuit événementiel ; `exchangeQty` : quantité réellement détenue sur Bitvavo (--real)
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

type EquityPoint = { time: string; equity: number; hold?: number };

// Cumuls tenus à part : le journal des ordres est tronqué, le bilan ne doit pas l'être
export type Totals = { closed: number; wins: number; realized: number; fees: number };

export type Portfolio = {
  startedAt: string;
  startCash: number;
  cash: number;
  // Clé = symbole pour la tendance, `event:<symbole>` pour le circuit événementiel : les deux livres ne se gênent pas
  positions: Record<string, Position>;
  trades: Trade[];
  history: EquityPoint[];
  totals: Totals;
  // Témoin « acheter et garder » : quantités figées au départ, jamais retouchées ensuite
  hold?: Record<string, number>;
};

export const MIN_NOTIONAL = 10;
// Un point par minute, gardé deux mois : de quoi couvrir une simulation longue sans faire enfler l'état
const MAX_HISTORY = 60 * 24 * 60;
const MAX_TRADES = 1000;

export const totalsFrom = (trades: Trade[]): Totals => ({
  closed: trades.filter((t) => t.pnl !== undefined).length,
  wins: trades.filter((t) => (t.pnl ?? 0) > 0).length,
  realized: trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0),
  fees: trades.reduce((sum, t) => sum + t.fee, 0),
});

export function newPortfolio(startCash: number, now = new Date()): Portfolio {
  return { startedAt: now.toISOString(), startCash, cash: startCash, positions: {}, trades: [], history: [], totals: { closed: 0, wins: 0, realized: 0, fees: 0 } };
}

export function equity(portfolio: Portfolio, prices: Record<string, number>): number {
  return Object.values(portfolio.positions).reduce((sum, pos) => sum + pos.qty * (prices[pos.symbol] ?? pos.entryPrice), portfolio.cash);
}

function record(portfolio: Portfolio, trade: Trade): Trade {
  portfolio.trades.push(trade);
  if (portfolio.trades.length > MAX_TRADES) portfolio.trades.shift();
  const totals = portfolio.totals;
  totals.fees += trade.fee;
  if (trade.pnl !== undefined) {
    totals.closed++;
    totals.realized += trade.pnl;
    if (trade.pnl > 0) totals.wins++;
  }
  return trade;
}

type Order = { symbol: string; price: number; fee: number; reason: string; book?: "event"; slippageBps?: number };

const slot = (order: { symbol: string; book?: string }) => (order.book ? `${order.book}:${order.symbol}` : order.symbol);

// Prix réellement obtenu : un ordre au marché se paie un peu au-dessus du dernier prix affiché, et se vend un peu en dessous
const fill = (price: number, side: Side, bps = 0) => price * (1 + (side === "BUY" ? bps : -bps) / 10_000);

// Achat papier au prix réel du moment, plafonné par le cash disponible au-dessus de `floor` ; null si montant trop faible ou déjà en position
export function buy(portfolio: Portfolio, order: Order & { usdt: number; exitAt?: string; floor?: number }, now = new Date()): Trade | null {
  const cost = Math.min(order.usdt, portfolio.cash - (order.floor ?? 0));
  if (cost < MIN_NOTIONAL || portfolio.positions[slot(order)]) return null;
  const price = fill(order.price, "BUY", order.slippageBps);
  const fee = cost * order.fee;
  const qty = (cost - fee) / price;
  portfolio.cash -= cost;
  portfolio.positions[slot(order)] = { symbol: order.symbol, qty, entryPrice: price, entryTime: now.toISOString(), cost, ...(order.exitAt ? { exitAt: order.exitAt } : {}) };
  return record(portfolio, { time: now.toISOString(), symbol: order.symbol, side: "BUY", qty, price, usdt: cost, fee, reason: order.reason });
}

// Clôture toute la position ; le P&L est net des frais d'entrée et de sortie
export function close(portfolio: Portfolio, order: Order, now = new Date()): Trade | null {
  const pos = portfolio.positions[slot(order)];
  if (!pos) return null;
  const price = fill(order.price, "SELL", order.slippageBps);
  const gross = pos.qty * price;
  const fee = gross * order.fee;
  portfolio.cash += gross - fee;
  delete portfolio.positions[slot(order)];
  return record(portfolio, { time: now.toISOString(), symbol: order.symbol, side: "SELL", qty: pos.qty, price, usdt: gross, fee, reason: order.reason, pnl: gross - fee - pos.cost, exchangeQty: pos.exchangeQty });
}

// Fige le témoin : tout le capital de départ réparti à parts égales, un seul achat, frais payés une fois
export function startHold(portfolio: Portfolio, fills: Record<string, number>, fee: number): void {
  const symbols = Object.keys(fills);
  if (portfolio.hold || !symbols.length || symbols.some((symbol) => !(fills[symbol]! > 0))) return;
  const share = portfolio.startCash / symbols.length;
  portfolio.hold = Object.fromEntries(symbols.map((symbol) => [symbol, (share * (1 - fee)) / fills[symbol]!]));
}

export function holdValue(portfolio: Portfolio, prices: Record<string, number>): number | undefined {
  if (!portfolio.hold) return undefined;
  const entries = Object.entries(portfolio.hold);
  if (entries.some(([symbol]) => !prices[symbol])) return undefined;
  return entries.reduce((sum, [symbol, qty]) => sum + qty * prices[symbol]!, 0);
}

export function recordEquity(portfolio: Portfolio, prices: Record<string, number>, now = new Date()): void {
  const hold = holdValue(portfolio, prices);
  portfolio.history.push({ time: now.toISOString(), equity: equity(portfolio, prices), ...(hold === undefined ? {} : { hold }) });
  if (portfolio.history.length > MAX_HISTORY) portfolio.history.shift();
}

export function stats(portfolio: Portfolio): Totals {
  return { ...portfolio.totals };
}
