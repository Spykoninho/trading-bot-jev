import type { Judgment } from "./brain.js";
import { config, type Config } from "./config.js";
import type { Candle } from "./market.js";
import { buy, close, equity, newPortfolio, stats, type Trade } from "./portfolio.js";
import { decide } from "./strategy.js";

// Mesures d'une courbe d'equity : rendement total, pire creux, et les ratios annualisés usuels
export type CurveStats = { return: number; drawdown: number; cagr: number; sharpe: number; sortino: number; mar: number };
// Profil des allers-retours terminés, en rendement par opération
export type TradeProfile = { count: number; winRate: number; median: number; p10: number; p90: number; worst: number; top5Share: number };

export type BacktestResult = {
  times: number[];
  strategy: number[];
  hold: number[];
  trades: Trade[];
  stats: { strategy: CurveStats; hold: CurveStats; closed: number; wins: number; fees: number; profile: TradeProfile };
};

type BacktestConfig = Pick<Config, "strategy" | "news" | "quote" | "fee" | "slippageBps" | "startCash" | "eventReserve">;

const YEAR_MS = 365 * 86_400_000;
// Six bougies de 4 h par jour, 365 jours : base d'annualisation du Sharpe et du Sortino
const PERIODS_PER_YEAR = 6 * 365;

function maxDrawdown(curve: number[]): number {
  let peak = -Infinity;
  let worst = 0;
  for (const value of curve) {
    peak = Math.max(peak, value);
    worst = Math.max(worst, 1 - value / peak);
  }
  return worst;
}

const average = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const deviation = (values: number[], mean: number) => Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / Math.max(1, values.length - 1));

// Quantile par interpolation linéaire sur une série triée
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const low = Math.floor(pos);
  const high = Math.min(sorted.length - 1, low + 1);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (pos - low);
}

export function curveStats(curve: number[], times: number[], startCash: number): CurveStats {
  const returns = curve.slice(1).map((value, i) => value / curve[i]! - 1);
  const mean = average(returns);
  const sigma = deviation(returns, mean);
  // Sortino : seules les périodes perdantes comptent dans le dénominateur
  const downside = Math.sqrt(returns.reduce((sum, r) => sum + Math.min(0, r) ** 2, 0) / Math.max(1, returns.length - 1));
  const years = Math.max((times.at(-1)! - times[0]!) / YEAR_MS, 1 / PERIODS_PER_YEAR);
  const total = (curve.at(-1) ?? startCash) / startCash;
  const cagr = total > 0 ? total ** (1 / years) - 1 : -1;
  const drawdown = maxDrawdown(curve);
  const annualize = (denominator: number) => (denominator > 0 ? (mean / denominator) * Math.sqrt(PERIODS_PER_YEAR) : 0);
  return { return: total - 1, drawdown, cagr, sharpe: annualize(sigma), sortino: annualize(downside), mar: drawdown > 0 ? cagr / drawdown : 0 };
}

export function tradeProfile(trades: Trade[]): TradeProfile {
  const closed = trades.filter((t) => t.pnl !== undefined);
  // Rendement de l'opération : P&L net rapporté au capital engagé (le coût d'entrée, frais compris)
  const returns = closed.map((t) => t.pnl! / Math.max(1e-9, t.usdt - t.fee - t.pnl!)).sort((a, b) => a - b);
  const gains = closed.map((t) => t.pnl!).sort((a, b) => b - a);
  const totalGain = gains.reduce((sum, g) => sum + g, 0);
  const top5 = gains.slice(0, 5).reduce((sum, g) => sum + g, 0);
  return {
    count: closed.length,
    winRate: closed.length ? returns.filter((r) => r > 0).length / closed.length : 0,
    median: quantile(returns, 0.5),
    p10: quantile(returns, 0.1),
    p90: quantile(returns, 0.9),
    worst: returns[0] ?? 0,
    top5Share: totalGain > 0 ? top5 / totalGain : 0,
  };
}

// Rejoue `decide` bougie par bougie : décision à la clôture, exécution à l'ouverture suivante ; `judgments` triés par date
export function backtest(history: Record<string, Candle[]>, cfg: BacktestConfig = config, judgments: Judgment[] = []): BacktestResult {
  const symbols = Object.keys(history);
  const length = Math.min(...symbols.map((s) => history[s]!.length));
  const series = Object.fromEntries(symbols.map((s) => [s, history[s]!.slice(-length)]));
  const start = cfg.strategy.emaPeriod * 2;

  const portfolio = newPortfolio(cfg.startCash, new Date(series[symbols[0]!]![start]!.time));
  const first = Object.fromEntries(symbols.map((s) => [s, series[s]![start]!.open]));
  const share = (cfg.startCash / symbols.length) * (1 - cfg.fee);
  const result: BacktestResult = { times: [], strategy: [], hold: [], trades: portfolio.trades, stats: {} as BacktestResult["stats"] };

  const published = judgments.map((j) => Date.parse(j.headline.publishedAt));
  let from = 0;
  let to = 0;

  for (let i = start - 1; i < length - 1; i++) {
    const opens = Object.fromEntries(symbols.map((s) => [s, series[s]![i + 1]!.open]));
    const time = new Date(series[symbols[0]!]![i + 1]!.time);
    // Pas de regard vers le futur : un titre n'est visible qu'après la latence de lecture, et sur la fenêtre glissante du direct
    const seenAt = time.getTime() - cfg.news.latencyMs;
    while (to < published.length && published[to]! <= seenAt) to++;
    while (from < to && published[from]! < seenAt - cfg.news.windowMs) from++;
    const visible = judgments.slice(from, to);
    for (const symbol of symbols) {
      const closes = series[symbol]!.slice(Math.max(0, i + 1 - cfg.strategy.window), i + 1).map((c) => c.close);
      const decision = decide({ symbol, closes, judgments: visible, position: portfolio.positions[symbol], now: time.getTime() }, cfg);
      const order = { symbol, price: opens[symbol]!, fee: cfg.fee, slippageBps: cfg.slippageBps, reason: decision.reason };
      // Même dimensionnement que le direct : part égale de l'equity courante, réserve événementielle préservée
      const total = equity(portfolio, opens);
      if (decision.action === "BUY") buy(portfolio, { ...order, usdt: (total * (1 - cfg.eventReserve)) / symbols.length, floor: total * cfg.eventReserve }, time);
      else if (decision.action === "SELL") close(portfolio, order, time);
    }
    const closesNow = Object.fromEntries(symbols.map((s) => [s, series[s]![i + 1]!.close]));
    result.times.push(time.getTime());
    result.strategy.push(equity(portfolio, closesNow));
    result.hold.push(symbols.reduce((sum, s) => sum + (share * closesNow[s]!) / first[s]!, 0));
  }

  const totals = stats(portfolio);
  result.stats = {
    strategy: curveStats(result.strategy, result.times, cfg.startCash),
    hold: curveStats(result.hold, result.times, cfg.startCash),
    closed: totals.closed,
    wins: totals.wins,
    fees: totals.fees,
    profile: tradeProfile(portfolio.trades),
  };
  return result;
}
