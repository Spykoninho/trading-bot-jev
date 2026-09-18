import { cycle, init, tick, type CycleRecord } from "./bot.js";
import { config } from "./config.js";
import { startServer } from "./server.js";

const f = (n: number) => n.toFixed(2);

function print(record: CycleRecord): void {
  console.log(`${record.time} · ${record.judgments.length} titres jugés par Jev`);
  console.table(
    record.decisions.map((d) => ({
      symbol: d.symbol,
      price: d.price,
      news: d.newsScore === null ? "-" : f(d.newsScore),
      tech: f(d.techSignal),
      score: f(d.score),
      headlines: d.headlinesUsed,
      action: d.action,
      reason: d.reason,
      result: d.result,
    })),
  );
}

const safely = (task: () => Promise<unknown>) => task().catch((err) => console.error(err));

await init();
console.log(`mode=${config.live ? "papier + miroir testnet" : "papier"} symbols=${config.symbols.join(",")}`);

if (config.once) {
  print(await cycle());
} else {
  startServer();
  await safely(tick);
  setInterval(() => safely(tick), config.tickSec * 1000);
  const run = () => safely(async () => print(await cycle()));
  await run();
  setInterval(run, config.intervalMin * 60_000);
}
