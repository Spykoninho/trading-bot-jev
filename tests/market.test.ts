import { describe, expect, it } from "vitest";
import { ema, microSignal } from "../src/market.js";

const m = { fast: 10, slow: 60, saturation: 0.0004 };

describe("ema", () => {
  it("stays on a constant series and leans toward recent values", () => {
    expect(ema([5, 5, 5], 2)).toBe(5);
    expect(ema([1, 1, 1, 10], 3)).toBeGreaterThan(ema([10, 1, 1, 1], 3));
  });
});

describe("microSignal", () => {
  it("is zero until enough samples are collected, and on a flat market", () => {
    expect(microSignal(Array(30).fill(100), m)).toBe(0);
    expect(microSignal(Array(200).fill(100), m)).toBe(0);
  });

  it("is positive on a fresh rise, negative on a fresh drop, bounded to [-1, 1]", () => {
    const flat = Array(180).fill(100);
    const rise = [...flat, ...Array.from({ length: 15 }, (_, i) => 100 + (i + 1) * 0.02)];
    const drop = [...flat, ...Array.from({ length: 15 }, (_, i) => 100 - (i + 1) * 0.02)];
    expect(microSignal(rise, m)).toBe(1);
    expect(microSignal(drop, m)).toBe(-1);

    const slight = [...flat, 100.005, 100.01];
    expect(microSignal(slight, m)).toBeGreaterThan(0);
    expect(microSignal(slight, m)).toBeLessThan(1);
  });
});
