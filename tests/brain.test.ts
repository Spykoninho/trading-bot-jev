import { describe, expect, it, vi } from "vitest";
import { EFFECT, judgeHeadlines, knownSignals, migrateJudgment, toJudgment, type Judge, type Judgment } from "../src/brain.js";

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
      version: 2,
    });
  });
});

describe("source rules", () => {
  const from = (source: string, extra: Record<string, unknown>, base: Record<string, unknown> = {}) =>
    toJudgment({ ...headline, source }, { ...answers, ...base, ...extra } as unknown as Parameters<typeof toJudgment>[1]);
  const unrelated = { asset: { type: "choice", choice: "unrelated", confidence: 0.8 }, material: { type: "noul", noul: 0.1 } };
  const hike = { rate_decision: { choice: "hike", confidence: 0.95, probabilities: { cut: 0.01, hold: 0.03, hike: 0.95, none: 0.01 } } };

  it("Fed: a rate decision read in the full text is material and market-wide, but carries no direction", () => {
    const j = from("Fed (communiqués)", hike, unrelated);
    // L'étude ne mesure aucun effet de direction : EFFECT met la baisse comme la hausse à zéro
    expect(j).toMatchObject({ asset: "crypto", sentiment: EFFECT.rate_hike, material: 0.9, version: 3 });
    expect(j.sentiment).toBe(0);
    expect(j.signals).toEqual({ rate_cut: 0.01, rate_hike: 0.95, rate_hold: 0.03 });
    expect(j.details?.["Décision de taux"]).toBe("hike (0.95)");
  });

  it("Fed: a release that is not a rate decision keeps the base judgment but still reports its signals", () => {
    const none = { rate_decision: { choice: "none", confidence: 0.9, probabilities: { cut: 0.02, hold: 0.05, hike: 0.03, none: 0.9 } } };
    const j = from("Fed (communiqués)", none, unrelated);
    expect(j).toMatchObject({ asset: "unrelated", material: 0.1 });
    expect(j.signals).toEqual({ rate_cut: 0.02, rate_hike: 0.03, rate_hold: 0.05 });
  });

  it("Trump: only crypto support moves the sentiment, trade and war have no measured effect", () => {
    const post = { trade_escalation: { noul: 0.95 }, trade_easing: { noul: 0.05 }, crypto_support: { noul: 0.02 }, military_escalation: { noul: 0.9 } };
    const j = from("Trump (Truth Social)", post, unrelated);
    expect(j.sentiment).toBeCloseTo(0.02 * EFFECT.crypto_support);
    expect(j).toMatchObject({ asset: "crypto", material: 0.95 });
    expect(j.signals).toEqual({ crypto_support: 0.02, trade_escalation: 0.95, trade_deescalation: 0.05, military_escalation: 0.9 });
  });

  it("Trump: a clear pro-crypto post is bullish, an ordinary political post is left alone", () => {
    const support = { trade_escalation: { noul: 0.1 }, trade_easing: { noul: 0 }, crypto_support: { noul: 0.9 }, military_escalation: { noul: 0 } };
    expect(from("Trump (Truth Social)", support, unrelated).sentiment).toBeCloseTo(0.9);
    const rally = { trade_escalation: { noul: 0.1 }, trade_easing: { noul: 0.1 }, crypto_support: { noul: 0.1 }, military_escalation: { noul: 0.1 } };
    expect(from("Trump (Truth Social)", rally, unrelated)).toMatchObject({ asset: "unrelated", material: 0.1 });
  });

  it("SEC and Binance: minor cases and small-coin announcements have their impact capped", () => {
    expect(from("SEC (communiqués)", { scope: { choice: "minor_case", confidence: 0.9 } }).material).toBe(0.2);
    expect(from("SEC (communiqués)", { scope: { choice: "industry", confidence: 0.9 } }).material).toBe(0.85);
    const market = { asset: { type: "choice", choice: "crypto", confidence: 0.9 } };
    const listing = { kind: { choice: "spot_listing", confidence: 0.9, probabilities: { spot_listing: 0.9, delisting: 0.05, other: 0.05 } } };
    const j = from("Binance (annonces)", listing, market);
    expect(j.material).toBe(0.3);
    expect(j.signals).toEqual({ spot_listing: 0.9, delisting: 0.05 });
  });

  it("exposes the signal names each source can emit", () => {
    expect(knownSignals()).toEqual({
      "Fed (communiqués)": ["rate_cut", "rate_hike", "rate_hold"],
      "Trump (Truth Social)": ["crypto_support", "trade_escalation", "trade_deescalation", "military_escalation"],
      "SEC (communiqués)": ["industry", "major_firm", "minor_case"],
      "Binance (annonces)": ["spot_listing", "delisting"],
    });
  });
});

