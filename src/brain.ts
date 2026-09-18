import { TypeSafeClient, choice, noul, score, type SystemOneResult } from "@typesafe-ai/sdk";
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
};

// Une question = un jugement étroit ; toutes sont évaluées en parallèle sur le même state
export const questions = {
  // Choice : une option parmi un ensemble fermé, avec une probabilité par option
  asset: choice("Which asset is this crypto news headline mainly about?", {
    BTC: "Bitcoin specifically",
    ETH: "Ethereum specifically",
    SOL: "Solana specifically",
    crypto: "The crypto market in general, or another coin large enough to move the whole market",
    unrelated: "Not about crypto markets: sponsored content, tutorials, unrelated topics",
  }),
  // Score : niveaux ordonnés décrits par des situations concrètes, pas par des adjectifs
  sentiment: score("Expected impact of this headline on the price of the asset it concerns", [
    "Strongly bearish: hack, exchange collapse, ban, forced liquidations or a large sell-off",
    "Mildly bearish: negative outlook, regulatory pressure, outflows, delays or downgrades",
    "Neutral: price recap, opinion piece, or no clear direction",
    "Mildly bullish: adoption news, inflows, upgrades or positive analyst outlook",
    "Strongly bullish: major institutional adoption, ETF approval, favorable law or large treasury purchase",
  ]),
  // Noul : probabilité qu'une condition soit vraie (pas de confiance séparée)
  material: noul("Is this news likely to move the market price within the next day?", {
    true: "Concrete event: hack, regulation, ETF flows, large purchase, macro decision",
    false: "Opinion, price recap, sponsored content, tutorial or minor project update",
  }),
  regulatory_risk: noul("Does this headline report a regulatory or legal action hostile to crypto?"),
};

type Answers = SystemOneResult<typeof questions>["answers"];

export function toJudgment(headline: Headline, a: Answers): Judgment {
  return {
    headline,
    asset: a.asset.choice,
    assetConfidence: a.asset.confidence,
    // Score 0..4 ramené sur [-1, 1] : 2 = neutre
    sentiment: (a.sentiment.score - 2) / 2,
    sentimentConfidence: a.sentiment.confidence,
    material: a.material.noul,
    regulatoryRisk: a.regulatory_risk.noul,
  };
}

export type Judge = Pick<TypeSafeClient, "systemOne">;

// Une requête par titre : le state est un objet à champs nommés, comme le recommande la doc
export async function judgeHeadlines(headlines: Headline[], client: Judge = new TypeSafeClient()): Promise<Judgment[]> {
  return Promise.all(
    headlines.map(async (h) => {
      const res = await client.systemOne({
        state: { headline: h.title, source: h.source, published_at: h.publishedAt },
        questions,
      });
      return toJudgment(h, res.answers);
    }),
  );
}
