import { mkdir, readFile, writeFile } from "node:fs/promises";
import { judgeHeadlines, type Judgment } from "./brain.js";
import { placeMarketOrder } from "./broker.js";
import { config } from "./config.js";
import { fetchPrices, marketSnapshot, type MarketSnapshot } from "./market.js";
import { fetchHeadlines } from "./news.js";
import { applyOrder, equity, newPortfolio, recordEquity } from "./portfolio.js";
import { decide, type Decision } from "./strategy.js";

export type ExecutedDecision = Decision & { price: number; result: string };
export type CycleRecord = { time: string; markets: MarketSnapshot[]; judgments: Judgment[]; decisions: ExecutedDecision[] };

const STATE_FILE = "data/state.json";
const MAX_CYCLES = 100;

export const state = {
  portfolio: newPortfolio(config.startCash),
  cycles: [] as CycleRecord[],
  prices: {} as Record<string, number>,
  running: false,
};

export async function init(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(STATE_FILE, "utf8"));
    state.portfolio = saved.portfolio;
    state.cycles = saved.cycles;
  } catch {}
}

// Jugements bruts conservés : la stratégie peut être rejouée avec d'autres poids sans rappeler Jev
async function persist(): Promise<void> {
  await mkdir("data", { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ portfolio: state.portfolio, cycles: state.cycles }));
}

// Tick léger : prix + courbe d'équité, sans appel à Jev
export async function tick(): Promise<void> {
  state.prices = await fetchPrices(config.symbols);
  recordEquity(state.portfolio, state.prices);
  await persist();
}

async function execute(d: Decision, price: number): Promise<string> {
  if (d.action === "HOLD") return "-";
  const held = (state.portfolio.positions[d.symbol] ?? 0) * price;
  // Gestion du risque en code : une position max par actif, et SELL clôture toute la position
  if (d.action === "BUY" && held >= config.orderUsdt / 2) return "ignoré : déjà en position";
  const usdt = d.action === "BUY" ? config.orderUsdt : Infinity;
  const trade = applyOrder(state.portfolio, { symbol: d.symbol, side: d.action, usdt, price, fee: config.fee, reason: d.reason });
  if (!trade) return d.action === "SELL" ? "ignoré : aucune position" : "ignoré : cash insuffisant";

  let result = `${trade.side === "BUY" ? "achat" : "vente"} de ${trade.qty.toFixed(6)} pour ${trade.usdt.toFixed(2)} USDT`;
  if (config.live) {
    const mirrored = await placeMarketOrder(d.symbol, trade.side, trade.usdt * 0.98).catch((e: Error) => e);
    result += mirrored instanceof Error ? ` · testnet KO (${mirrored.message})` : ` · testnet #${mirrored.orderId} ${mirrored.status}`;
  }
  return result;
}

export async function cycle(): Promise<CycleRecord> {
  if (state.running) throw new Error("cycle already running");
  state.running = true;
  try {
    const [markets, headlines] = await Promise.all([Promise.all(config.symbols.map(marketSnapshot)), fetchHeadlines()]);
    const judgments = await judgeHeadlines(headlines);

    const decisions: ExecutedDecision[] = [];
    for (const market of markets) {
      const d = decide(market, judgments);
      decisions.push({ ...d, price: market.price, result: await execute(d, market.price) });
      state.prices[market.symbol] = market.price;
    }

    const record = { time: new Date().toISOString(), markets, judgments, decisions };
    state.cycles.push(record);
    if (state.cycles.length > MAX_CYCLES) state.cycles.shift();
    recordEquity(state.portfolio, state.prices);
    await persist();
    return record;
  } finally {
    state.running = false;
  }
}

export async function reset(): Promise<void> {
  state.portfolio = newPortfolio(config.startCash);
  state.cycles = [];
  await tick();
}

export function view() {
  const p = state.portfolio;
  const total = equity(p, state.prices);
  return {
    config: {
      symbols: config.symbols,
      intervalMin: config.intervalMin,
      orderUsdt: config.orderUsdt,
      live: config.live,
      thresholds: config.thresholds,
    },
    running: state.running,
    prices: state.prices,
    portfolio: {
      startedAt: p.startedAt,
      startCash: p.startCash,
      cash: p.cash,
      equity: total,
      pnl: total - p.startCash,
      positions: Object.entries(p.positions).map(([symbol, qty]) => ({
        symbol,
        qty,
        price: state.prices[symbol] ?? 0,
        value: qty * (state.prices[symbol] ?? 0),
      })),
    },
    history: p.history,
    trades: p.trades,
    cycles: state.cycles.slice(-30).reverse(),
  };
}
