import { describe, expect, it } from "vitest";
import { easternToIso, upsert, type Archive } from "../src/history.js";
import { headlineKey, type Headline } from "../src/news.js";

describe("easternToIso", () => {
  it("converts Fed timestamps from New York time to UTC, in summer and winter", () => {
    expect(easternToIso("9/16/2026 2:00:00 PM")).toBe("2026-09-16T18:00:00.000Z");
    expect(easternToIso("1/29/2025 2:00:00 PM")).toBe("2025-01-29T19:00:00.000Z");
  });
});

describe("upsert", () => {
  const from = new Date("2025-01-01T00:00:00.000Z");
  const fresh = (): { archive: Archive; index: Map<string, Headline> } => ({ archive: { captures: [], headlines: [], judgments: [] }, index: new Map() });
  const fomc = (over: Partial<Headline> = {}): Headline => ({ title: "FOMC statement", source: "Fed (communiqués)", publishedAt: "2025-06-18T18:00:00.000Z", ...over });

  it("adds a headline once and indexes it by title and date", () => {
    const { archive, index } = fresh();
    upsert(archive, index, fomc(), from);
    upsert(archive, index, fomc(), from);
    upsert(archive, index, fomc({ publishedAt: "2025-07-30T18:00:00.000Z" }), from);
    expect(archive.headlines).toHaveLength(2);
    expect(index.get(headlineKey(fomc()))).toBe(archive.headlines[0]);
  });

  it("completes a known headline with its body and link without overwriting them", () => {
    const { archive, index } = fresh();
    upsert(archive, index, fomc(), from);
    upsert(archive, index, fomc({ body: "The Committee decided to lower the target range.", link: "/news/a.htm" }), from);
    expect(archive.headlines).toHaveLength(1);
    expect(archive.headlines[0]).toMatchObject({ body: "The Committee decided to lower the target range.", link: "/news/a.htm" });
    upsert(archive, index, fomc({ body: "later and worse", link: "/news/b.htm" }), from);
    expect(archive.headlines[0]).toMatchObject({ body: "The Committee decided to lower the target range.", link: "/news/a.htm" });
  });

  it("skips untitled items and anything published before the window", () => {
    const { archive, index } = fresh();
    upsert(archive, index, fomc({ title: "" }), from);
    upsert(archive, index, fomc({ publishedAt: "2024-12-31T23:00:00.000Z" }), from);
    expect(archive.headlines).toEqual([]);
  });
});
