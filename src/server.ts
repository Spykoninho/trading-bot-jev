import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { cycle, reset, state, view } from "./bot.js";
import { config } from "./config.js";
import { fetchCandles } from "./market.js";

export function startServer(): void {
  const app = new Hono();

  // Pas d'auth : on n'écoute qu'en local et on refuse les POST venant d'autres origines
  app.use(csrf());
  app.onError((err, c) => c.json({ error: err.message }, 500));

  app.get("/api/state", (c) => c.json(view()));

  app.get("/api/candles/:symbol", async (c) => {
    const symbol = c.req.param("symbol");
    if (!config.symbols.includes(symbol)) return c.json({ error: "unknown symbol" }, 404);
    return c.json(await fetchCandles(symbol, 72));
  });

  app.post("/api/cycle", async (c) => {
    if (state.running) return c.json({ error: "Un cycle est déjà en cours." }, 409);
    await cycle();
    return c.json(view());
  });

  app.post("/api/reset", async (c) => {
    await reset();
    return c.json(view());
  });

  app.get("/vendor/chart.js", serveStatic({ path: "./node_modules/chart.js/dist/chart.umd.min.js" }));
  app.use("/*", serveStatic({ root: "./public" }));

  serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" });
  console.log(`interface : http://localhost:${config.port}`);
}
