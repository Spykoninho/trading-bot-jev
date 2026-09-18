import { backtest } from "./backtest.js";
import { config } from "./config.js";
import { loadArchive } from "./history.js";
import { fetchHistory } from "./market.js";

const pct = (n: number) => `${(n * 100).toFixed(1)} %`;

const entries = await Promise.all(config.symbols.map(async (s) => [s, await fetchHistory(s, config.strategy.interval, config.backtestYears)] as const));
const history = Object.fromEntries(entries);
const { judgments } = await loadArchive();
const plain = backtest(history);
const row = (r: typeof plain) => ({ rendement: pct(r.stats.strategyReturn), "pire creux": pct(r.stats.strategyDrawdown), "allers-retours": r.stats.closed, gagnants: r.stats.wins, "frais USDT": r.stats.fees.toFixed(2) });

console.log(`${config.symbols.join(" + ")}, bougies ${config.strategy.interval}, ${new Date(plain.times[0]!).toLocaleDateString("fr-FR")} → ${new Date(plain.times.at(-1)!).toLocaleDateString("fr-FR")}, frais ${pct(config.fee)} par ordre`);
console.table({
  ...(judgments.length ? { [`Stratégie + Jev (${judgments.length} titres)`]: row(backtest(history, config, judgments)) } : {}),
  "Stratégie sans news": row(plain),
  "Acheter et garder": { rendement: pct(plain.stats.holdReturn), "pire creux": pct(plain.stats.holdDrawdown) },
});
if (!judgments.length) console.log("Pas de titres d'époque : lancer `npm run history` pour comparer avec et sans Jev.");
