import { describe, expect, it } from "vitest";
import type { Judgment } from "../src/brain.js";
import { groupsOf, klineKey, pValue, runStudy, summarize, welch, type Klines, type Prices } from "../src/event-study.js";

const KINDS = { "Trump (Truth Social)": "primaire", CoinDesk: "presse" };
const OPTS = { fee: 0.001, minConfidence: 0.5, kinds: KINDS };

// Deux heures d'écart entre les titres : au-delà de la fenêtre de déduplication de 30 min
const iso = (hour: number) => new Date(Date.UTC(2025, 5, 2, hour)).toISOString();

const judgment = (hour: number, over: Partial<Judgment> = {}): Judgment => ({
  headline: { title: `t${hour}`, source: "Trump (Truth Social)", publishedAt: iso(hour) },
  asset: "crypto",
  assetConfidence: 0.9,
  sentiment: 0.8,
  sentimentConfidence: 0.8,
  material: 0.9,
  regulatoryRisk: 0,
  signals: { crypto_support: 0.9 },
  ...over,
});

const dull = (hour: number) => judgment(hour, { material: 0.2, sentiment: 0, signals: {} });

// 301 bougies à la minute, de t0−60 à t0+240 : 99 avant la parution, 100 jusqu'à l'entrée, puis le saut mesuré
const series = (j: Judgment, jump: number): Prices => {
  const t0 = Math.floor(Date.parse(j.headline.publishedAt) / 60_000) * 60_000;
  return Array.from({ length: 301 }, (_, i) => {
    const min = i - 60;
    return [t0 + min * 60_000, min < 0 ? 99 : min <= 2 ? 100 : 100 * (1 + jump)] as [number, number];
  });
};

const klines = (pairs: [Judgment, number][]): Klines => Object.fromEntries(pairs.map(([j, jump]) => [klineKey(j), series(j, jump)]));

describe("summarize", () => {
  it("returns the count, the mean, the t statistic and a two-sided p", () => {
    expect(summarize([])).toEqual({ n: 0, mean: 0, t: 0, p: 1 });
    expect(summarize([0.01])).toEqual({ n: 1, mean: 0.01, t: 0, p: 1 });
    const s = summarize([0.02, 0.01, 0.03, 0]);
    expect(s.n).toBe(4);
    expect(s.mean).toBeCloseTo(0.015);
    expect(s.t).toBeCloseTo(2.324, 2);
    expect(s.p).toBeCloseTo(0.0201, 3);
  });

  it("gives a p close to the textbook values of the normal law", () => {
    expect(pValue(1.96)).toBeCloseTo(0.05, 3);
    expect(pValue(0)).toBe(1);
  });
});

describe("welch", () => {
  it("compares two means with unequal variances and sizes", () => {
    const d = welch([0.02, 0.03, 0.025], [0, 0.001, -0.001, 0.002]);
    expect(d.diff).toBeCloseTo(0.0245, 4);
    expect(d.t).toBeCloseTo(8.28, 1);
    expect(d.p).toBeLessThan(0.001);
    expect(welch([0.01], [0, 0.001])).toEqual({ n: 1, diff: 0, t: 0, p: 1 });
  });
});

describe("groupsOf", () => {
  it("builds the control group without dividing by zero when there is no strong event", () => {
    const only = [dull(1), dull(3)];
    expect(() => groupsOf(only, KINDS, 0.5)).not.toThrow();
    expect(groupsOf(only, KINDS, 0.5)["Témoin (titres anodins)"]).toEqual([]);
    expect(groupsOf([], KINDS, 0.5)["Témoin (titres anodins)"]).toEqual([]);
  });

  it("keeps a source subgroup when its measured effect is zero, so it stays testable", () => {
    const neutral = judgment(1, { sentiment: 0, signals: { trade_escalation: 0.9 } });
    expect(groupsOf([neutral], KINDS, 0.5)["Trump : escalade commerciale"]).toHaveLength(1);
    expect(groupsOf([neutral], KINDS, 0.5)["Fort impact, sources primaires"]).toEqual([]);
  });

  it("reads the machine-readable signals, not the display text", () => {
    const archived = judgment(1, { signals: undefined, details: { "Soutien crypto": "0.93" } });
    expect(groupsOf([archived], KINDS, 0.5)["Trump : soutien crypto"]).toEqual([]);
    expect(groupsOf([judgment(1)], KINDS, 0.5)["Trump : soutien crypto"]).toHaveLength(1);
  });
});

describe("runStudy", () => {
  const strong = [judgment(1), judgment(3), judgment(5), judgment(7)];
  const jumps = [0.02, 0.01, 0.03, 0];
  const controls = [dull(9), dull(11), dull(13), dull(15)];
  const cache = klines([...strong.map((j, i) => [j, jumps[i]!] as [Judgment, number]), ...controls.map((j) => [j, 0.01] as [Judgment, number])]);
  const results = runStudy([...strong, ...controls], cache, OPTS);
  const group = (name: string) => results.find((r) => r.group === name)!;

  it("measures the move after the entry, in the direction Jev predicted", () => {
    const primary = group("Fort impact, sources primaires");
    expect(primary.n).toBe(4);
    expect(primary.horizons["+5 min"]).toMatchObject({ n: 4 });
    expect(primary.horizons["+5 min"]!.mean).toBeCloseTo(0.015);
    // Entrée à +2 min, sortie à +1 h, deux fois les frais
    expect(primary.net.mean).toBeCloseTo(0.015 - 2 * OPTS.fee);
    expect(primary.horizons["+5 min"]!.p).toBeCloseTo(0.0201, 3);
  });

  it("measures the hour before publication from the published price, not from the entry", () => {
    expect(group("Fort impact, sources primaires").horizons["−60→0 (avant)"]!.mean).toBeCloseTo(100 / 99 - 1);
  });

  it("reaches the last horizon the cached window allows", () => {
    expect(group("Fort impact, sources primaires").horizons["+238 min"]).toMatchObject({ n: 4 });
  });

  it("flips the control direction one event out of two, so it does not measure the market drift", () => {
    const control = group("Témoin (titres anodins)");
    expect(control.n).toBe(4);
    // Quatre hausses de 1 %, prises alternativement à l'achat et à la vente
    expect(control.horizons["+5 min"]!.mean).toBeCloseTo(0);
    expect(control.horizons["+5 min"]!.n).toBe(4);
  });

  it("reports the gap to the control group at every horizon and net of fees", () => {
    const primary = group("Fort impact, sources primaires");
    expect(primary.vsControl["+5 min"]!.diff).toBeCloseTo(0.015);
    // Les frais sont les mêmes des deux côtés : ils s'annulent dans l'écart
    expect(primary.vsControl["net"]!.diff).toBeCloseTo(0.015);
    expect(group("Témoin (titres anodins)").vsControl["+5 min"]!.diff).toBeCloseTo(0);
  });

  it("skips the judgments whose candles are missing instead of counting them as zero", () => {
    const partial = runStudy([...strong, ...controls], klines([[strong[0]!, 0.02]]), OPTS);
    expect(partial.find((r) => r.group === "Fort impact, sources primaires")!.n).toBe(1);
  });
});
