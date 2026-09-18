import { backtest } from "./backtest.js";
import { config } from "./config.js";
import { fetchHistory } from "./market.js";

const pct = (n: number) => `${(n * 100).toFixed(1)} %`;

const entries = await Promise.all(config.symbols.map(async (s) => [s, await fetchHistory(s, config.strategy.interval, config.backtestYears)] as const));
const { stats, times } = backtest(Object.fromEntries(entries));

console.log(`${config.symbols.join(" + ")}, bougies ${config.strategy.interval}, ${new Date(times[0]!).toLocaleDateString("fr-FR")} → ${new Date(times.at(-1)!).toLocaleDateString("fr-FR")}, frais ${pct(config.fee)} par ordre`);
console.table({
  "Stratégie (EMA + bande)": { rendement: pct(stats.strategyReturn), "pire creux": pct(stats.strategyDrawdown) },
  "Buy & hold": { rendement: pct(stats.holdReturn), "pire creux": pct(stats.holdDrawdown) },
});
console.log(`${stats.closed} allers-retours, ${stats.wins} gagnants, ${stats.fees.toFixed(2)} USDT de frais`);
