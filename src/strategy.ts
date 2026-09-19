import type { Judgment } from "./brain.js";
import { config, type Config } from "./config.js";
import type { Position } from "./portfolio.js";

type Action = "BUY" | "SELL" | "HOLD";
type Trend = "up" | "down" | "none";

export type Decision = {
  symbol: string;
  price: number;
  action: Action;
  trend: Trend;
  ema: number;
  buyAbove: number;
  sellBelow: number;
  news: number | null;
  headlinesUsed: number;
  reason: string;
};

type DecisionInput = {
  symbol: string;
  closes: number[];
  judgments: Judgment[];
  position?: Position;
  now?: number;
};

type StrategyConfig = Pick<Config, "strategy" | "news" | "quote">;

const pct = (ratio: number) => `${ratio >= 0 ? "+" : "−"}${Math.abs(ratio * 100).toFixed(1)} %`;

// Actif d'un symbole : BTC-EUR → BTC selon la devise de cotation configurée
export const baseOf = (symbol: string, quote: string): string => (symbol.endsWith(`-${quote}`) ? symbol.slice(0, -(quote.length + 1)) : symbol);

export function newsBias(judgments: Judgment[], base: string, now: number, cfg: StrategyConfig["news"]) {
  const relevant = judgments.filter((j) => (j.asset === base || j.asset === "crypto") && j.assetConfidence >= cfg.minConfidence);
  // Composite scoring : sentiment pondéré par materialité × confiance × fraîcheur (demi-vie)
  let sum = 0;
  let weights = 0;
  let regulatoryRisk = 0;
  for (const j of relevant) {
    const ageHours = Math.max(0, now - Date.parse(j.headline.publishedAt)) / 3_600_000;
    const freshness = 0.5 ** (ageHours / cfg.halfLifeHours);
    const w = j.material * j.sentimentConfidence * freshness;
    sum += j.sentiment * w;
    weights += w;
    regulatoryRisk = Math.max(regulatoryRisk, j.regulatoryRisk * freshness);
  }
  return { score: weights > 0 ? sum / weights : null, count: relevant.length, regulatoryRisk };
}

// Hystérésis : haussier au-dessus de EMA×(1+bande), baissier sous EMA×(1−bande) ; `tilt` (news) décale les seuils de la dernière bougie
export function trendRegime(closes: number[], strategy: { emaPeriod: number; band: number }, tilt = 0) {
  const k = 2 / (strategy.emaPeriod + 1);
  let ema = closes[0] ?? 0;
  let trend: Trend = "none";
  closes.forEach((close, i) => {
    if (i) ema = close * k + ema * (1 - k);
    if (i < strategy.emaPeriod) return;
    const shift = i === closes.length - 1 ? tilt : 0;
    if (close > ema * (1 + strategy.band - shift)) trend = "up";
    else if (close < ema * (1 - strategy.band - shift)) trend = "down";
  });
  return { trend: trend as Trend, ema, buyAbove: ema * (1 + strategy.band - tilt), sellBelow: ema * (1 - strategy.band - tilt) };
}

// `closes` = bougies clôturées uniquement : on ne décide jamais sur une bougie en cours
export function decide(input: DecisionInput, cfg: StrategyConfig = config): Decision {
  const { symbol, closes, position } = input;
  const s = cfg.strategy;
  const price = closes.at(-1) ?? 0;
  const news = newsBias(input.judgments, baseOf(symbol, cfg.quote), input.now ?? Date.now(), cfg.news);
  const regime = trendRegime(closes, s, s.newsTilt * (news.score ?? 0));
  const decision = (action: Action, reason: string): Decision => ({ symbol, price, action, ...regime, news: news.score, headlinesUsed: news.count, reason });

  if (closes.length < s.emaPeriod * 2) return decision("HOLD", `historique insuffisant (${closes.length} bougies)`);

  if (position) {
    const gain = pct(price / position.entryPrice - 1);
    if (regime.trend === "down") return decision("SELL", `tendance cassée : clôture sous le seuil de vente (${gain})`);
    return decision("HOLD", `en position, tendance haussière (${gain})`);
  }

  if (regime.trend !== "up") return decision("HOLD", "hors marché : pas de tendance haussière");
  // Règle séparée : un risque réglementaire récent et fort bloque toute entrée, quelle que soit la tendance
  if (news.regulatoryRisk >= cfg.news.regulatoryRisk) return decision("HOLD", `achat bloqué : risque réglementaire ${news.regulatoryRisk.toFixed(2)}`);
  return decision("BUY", "tendance haussière : clôture au-dessus du seuil d'achat");
}
