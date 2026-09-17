import { describe, expect, it } from "vitest";
import { sma, techSignal, type Candle } from "../src/market.js";

const candles = (closes: number[]): Candle[] => closes.map((close, i) => ({ time: i, close }));

describe("sma", () => {
  it("averages the last `period` values", () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5);
  });
});

describe("techSignal", () => {
  it("is positive when price is above its SMA and bounded to [-1, 1]", () => {
    const flat = Array(47).fill(100);
    const up = techSignal(candles([...flat, 110]));
    expect(up.signal).toBe(1);
    expect(up.price).toBe(110);
    expect(up.change24h).toBeCloseTo(0.1);

    const down = techSignal(candles([...flat, 99]));
    expect(down.signal).toBeLessThan(0);
    expect(down.signal).toBeGreaterThan(-1);
  });

  it("is zero on a flat market", () => {
    expect(techSignal(candles(Array(48).fill(100))).signal).toBe(0);
  });
});
