import type { Judgment } from "./brain.js";
import { config, type Config } from "./config.js";
import { microSignal } from "./market.js";
import type { Position } from "./portfolio.js";

export type Action = "BUY" | "SELL" | "HOLD";

export type Decision = {
  symbol: string;
  price: number;
  action: Action;
  score: number;
  news: number | null;
  micro: number;
  headlinesUsed: number;
  reason: string;
};

export type DecisionInput = {
  symbol: string;
  prices: number[];
  judgments: Judgment[];
  position?: Position;
  lastExit?: number;
  now?: number;
};

type StrategyConfig = Pick<Config, "weights" | "micro" | "news">;

const pct = (ratio: number) => `${ratio >= 0 ? "+" : "−"}${Math.abs(ratio * 100).toFixed(2)} %`;

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

export function decide(input: DecisionInput, cfg: StrategyConfig = config): Decision {
  const { symbol, prices, position } = input;
  const now = input.now ?? Date.now();
  const m = cfg.micro;
  const price = prices.at(-1) ?? 0;
  const news = newsBias(input.judgments, symbol.replace("USDT", ""), now, cfg.news);
  const micro = microSignal(prices, m);
  // Sans news pertinente, le biais vaut 0 : le signal micro décide seul
  const score = cfg.weights.news * (news.score ?? 0) + cfg.weights.tech * micro;
  const decision = (action: Action, reason: string): Decision => ({ symbol, price, action, score, news: news.score, micro, headlinesUsed: news.count, reason });

  if (prices.length < m.slow) return decision("HOLD", `collecte des prix (${prices.length}/${m.slow} s)`);

  if (position) {
    // Sorties gérées en code : objectif, stop-loss, durée max, puis retournement du signal
    const gain = price / position.entryPrice - 1;
    const heldSec = (now - Date.parse(position.entryTime)) / 1000;
    if (gain >= m.takeProfit) return decision("SELL", `objectif atteint (${pct(gain)})`);
    if (gain <= -m.stopLoss) return decision("SELL", `stop-loss (${pct(gain)})`);
    if (heldSec >= m.maxHoldSec) return decision("SELL", `durée max atteinte (${pct(gain)})`);
    if (score <= m.exit) return decision("SELL", `signal retourné (${pct(gain)})`);
    return decision("HOLD", `en position depuis ${Math.round(heldSec)} s (${pct(gain)})`);
  }

  if (input.lastExit && now - input.lastExit < m.cooldownSec * 1000) return decision("HOLD", "pause après une vente");
  if (score < m.enter) return decision("HOLD", "pas de signal d'entrée");
  // Règle séparée du score : un risque réglementaire récent et fort bloque toute entrée
  if (news.regulatoryRisk >= cfg.news.regulatoryRisk) return decision("HOLD", `achat bloqué : risque réglementaire ${news.regulatoryRisk.toFixed(2)}`);
  return decision("BUY", "signal d'entrée");
}
