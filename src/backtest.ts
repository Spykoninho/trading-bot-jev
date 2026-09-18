import { config, type Config } from "./config.js";
import type { Candle } from "./market.js";
import { buy, close, equity, newPortfolio, stats, type Trade } from "./portfolio.js";
import { decide } from "./strategy.js";

export type BacktestResult = {
  times: number[];
  strategy: number[];
  hold: number[];
  trades: Trade[];
  stats: { strategyReturn: number; holdReturn: number; strategyDrawdown: number; holdDrawdown: number; closed: number; wins: number; fees: number };
};

type BacktestConfig = Pick<Config, "strategy" | "news" | "fee" | "startCash">;

function maxDrawdown(curve: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const value of curve) {
    peak = Math.max(peak, value);
    worst = Math.max(worst, 1 - value / peak);
  }
  return worst;
}

// Rejoue la décision du live bougie par bougie : décision à la clôture, exécution à l'ouverture suivante, frais inclus.
// Sans historique de news, le biais Jev vaut 0 : seul le volet prix de la stratégie est évalué.
export function backtest(history: Record<string, Candle[]>, cfg: BacktestConfig = config): BacktestResult {
  const symbols = Object.keys(history);
  const length = Math.min(...symbols.map((s) => history[s]!.length));
  const series = Object.fromEntries(symbols.map((s) => [s, history[s]!.slice(-length)]));
  const start = cfg.strategy.emaPeriod * 2;

  const p = newPortfolio(cfg.startCash, new Date(series[symbols[0]!]![start]!.time));
  const first = Object.fromEntries(symbols.map((s) => [s, series[s]![start]!.open]));
  const share = (cfg.startCash / symbols.length) * (1 - cfg.fee);
  const result: BacktestResult = { times: [], strategy: [], hold: [], trades: p.trades, stats: {} as BacktestResult["stats"] };

  for (let i = start - 1; i < length - 1; i++) {
    const opens = Object.fromEntries(symbols.map((s) => [s, series[s]![i + 1]!.open]));
    const time = new Date(series[symbols[0]!]![i + 1]!.time);
    for (const symbol of symbols) {
      const closes = series[symbol]!.slice(Math.max(0, i + 1 - cfg.strategy.window), i + 1).map((c) => c.close);
      const d = decide({ symbol, closes, judgments: [], position: p.positions[symbol], now: time.getTime() }, cfg);
      const order = { symbol, price: opens[symbol]!, fee: cfg.fee, reason: d.reason };
      if (d.action === "BUY") buy(p, { ...order, usdt: equity(p, opens) / symbols.length }, time);
      else if (d.action === "SELL") close(p, order, time);
    }
    const closesNow = Object.fromEntries(symbols.map((s) => [s, series[s]![i + 1]!.close]));
    result.times.push(time.getTime());
    result.strategy.push(equity(p, closesNow));
    result.hold.push(symbols.reduce((sum, s) => sum + (share * closesNow[s]!) / first[s]!, 0));
  }

  const s = stats(p);
  result.stats = {
    strategyReturn: result.strategy.at(-1)! / cfg.startCash - 1,
    holdReturn: result.hold.at(-1)! / cfg.startCash - 1,
    strategyDrawdown: maxDrawdown(result.strategy),
    holdDrawdown: maxDrawdown(result.hold),
    closed: s.closed,
    wins: s.wins,
    fees: s.fees,
  };
  return result;
}
