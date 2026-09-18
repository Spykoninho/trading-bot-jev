import { describe, expect, it, vi } from "vitest";
import { judgeHeadlines, toJudgment, type Judge } from "../src/brain.js";

const headline = { title: "SEC approves spot ETH ETF", source: "Test", publishedAt: "2025-09-15T10:00:00.000Z" };

const answers = {
  asset: { type: "choice", choice: "ETH", confidence: 0.9, probabilities: { BTC: 0.05, ETH: 0.9, crypto: 0.04, unrelated: 0.01 } },
  sentiment: { type: "score", score: 3.5, confidence: 0.7, legend: {}, probabilities: {} },
  material: { type: "noul", noul: 0.85 },
  regulatory_risk: { type: "noul", noul: 0.1 },
} as unknown as Parameters<typeof toJudgment>[1];

describe("toJudgment", () => {
  it("maps typed answers to a judgment, normalizing the score to [-1, 1]", () => {
    expect(toJudgment(headline, answers)).toEqual({
      headline,
      asset: "ETH",
      assetConfidence: 0.9,
      sentiment: 0.75,
      sentimentConfidence: 0.7,
      material: 0.85,
      regulatoryRisk: 0.1,
      version: 1,
    });
  });
});

describe("source rules", () => {
  const from = (source: string, extra: Record<string, unknown>, base: Record<string, unknown> = {}) =>
    toJudgment({ ...headline, source }, { ...answers, ...base, ...extra } as unknown as Parameters<typeof toJudgment>[1]);
  const unrelated = { asset: { type: "choice", choice: "unrelated", confidence: 0.8 }, material: { type: "noul", noul: 0.1 } };

  it("Fed: a rate hike read in the full text becomes a bearish, material, market-wide event", () => {
    const j = from("Fed (communiqués)", { rate_decision: { choice: "hike", confidence: 0.95 } }, unrelated);
    expect(j).toMatchObject({ asset: "crypto", sentiment: -0.75, material: 0.9, version: 2 });
    expect(j.details?.["Décision de taux"]).toBe("hike (0.95)");
  });

  it("Fed: a release that is not a rate decision keeps the base judgment", () => {
    expect(from("Fed (communiqués)", { rate_decision: { choice: "none", confidence: 0.9 } }, unrelated)).toMatchObject({ asset: "unrelated", material: 0.1 });
  });

  it("Trump: opposite trade signals in the same post cancel out instead of picking a side", () => {
    const post = { trade_escalation: { noul: 0.9 }, trade_easing: { noul: 0.9 }, crypto_support: { noul: 0.05 }, military_escalation: { noul: 0.02 } };
    const j = from("Trump (Truth Social)", post, unrelated);
    expect(j.sentiment).toBeCloseTo(0.03);
    expect(j).toMatchObject({ asset: "crypto", material: 0.9 });
  });

  it("Trump: a clear tariff pause is bullish, an ordinary political post is left alone", () => {
    const pause = { trade_escalation: { noul: 0.1 }, trade_easing: { noul: 0.9 }, crypto_support: { noul: 0 }, military_escalation: { noul: 0 } };
    expect(from("Trump (Truth Social)", pause, unrelated).sentiment).toBeCloseTo(0.8);
    const rally = { trade_escalation: { noul: 0.1 }, trade_easing: { noul: 0.1 }, crypto_support: { noul: 0.1 }, military_escalation: { noul: 0.1 } };
    expect(from("Trump (Truth Social)", rally, unrelated)).toMatchObject({ asset: "unrelated", material: 0.1 });
  });

  it("SEC and Binance: minor cases and small-coin announcements have their impact capped", () => {
    expect(from("SEC (communiqués)", { scope: { choice: "minor_case", confidence: 0.9 } }).material).toBe(0.2);
    expect(from("SEC (communiqués)", { scope: { choice: "industry", confidence: 0.9 } }).material).toBe(0.85);
    const market = { asset: { type: "choice", choice: "crypto", confidence: 0.9 } };
    expect(from("Binance (annonces)", { kind: { choice: "spot_listing", confidence: 0.9 } }, market).material).toBe(0.3);
  });
});

describe("judgeHeadlines", () => {
  it("sends one request per headline with the headline as named state", async () => {
    const systemOne = vi.fn().mockResolvedValue({ answers });
    const client = { systemOne } as unknown as Judge;

    const judgments = await judgeHeadlines([headline, { ...headline, title: "Other" }], client);

    expect(judgments).toHaveLength(2);
    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(systemOne.mock.calls[0]?.[0].state).toMatchObject({ headline: headline.title, source: "Test" });
    expect(systemOne.mock.calls[0]?.[0].state).not.toHaveProperty("full_text");
  });

  it("sends the full text and the source-specific questions when the source has them", async () => {
    const systemOne = vi.fn().mockResolvedValue({ answers: { ...answers, rate_decision: { choice: "cut", confidence: 0.9 } } });
    await judgeHeadlines([{ ...headline, source: "Fed (communiqués)", body: "The Committee decided to lower the target range." }], { systemOne } as unknown as Judge);
    const request = systemOne.mock.calls[0]?.[0];
    expect(request.state.full_text).toContain("lower the target range");
    expect(Object.keys(request.questions)).toContain("rate_decision");
  });
});
