import type { Judgment } from "./brain.js";
import type { Source } from "./news.js";

// Test en direct : un titre est enregistré à l'instant où le bot le voit, le prix relevé ensuite, rien n'est rétro-calculé
const HORIZONS = [5, 15, 60, 240] as const;
type Horizon = (typeof HORIZONS)[number];

export type TrackedEvent = {
  judgment: Judgment;
  kind: Source["kind"];
  symbol: string;
  seenAt: string;
  latencySec: number;
  direction: 1 | -1;
  priceAtSeen: number;
  after: Partial<Record<Horizon, number>>;
};

// Au-delà, le titre était déjà dans le flux au démarrage du bot : il n'a pas été capté en direct, on ne le suit pas
const LIVE_LATENCY_SEC = 300;

// Un événement « marché crypto dans son ensemble » est mesuré sur le BTC
export const SYMBOL: Record<string, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", crypto: "BTCUSDT" };

// Fort impact : mêmes seuils en direct et dans l'étude sur l'historique
export const isStrong = (j: Judgment) => j.material >= 0.7 && Math.abs(j.sentiment) >= 0.5;

export function track(judgment: Judgment, kind: Source["kind"], prices: Record<string, number>, minConfidence: number, now = Date.now()): TrackedEvent | null {
  const symbol = SYMBOL[judgment.asset];
  const latencySec = Math.round((now - Date.parse(judgment.headline.publishedAt)) / 1000);
  if (!symbol || judgment.assetConfidence < minConfidence || !prices[symbol] || latencySec > LIVE_LATENCY_SEC) return null;
  return {
    judgment,
    kind,
    symbol,
    seenAt: new Date(now).toISOString(),
    latencySec,
    direction: judgment.sentiment >= 0 ? 1 : -1,
    priceAtSeen: prices[symbol]!,
    after: {},
  };
}

// Relevés arrivés à échéance et pas encore faits ; la minute doit être clôturée pour que Binance la renvoie
export function dueReadings(events: TrackedEvent[], now = Date.now()): { event: TrackedEvent; horizon: Horizon; at: number }[] {
  return events.flatMap((event) =>
    HORIZONS.filter((h) => event.after[h] === undefined)
      .map((horizon) => ({ event, horizon, at: Date.parse(event.seenAt) + horizon * 60_000 }))
      .filter((r) => r.at + 60_000 <= now),
  );
}

// Règle du circuit immédiat : une réponse de Jev à une question de source déclenche un achat à durée fixe
type EventRule = { name: string; source: string; detail: string; min: number; share: number; holdMin: number };

export const matchRule = (e: TrackedEvent, rules: EventRule[]) =>
  rules.find((r) => e.judgment.headline.source === r.source && Number(e.judgment.details?.[r.detail]) >= r.min);

// Rendement moyen dans le sens prédit par Jev, par horizon et par niveau d'impact
export function scoreboard(events: TrackedEvent[]) {
  const groups = { fort: events.filter((e) => isStrong(e.judgment)), autres: events.filter((e) => !isStrong(e.judgment)) };
  return {
    tracked: events.length,
    medianLatencySec: events.length ? [...events].sort((a, b) => a.latencySec - b.latencySec)[Math.floor(events.length / 2)]!.latencySec : null,
    groups: Object.fromEntries(
      Object.entries(groups).map(([name, group]) => [
        name,
        Object.fromEntries(
          HORIZONS.map((h) => {
            const returns = group.filter((e) => e.after[h] !== undefined).map((e) => e.direction * (e.after[h]! / e.priceAtSeen - 1));
            return [h, { n: returns.length, mean: returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null, wins: returns.filter((r) => r > 0).length }];
          }),
        ),
      ]),
    ),
  };
}
