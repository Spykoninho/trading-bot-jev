import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { streamSSE } from "hono/streaming";
import { reset, setSpeed, subscribe, view } from "./bot.js";
import { config } from "./config.js";
import { fetchCandles, INTERVALS, type Interval } from "./market.js";

export function startServer(): void {
  const app = new Hono();

  // Pas d'auth : on n'écoute qu'en local et on refuse les POST venant d'autres origines
  app.use(csrf());
  app.onError((err, c) => c.json({ error: err.message }, 500));

  app.get("/api/state", (c) => c.json(view()));

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
    const interval = (c.req.query("interval") ?? "1m") as Interval;
    if (!config.symbols.includes(symbol) || !INTERVALS.includes(interval)) return c.json({ error: "unknown symbol or interval" }, 404);
    return c.json(await fetchCandles(symbol, interval));
  });

  app.post("/api/speed/:ms", (c) => {
    const ms = Number(c.req.param("ms"));
    if (!Object.values(config.speeds).includes(ms)) return c.json({ error: "unknown speed" }, 400);
    setSpeed(ms);
    return c.json({ speedMs: ms });
  });

  app.post("/api/reset", async (c) => {
    await reset();
    return c.json(view());
  });

  app.get("/vendor/charts.js", serveStatic({ path: "./node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js" }));
  app.use("/*", serveStatic({ root: "./public" }));

  serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" });
  console.log(`interface : http://localhost:${config.port}`);
}
