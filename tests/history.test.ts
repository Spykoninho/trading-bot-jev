import { describe, expect, it } from "vitest";
import { easternToIso } from "../src/history.js";

describe("easternToIso", () => {
  it("converts Fed timestamps from New York time to UTC, in summer and winter", () => {
    expect(easternToIso("9/16/2026 2:00:00 PM")).toBe("2026-09-16T18:00:00.000Z");
    expect(easternToIso("1/29/2025 2:00:00 PM")).toBe("2025-01-29T19:00:00.000Z");
  });
});
