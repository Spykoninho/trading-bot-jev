import { config } from "./config.js";

export type Candle = { time: number; open: number; high: number; low: number; close: number };

export const INTERVALS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 } as const;
export type Interval = keyof typeof INTERVALS;

// Bitvavo plafonne chaque réponse à 1440 bougies
export const MAX_LIMIT = 1440;

type Row = [number, string, string, string, string, string];

// Bitvavo renvoie de la plus récente à la plus ancienne : on remet dans l'ordre chronologique
function toCandles(rows: Row[]): Candle[] {
  return rows
    .map(([time, open, high, low, close]) => ({ time, open: Number(open), high: Number(high), low: Number(low), close: Number(close) }))
    .sort((a, b) => a.time - b.time);
}

// Bougies réelles depuis l'API publique Bitvavo (sans clé) ; la dernière est encore en cours
// `end` borne la fenêtre vers le passé : Bitvavo ignore un `start` envoyé seul
export async function fetchCandles(symbol: string, interval: Interval, limit = 300, end?: number): Promise<Candle[]> {
  const url = `${config.bitvavo.rest}/${symbol}/candles?interval=${interval}&limit=${Math.min(limit, MAX_LIMIT)}${end ? `&end=${end}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bitvavo candles ${symbol} ${interval} : HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  return toCandles((await res.json()) as Row[]);
}

// Une bougie précise : Bitvavo n'en renvoie aucune pour une minute sans transaction, on prend donc la dernière avant `at`
export async function fetchCandleAt(symbol: string, interval: Interval, at: number, lookbackMs = 600_000): Promise<Candle | undefined> {
  const step = INTERVALS[interval] * 1000;
  const url = `${config.bitvavo.rest}/${symbol}/candles?interval=${interval}&start=${at - lookbackMs}&end=${at + step}&limit=${MAX_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Bitvavo candles ${symbol} ${interval} : HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
  return toCandles((await res.json()) as Row[])
    .filter((c) => c.time <= at)
    .at(-1);
}

// Historique long pour le backtest : l'API plafonne à 1440 bougies, on remonte le temps page par page
export async function fetchHistory(symbol: string, interval: Interval, years: number): Promise<Candle[]> {
  const step = INTERVALS[interval] * 1000;
  const floor = Date.now() - years * 365 * 86_400_000;
  const out: Candle[] = [];
  let end: number | undefined;
  for (;;) {
    const page = await fetchCandles(symbol, interval, MAX_LIMIT, end);
    if (!page.length) break;
    out.unshift(...page);
    if (page[0]!.time <= floor) break;
    // La page suivante s'arrête juste avant la plus ancienne bougie déjà reçue
    end = page[0]!.time;
  }
  // Doublons possibles aux jointures, et la dernière bougie n'est pas clôturée
  const unique = [...new Map(out.filter((c) => c.time >= floor).map((c) => [c.time, c])).values()];
  return unique.sort((a, b) => a.time - b.time).slice(0, -1);
}

export const RECONNECT = { min: 1000, max: 30_000 };

// Reconnexion : délai doublé à chaque échec puis plafonné, avec jitter pour ne pas retomber tous en même temps
export function reconnectDelay(attempt: number, random = Math.random): number {
  return Math.round(Math.min(RECONNECT.min * 2 ** attempt, RECONNECT.max) * (0.5 + random() / 2));
}

type Ticker24h = { event: string; data?: { market: string; last?: string; bid?: string; ask?: string }[] };

// Milieu du carnet plutôt que dernier échange : sur un marché peu traité, `last` peut rester figé plusieurs minutes
export const tickerPrice = ({ last, bid, ask }: { last?: string; bid?: string; ask?: string }): number | null => {
  const [b, a] = [Number(bid), Number(ask)];
  if (b > 0 && a >= b) return (a + b) / 2;
  return Number(last) > 0 ? Number(last) : null;
};

// Flux temps réel : le canal ticker24h de Bitvavo pousse le carnet de chaque marché environ une fois par seconde
export function startPriceFeed(symbols: string[], onPrice: (symbol: string, price: number) => void, onStatus?: (up: boolean, detail: string) => void): void {
  let attempt = 0;
  const connect = () => {
    const ws = new WebSocket(config.bitvavo.ws);
    ws.onopen = () => ws.send(JSON.stringify({ action: "subscribe", channels: [{ name: "ticker24h", markets: symbols }] }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as Ticker24h;
      if (message.event !== "ticker24h") return;
      if (attempt) onStatus?.(true, "flux de prix rétabli");
      attempt = 0; // le flux répond : le backoff repart de zéro
      for (const tick of message.data ?? []) {
        const price = tickerPrice(tick);
        if (price) onPrice(tick.market, price);
      }
    };
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      const wait = reconnectDelay(attempt++);
      onStatus?.(false, `flux de prix interrompu, reconnexion dans ${Math.round(wait / 1000)} s`);
      setTimeout(connect, wait);
    };
  };
  connect();
}
