import { TypeSafeClient, choice, noul, score, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import type { Headline } from "./news.js";

export type Asset = "BTC" | "ETH" | "SOL" | "crypto" | "unrelated";

export type Judgment = {
  headline: Headline;
  asset: Asset;
  assetConfidence: number;
  sentiment: number;
  sentimentConfidence: number;
  material: number;
  regulatoryRisk: number;
  // Réponses aux questions propres à la source, pour l'affichage
  details?: Record<string, string>;
  version?: number;
};

// Une question = un jugement étroit ; toutes sont évaluées en parallèle sur le même state
export const questions = {
  // Choice : une option parmi un ensemble fermé, avec une probabilité par option
  // `crypto` couvre aussi la macro et la politique : les sources primaires (Fed, SEC, Trump) ne parlent pas toujours de crypto
  asset: choice("Which asset is this news item mainly about?", {
    BTC: "Bitcoin specifically",
    ETH: "Ethereum specifically",
    SOL: "Solana specifically",
    crypto: "The crypto market as a whole: general crypto news, another major coin, or a macro or political event likely to move all crypto prices (central bank decision, tariffs, war, major financial regulation)",
    unrelated: "No plausible effect on crypto prices: sponsored content, tutorials, unrelated politics or topics",
  }),
  // Score : niveaux ordonnés décrits par des situations concrètes, pas par des adjectifs
  sentiment: score("Expected impact of this news item on the price of the asset it concerns", [
    "Strongly bearish: hack, exchange collapse, ban, forced liquidations, a large sell-off, or a macro shock such as new tariffs or a surprise rate hike",
    "Mildly bearish: negative outlook, regulatory pressure, outflows, delays or downgrades",
    "Neutral: price recap, opinion piece, or no clear direction",
    "Mildly bullish: adoption news, inflows, upgrades or positive analyst outlook",
    "Strongly bullish: major institutional adoption, ETF approval, favorable law, large treasury purchase, or a macro boost such as a surprise rate cut",
  ]),
  // Noul : probabilité qu'une condition soit vraie (pas de confiance séparée)
  material: noul("Is this news likely to move the market price within the next day?", {
    true: "Concrete event: hack, regulation, ETF flows, large purchase, macro decision",
    false: "Opinion, price recap, sponsored content, tutorial or minor project update",
  }),
  regulatory_risk: noul("Does this news item report a regulatory or legal action hostile to crypto?"),
};

type Base = Omit<Judgment, "headline" | "details" | "version">;
type Extra = { choice?: string; confidence?: number; noul?: number };
type SourceRule = { questions: Questions; compose: (base: Base, a: Record<string, Extra>) => Partial<Base> & { details: Record<string, string> } };

const SURE = 0.6;
const clamp = (n: number) => Math.max(-1, Math.min(1, n));
const p = (n = 0) => n.toFixed(2);

// Fan-out spéculatif : chaque source primaire ajoute ses propres questions, posées dans la même requête.
// Le modèle répond à tout ; c'est le code qui décide comment ces réponses corrigent sentiment et impact.
export const SOURCE_RULES: Record<string, SourceRule> = {
  "Fed (communiqués)": {
    questions: {
      rate_decision: choice("What does this Federal Reserve release decide about the target range for the federal funds rate?", {
        cut: "It lowers the target range",
        hold: "It keeps the target range unchanged",
        hike: "It raises the target range",
        none: "It is not a rate decision: supervision, regulation, personnel, research or other topics",
      }),
    },
    compose: (base, a) => {
      const { choice: decision = "none", confidence = 0 } = a.rate_decision ?? {};
      const details = { "Décision de taux": `${decision} (${p(confidence)})` };
      if (decision === "none" || confidence < SURE) return { details };
      // Une baisse de taux soutient les actifs risqués, une hausse les pénalise ; un statu quo garde le ton jugé par `sentiment`
      const sentiment = decision === "cut" ? 0.75 : decision === "hike" ? -0.75 : base.sentiment;
      return { details, asset: "crypto", assetConfidence: confidence, sentiment, material: Math.max(base.material, decision === "hold" ? 0.5 : 0.9) };
    },
  },
  "Trump (Truth Social)": {
    questions: {
      trade_escalation: noul("Does this post announce or threaten new or higher tariffs, sanctions or trade restrictions?"),
      trade_easing: noul("Does this post announce a pause, reduction, exemption or deal that lowers tariffs or trade tensions?"),
      crypto_support: noul("Does this post announce or promote a policy favorable to crypto (strategic reserve, deregulation, pro-crypto appointments or laws)?"),
      military_escalation: noul("Does this post announce a military strike, a war escalation or a serious threat of armed conflict?"),
    },
    compose: (base, a) => {
      const [up, down, crypto, war] = [a.trade_easing?.noul ?? 0, a.trade_escalation?.noul ?? 0, a.crypto_support?.noul ?? 0, a.military_escalation?.noul ?? 0];
      const details = { "Détente commerciale": p(up), "Escalade commerciale": p(down), "Soutien crypto": p(crypto), "Escalade militaire": p(war) };
      const strongest = Math.max(up, down, crypto, war);
      if (strongest < SURE) return { details };
      // Un post peut annoncer à la fois une hausse et une pause : les signaux opposés s'annulent plutôt que de trancher au hasard
      return { details, asset: base.asset === "unrelated" ? "crypto" : base.asset, assetConfidence: Math.max(base.assetConfidence, strongest), sentiment: clamp(up + crypto - down - war), material: Math.max(base.material, strongest) };
    },
  },
  "SEC (communiqués)": {
    questions: {
      scope: choice("What is the scope of this SEC release for the crypto industry?", {
        industry: "A rule, exemption, ETF decision or policy that affects the whole crypto industry",
        major_firm: "An enforcement action or settlement involving a major crypto exchange, issuer or well-known crypto company",
        minor_case: "An enforcement action against a small firm or individuals: fraud, Ponzi scheme, insider trading, misleading investors",
        not_crypto: "Not related to crypto",
      }),
    },
    compose: (base, a) => {
      const { choice: scope = "not_crypto", confidence = 0 } = a.scope ?? {};
      const details = { Portée: `${scope} (${p(confidence)})` };
      // Les poursuites contre de petits acteurs ne bougent pas le marché : on plafonne leur impact
      return scope === "minor_case" || scope === "not_crypto" ? { details, material: Math.min(base.material, 0.2) } : { details };
    },
  },
  "Binance (annonces)": {
    questions: {
      kind: choice("What kind of Binance announcement is this?", {
        spot_listing: "A new coin is listed for spot trading",
        delisting: "A coin or trading pair is removed",
        other: "Futures, margin, earn products, maintenance or anything else",
      }),
    },
    compose: (base, a) => {
      const details = { Type: `${a.kind?.choice ?? "other"} (${p(a.kind?.confidence)})` };
      // Ces annonces concernent la crypto listée, pas BTC, ETH ou SOL : sans actif précis, l'impact est plafonné
      return base.asset === "crypto" ? { details, material: Math.min(base.material, 0.3) } : { details };
    },
  },
};

// Les jugements d'archive antérieurs à ces règles portent la version 1 : history.ts les refait
export const judgeVersion = (source: string) => (SOURCE_RULES[source] ? 2 : 1);

type Answers = SystemOneResult<typeof questions>["answers"];

export function toJudgment(headline: Headline, answers: Answers & Record<string, Extra>): Judgment {
  const base: Base = {
    asset: answers.asset.choice,
    assetConfidence: answers.asset.confidence,
    // Score 0..4 ramené sur [-1, 1] : 2 = neutre
    sentiment: (answers.sentiment.score - 2) / 2,
    sentimentConfidence: answers.sentiment.confidence,
    material: answers.material.noul,
    regulatoryRisk: answers.regulatory_risk.noul,
  };
  const rule = SOURCE_RULES[headline.source];
  return { headline, ...base, ...rule?.compose(base, answers), version: judgeVersion(headline.source) };
}

export type Judge = Pick<TypeSafeClient, "systemOne">;

// Une requête par titre : le state est un objet à champs nommés, avec le texte complet quand la source le fournit
export async function judgeHeadlines(headlines: Headline[], client: Judge = new TypeSafeClient()): Promise<Judgment[]> {
  return Promise.all(
    headlines.map(async (h) => {
      const res = await client.systemOne({
        state: { headline: h.title, ...(h.body ? { full_text: h.body } : {}), source: h.source, published_at: h.publishedAt },
        questions: { ...questions, ...SOURCE_RULES[h.source]?.questions },
      });
      return toJudgment(h, res.answers as unknown as Answers & Record<string, Extra>);
    }),
  );
}