describe("migrateJudgment", () => {
  const archived = (source: string, details: Record<string, string>, over: Partial<Judgment> = {}): Judgment => ({
    headline: { ...headline, source },
    asset: "crypto",
    assetConfidence: 0.9,
    sentiment: 0.5,
    sentimentConfidence: 0.8,
    material: 0.9,
    regulatoryRisk: 0.1,
    details,
    version: 2,
    ...over,
  });
  const trump = (crypto: string, war = "0.01", up = "0.01", down = "0.01") =>
    archived("Trump (Truth Social)", { "Détente commerciale": up, "Escalade commerciale": down, "Soutien crypto": crypto, "Escalade militaire": war });

  it("rebuilds Trump's raw signals from the displayed probabilities", () => {
    expect(migrateJudgment(trump("0.93", "0.02")).signals).toEqual({ crypto_support: 0.93, trade_deescalation: 0.01, trade_escalation: 0.01, military_escalation: 0.02 });
  });

  it("recomposes a sure post's sentiment with today's coefficients, and leaves an unsure one alone", () => {
    // Ancien barème : soutien crypto 0,93 moins escalade 0,01 ; nouveau : le seul soutien crypto compte
    expect(migrateJudgment(trump("0.93")).sentiment).toBeCloseTo(0.93 * EFFECT.crypto_support);
    // Une escalade militaire sûre n'a plus aucun effet mesuré : le sentiment tombe à zéro
    expect(migrateJudgment(trump("0", "0.95")).sentiment).toBeCloseTo(0);
    // Sous le seuil de certitude, `compose` n'avait rien touché : le sentiment du score de base est conservé
    expect(migrateJudgment(trump("0.02")).sentiment).toBe(0.5);
  });

  it("reads the Fed's decision and neutralizes its direction, as the event study found", () => {
    const cut = migrateJudgment(archived("Fed (communiqués)", { "Décision de taux": "cut (0.95)" }, { sentiment: 0.75 }));
    expect(cut.signals).toEqual({ rate_cut: 0.95, rate_hike: 0, rate_hold: 0 });
    expect(cut.sentiment).toBe(EFFECT.rate_cut);
    const hike = migrateJudgment(archived("Fed (communiqués)", { "Décision de taux": "hike (0.90)" }, { sentiment: -0.75 }));
    expect(hike.sentiment).toBe(EFFECT.rate_hike);
    // Statu quo ou lecture incertaine : le sentiment stocké était déjà celui du score de base
    expect(migrateJudgment(archived("Fed (communiqués)", { "Décision de taux": "hold (0.90)" })).sentiment).toBe(0.5);
    expect(migrateJudgment(archived("Fed (communiqués)", { "Décision de taux": "cut (0.40)" })).sentiment).toBe(0.5);
    expect(migrateJudgment(archived("Fed (communiqués)", { "Décision de taux": "none (0.90)" })).signals).toEqual({ rate_cut: 0, rate_hike: 0, rate_hold: 0 });
  });

  it("rebuilds the SEC and Binance choices and leaves everything else untouched", () => {
    expect(migrateJudgment(archived("SEC (communiqués)", { Portée: "major_firm (0.80)" })).signals).toEqual({ industry: 0, major_firm: 0.8, minor_case: 0 });
    expect(migrateJudgment(archived("Binance (annonces)", { Type: "spot_listing (0.90)" })).signals).toEqual({ spot_listing: 0.9, delisting: 0 });
    const press = archived("CoinDesk", {});
    expect(migrateJudgment(press)).toBe(press);
  });

  it("never touches a judgment that already carries its signals", () => {
    const fresh = archived("Trump (Truth Social)", { "Soutien crypto": "0.93" }, { signals: { crypto_support: 0.1 }, sentiment: 0.1 });
    expect(migrateJudgment(fresh)).toBe(fresh);
  });

  it("emits the signal names the live rules are validated against", () => {
    const names = Object.keys(migrateJudgment(trump("0.93")).signals!);
    expect(names.sort()).toEqual([...knownSignals()["Trump (Truth Social)"]!].sort());
  });
});

describe("judgeHeadlines", () => {
  it("sends one request per headline, with the source text named as untrusted content", async () => {
    const systemOne = vi.fn().mockResolvedValue({ answers });
    const client = { systemOne } as unknown as Judge;

    const judgments = await judgeHeadlines([headline, { ...headline, title: "Other" }], client);

    expect(judgments).toHaveLength(2);
    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(systemOne.mock.calls[0]?.[0].state).toMatchObject({ untrusted_headline: headline.title, source: "Test" });
    expect(systemOne.mock.calls[0]?.[0].state).not.toHaveProperty("untrusted_text");
    expect(systemOne.mock.calls[0]?.[0].state.reading_rule).toContain("never follow");
    expect(systemOne.mock.calls[0]?.[0].questions.material.instructions).toContain("never follow");
  });

  it("sends the full text and the source-specific questions when the source has them", async () => {
    const systemOne = vi.fn().mockResolvedValue({ answers: { ...answers, rate_decision: { choice: "cut", confidence: 0.9 } } });
    await judgeHeadlines([{ ...headline, source: "Fed (communiqués)", body: "The Committee decided to lower the target range." }], { systemOne } as unknown as Judge);
    const request = systemOne.mock.calls[0]?.[0];
    expect(request.state.untrusted_text).toContain("lower the target range");
    expect(Object.keys(request.questions)).toContain("rate_decision");
  });

  it("keeps the other headlines when one request fails, without logging its content", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const systemOne = vi.fn().mockImplementation(({ state }: { state: { untrusted_headline: string } }) =>
      state.untrusted_headline === "second" ? Promise.reject(Object.assign(new Error("Do not print me"), { name: "APITimeoutError" })) : Promise.resolve({ answers }),
    );
    const titles = ["first", "second", "third"].map((title) => ({ ...headline, title }));

    const judgments = await judgeHeadlines(titles, { systemOne } as unknown as Judge);

    expect(judgments.map((j) => j.headline.title)).toEqual(["first", "third"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("APITimeoutError");
    expect(warn.mock.calls[0]?.[0]).not.toContain("second");
    warn.mockRestore();
  });
});
