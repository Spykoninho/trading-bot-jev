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
    });
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
  });
});
