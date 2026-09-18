import { mkdir, readFile, writeFile } from "node:fs/promises";
import { backtest, type BacktestResult } from "./backtest.js";
import { judgeHeadlines, type Judgment } from "./brain.js";
import { placeMarketOrder } from "./broker.js";
import { config } from "./config.js";
import { fetchCandles, fetchHistory, startPriceFeed } from "./market.js";
import { fetchHeadlines } from "./news.js";
import { buy, close, equity, newPortfolio, recordEquity, stats, type Trade } from "./portfolio.js";
import { decide, type Decision } from "./strategy.js";

const STATE_FILE = "data/state.json";
const MAX_JUDGMENTS = 60;

export const state = {
  portfolio: newPortfolio(config.startCash),
  judgments: [] as Judgment[],
  prices: {} as Record<string, number>,
  closes: {} as Record<string, number[]>,
  signals: {} as Record<string, Decision>,
  feedAt: 0,
};

// Bus d'événements minimal : le serveur y abonne chaque client SSE
type Listener = (event: string, data: unknown) => void;
const listeners = new Set<Listener>();
const emit: Listener = (event, data) => listeners.forEach((fn) => fn(event, data));

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function persist(): Promise<void> {
  await mkdir("data", { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ portfolio: state.portfolio, judgments: state.judgments }));
}

// Miroir optionnel sur le testnet Binance ; un échec n'affecte jamais le portefeuille papier
function mirror(trade: Trade): void {
  if (!config.live) return;
  placeMarketOrder(trade.symbol, trade.side, trade.usdt * 0.98).catch((err: Error) => console.error(`testnet: ${err.message}`));
}

function act(d: Decision): void {
  if (d.action === "HOLD") return;
  // Exécution au prix temps réel ; le capital est réparti à parts égales entre les symboles
  const order = { symbol: d.symbol, price: state.prices[d.symbol] ?? d.price, fee: config.fee, reason: d.reason };
  const usdt = equity(state.portfolio, state.prices) / config.symbols.length;
  const trade = d.action === "BUY" ? buy(state.portfolio, { ...order, usdt }) : close(state.portfolio, order);
  if (!trade) return;
  console.log(`${trade.side} ${trade.symbol} ${trade.usdt.toFixed(2)} USDT @ ${trade.price} — ${trade.reason}`);
  mirror(trade);
  emit("trade", trade);
}

// Décision 100 % code sur les bougies clôturées ; Jev n'intervient que via le biais et le veto news
function decideAll(): void {
  for (const symbol of config.symbols) {
    const closes = state.closes[symbol];
    if (!closes) continue;
    const d = decide({ symbol, closes, judgments: state.judgments, position: state.portfolio.positions[symbol] });
    state.signals[symbol] = d;
    act(d);
  }
}

async function refreshCandles(): Promise<void> {
  const { interval, window } = config.strategy;
  await Promise.all(
    config.symbols.map(async (symbol) => {
      const candles = await fetchCandles(symbol, interval, window);
      // La dernière bougie renvoyée est encore en cours : on ne décide que sur des clôtures
      state.closes[symbol] = candles.slice(0, -1).map((c) => c.close);
      state.prices[symbol] ??= candles.at(-1)!.close;
    }),
  );
  decideAll();
}

// Jev ne juge que les titres jamais vus : chaque nouvelle news met à jour le biais en ~100 ms
async function refreshNews(): Promise<void> {
  const known = new Set(state.judgments.map((j) => j.headline.title));
  const fresh = (await fetchHeadlines()).filter((h) => !known.has(h.title));
  if (!fresh.length) return;
  const judged = await judgeHeadlines(fresh);
  state.judgments = [...judged, ...state.judgments]
    .sort((a, b) => b.headline.publishedAt.localeCompare(a.headline.publishedAt))
    .slice(0, MAX_JUDGMENTS);
  console.log(`Jev : ${judged.length} nouveau(x) titre(s) jugé(s)`);
  emit("news", state.judgments);
}

const safely = (task: () => Promise<unknown>) => task().catch((err) => console.error(err));

export async function start(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
    const positions = Object.values(saved.portfolio?.positions ?? {}) as { cost?: number }[];
    if (Array.isArray(saved.judgments) && positions.every((p) => p.cost !== undefined)) Object.assign(state, saved);
  } catch {}

  startPriceFeed(config.symbols, (symbol, price) => {
    state.prices[symbol] = price;
    state.feedAt = Date.now();
  });
  setInterval(() => emit("tick", live()), 1000);
  setInterval(() => recordEquity(state.portfolio, state.prices), 5000);
  setInterval(() => safely(persist), 15_000);
  setInterval(() => safely(refreshNews), config.newsEverySec * 1000);
  setInterval(() => safely(refreshCandles), config.candlesEverySec * 1000);

  await safely(refreshNews);
  await safely(refreshCandles);
}

export async function reset(): Promise<void> {
  state.portfolio = newPortfolio(config.startCash);
  recordEquity(state.portfolio, state.prices);
  decideAll();
  await persist();
  emit("reset", null);
}

// Backtest sur l'historique réel, mis en cache une heure ; même fonction `decide` que le live
let cached: { at: number; result: BacktestResult } | undefined;

export async function runBacktest(): Promise<BacktestResult> {
  if (cached && Date.now() - cached.at < 3_600_000) return cached.result;
  const entries = await Promise.all(config.symbols.map(async (s) => [s, await fetchHistory(s, config.strategy.interval, config.backtestYears)] as const));
  cached = { at: Date.now(), result: backtest(Object.fromEntries(entries)) };
  return cached.result;
}

// Instantané léger poussé chaque seconde
function live() {
  const p = state.portfolio;
  const total = equity(p, state.prices);
  return {
    time: Date.now(),
    feedOk: Date.now() - state.feedAt < 5000,
    prices: state.prices,
    signals: state.signals,
    equity: total,
    pnl: total - p.startCash,
    cash: p.cash,
    positions: Object.entries(p.positions).map(([symbol, pos]) => {
      const price = state.prices[symbol] ?? pos.entryPrice;
      return { symbol, ...pos, price, value: pos.qty * price, gain: price / pos.entryPrice - 1 };
    }),
    stats: stats(p),
  };
}

// État complet, chargé une fois à l'ouverture de la page puis après un reset
export function view() {
  const p = state.portfolio;
  return {
    config: { symbols: config.symbols, fee: config.fee, live: config.live, strategy: config.strategy, news: config.news, backtestYears: config.backtestYears },
    startedAt: p.startedAt,
    startCash: p.startCash,
    history: p.history,
    trades: p.trades,
    judgments: state.judgments,
    live: live(),
  };
}
