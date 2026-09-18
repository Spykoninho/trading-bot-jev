import type { Judgment } from "./brain.js";
import { config, type Config } from "./config.js";
import type { Position } from "./portfolio.js";

export type Action = "BUY" | "SELL" | "HOLD";
export type Trend = "up" | "down" | "none";

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

export type DecisionInput = {
  symbol: string;
  closes: number[];
  judgments: Judgment[];
  position?: Position;
  now?: number;
};

type StrategyConfig = Pick<Config, "strategy" | "news">;

const pct = (ratio: number) => `${ratio >= 0 ? "+" : "−"}${Math.abs(ratio * 100).toFixed(1)} %`;

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

// Tendance avec hystérésis : haussière au-dessus de EMA×(1+bande), baissière sous EMA×(1−bande), inchangée entre les deux.
// `tilt` décale les seuils de la dernière bougie seulement : des news positives font entrer plus tôt et sortir plus tard.
export function trendRegime(closes: number[], s: { emaPeriod: number; band: number }, tilt = 0) {
  const k = 2 / (s.emaPeriod + 1);
  let ema = closes[0] ?? 0;
  let trend: Trend = "none";
  closes.forEach((close, i) => {
    if (i) ema = close * k + ema * (1 - k);
    if (i < s.emaPeriod) return;
    const shift = i === closes.length - 1 ? tilt : 0;
    if (close > ema * (1 + s.band - shift)) trend = "up";
    else if (close < ema * (1 - s.band - shift)) trend = "down";
  });
  return { trend: trend as Trend, ema, buyAbove: ema * (1 + s.band - tilt), sellBelow: ema * (1 - s.band - tilt) };
}

// `closes` = bougies clôturées uniquement : on ne décide jamais sur une bougie en cours
export function decide(input: DecisionInput, cfg: StrategyConfig = config): Decision {
  const { symbol, closes, position } = input;
  const s = cfg.strategy;
  const price = closes.at(-1) ?? 0;
  const news = newsBias(input.judgments, symbol.replace("USDT", ""), input.now ?? Date.now(), cfg.news);
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
