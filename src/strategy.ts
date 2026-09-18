import type { Judgment } from "./brain.js";
import { config, type Config } from "./config.js";
import type { MarketSnapshot } from "./market.js";

export type Action = "BUY" | "SELL" | "HOLD";

export type Decision = {
  symbol: string;
  action: Action;
  score: number;
  newsScore: number | null;
  techSignal: number;
  headlinesUsed: number;
  reason: string;
};

type StrategyConfig = Pick<Config, "weights" | "thresholds">;

export function newsScore(judgments: Judgment[], base: string, minConfidence: number) {
  const relevant = judgments.filter(
    (j) => (j.asset === base || j.asset === "crypto") && j.assetConfidence >= minConfidence,
  );
  // Composite scoring : moyenne des sentiments pondérée par materialité × confiance du modèle
  let sum = 0;
  let weights = 0;
  for (const j of relevant) {
    const w = j.material * j.sentimentConfidence;
    sum += j.sentiment * w;
    weights += w;
  }
  return {
    score: weights > 0 ? sum / weights : null,
    count: relevant.length,
    regulatoryRisk: Math.max(0, ...relevant.map((j) => j.regulatoryRisk)),
  };
}

export function decide(market: MarketSnapshot, judgments: Judgment[], cfg: StrategyConfig = config): Decision {
  const base = market.symbol.replace("USDT", "");
  const news = newsScore(judgments, base, cfg.thresholds.minConfidence);
  const decision = (action: Action, score: number, reason: string): Decision => ({
    symbol: market.symbol,
    action,
    score,
    newsScore: news.score,
    techSignal: market.signal,
    headlinesUsed: news.count,
    reason,
  });

  // Confidence gating : pas assez d'évidence → on n'agit pas plutôt que de deviner
  if (news.score === null || news.count < cfg.thresholds.minHeadlines) {
    return decision("HOLD", 0, `seulement ${news.count} titre(s) pertinent(s)`);
  }

  const score = cfg.weights.news * news.score + cfg.weights.tech * market.signal;

  if (score >= cfg.thresholds.buy) {
    // Règle séparée du score : un risque réglementaire fort bloque tout achat
    if (news.regulatoryRisk >= cfg.thresholds.regulatoryRisk) {
      return decision("HOLD", score, `achat bloqué : risque réglementaire ${news.regulatoryRisk.toFixed(2)}`);
    }
    return decision("BUY", score, "score au-dessus du seuil d'achat");
  }
  if (score <= cfg.thresholds.sell) return decision("SELL", score, "score sous le seuil de vente");
  return decision("HOLD", score, "score dans la zone neutre");
}
