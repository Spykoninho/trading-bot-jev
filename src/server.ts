import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { streamSSE } from "hono/streaming";
import { HISTORY_PAGE, historyBefore, isList, PAGE, page, reset, runBacktest, subscribe, view } from "./bot.js";
import { config } from "./config.js";
import { fetchCandles, INTERVALS, MAX_LIMIT, type Interval } from "./market.js";

export function startServer(): void {
  const app = new Hono();

  // Pas d'auth : on n'écoute qu'en local et on refuse les POST venant d'autres origines
  app.use(csrf());
  app.onError((err, c) => c.json({ error: err.message }, 500));

  app.get("/api/state", (c) => c.json(view()));
  // Pages suivantes des listes (journal, titres, événements), et equity plus ancienne quand on dézoome
  const int = (value: string | undefined, fallback: number, max: number, min = 0) => Math.min(Math.max(Number.parseInt(value ?? "", 10) || fallback, min), max);
  // Plafond au-dessus de la plus longue liste gardée (5000 événements) : une liste dépliée n'est jamais tronquée
  app.get("/api/page/:name", (c) => {
    const name = c.req.param("name");
    if (!isList(name)) return c.json({ error: "unknown list" }, 404);
    return c.json(page(name, int(c.req.query("offset"), 0, Infinity), int(c.req.query("limit"), PAGE, 5000, 1)));
  });
  app.get("/api/history", (c) => c.json(historyBefore(c.req.query("before") ?? new Date().toISOString(), int(c.req.query("limit"), HISTORY_PAGE, 20_000, 1))));
  // En réel, le serveur ne sert qu'au suivi : pas de replay ni de remise à zéro, même en appelant l'API à la main
  const trackingOnly = (c: { json: (body: unknown, status: 403) => Response }) => c.json({ error: "Indisponible en mode réel : ce tableau de bord ne sert qu'au suivi" }, 403);
  app.get("/api/backtest", async (c) => (config.exchange ? trackingOnly(c) : c.json(await runBacktest())));

  // Server-Sent Events : le bot pousse ticks, trades et news, l'interface ne fait aucun polling
  app.get("/api/stream", (c) =>
    streamSSE(c, (stream) => {
      const off = subscribe((event, data) => void stream.writeSSE({ event, data: JSON.stringify(data) }));
      return new Promise<void>((resolve) =>
        stream.onAbort(() => {
          off();
          resolve();
        }),
      );
    }),
  );

  app.get("/api/candles/:symbol", async (c) => {
    const symbol = c.req.param("symbol");
    const interval = (c.req.query("interval") ?? config.strategy.interval) as Interval;
    if (!config.symbols.includes(symbol) || !(interval in INTERVALS)) return c.json({ error: "unknown symbol or interval" }, 404);
    // `end` : bougies antérieures à cet instant, demandées quand on dézoome vers le passé
    const end = int(c.req.query("end"), 0, Number.MAX_SAFE_INTEGER) || undefined;
    return c.json(await fetchCandles(symbol, interval, int(c.req.query("limit"), 300, MAX_LIMIT, 1), end));
  });

  app.post("/api/reset", async (c) => {
    if (config.exchange) return trackingOnly(c);
    const body = (await c.req.json().catch(() => ({}))) as { symbols?: unknown };
    const symbols = Array.isArray(body.symbols) ? body.symbols.map(String) : [];
    try {
      await reset(symbols);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json(view());
  });

  app.get("/vendor/charts.js", serveStatic({ path: "./node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js" }));
  app.use("/*", serveStatic({ root: "./public" }));

  serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  console.log(`interface : http://localhost:${config.port}`);
}
