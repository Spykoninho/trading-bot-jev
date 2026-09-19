import { backtest, type BacktestResult } from "./backtest.js";
import { config } from "./config.js";
import { loadArchive } from "./history.js";
import { fetchHistory } from "./market.js";

const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
const fine = (n: number) => `${(n * 100).toFixed(2)} %`;
const ratio = (n: number) => n.toFixed(2);

const entries = await Promise.all(config.symbols.map(async (s) => [s, await fetchHistory(s, config.strategy.interval, config.backtestYears)] as const));
const history = Object.fromEntries(entries);
const { judgments } = await loadArchive();

// Ablation : on neutralise une composante à la fois pour voir ce que chacune apporte vraiment
const noVeto = { ...config, news: { ...config.news, regulatoryRisk: 2 } };
const noTilt = { ...config, strategy: { ...config.strategy, newsTilt: 0 } };
const run = (cfg = config, news = judgments) => backtest(history, cfg, news);
const plain = run(config, []);

const row = (r: BacktestResult) => ({
  rendement: pct(r.stats.strategy.return),
  "pire creux": pct(r.stats.strategy.drawdown),
  CAGR: pct(r.stats.strategy.cagr),
  Sharpe: ratio(r.stats.strategy.sharpe),
  Sortino: ratio(r.stats.strategy.sortino),
  MAR: ratio(r.stats.strategy.mar),
  "allers-retours": r.stats.closed,
  gagnants: r.stats.wins,
  [`frais ${config.quote}`]: r.stats.fees.toFixed(2),
});
const holdRow = (r: BacktestResult) => ({
  rendement: pct(r.stats.hold.return),
  "pire creux": pct(r.stats.hold.drawdown),
  CAGR: pct(r.stats.hold.cagr),
  Sharpe: ratio(r.stats.hold.sharpe),
  Sortino: ratio(r.stats.hold.sortino),
  MAR: ratio(r.stats.hold.mar),
  "allers-retours": 1,
  gagnants: "—",
  [`frais ${config.quote}`]: (config.startCash * config.fee).toFixed(2),
});

console.log(
  `${config.symbols.join(" + ")}, bougies ${config.strategy.interval}, ${new Date(plain.times[0]!).toLocaleDateString("fr-FR")} → ${new Date(plain.times.at(-1)!).toLocaleDateString("fr-FR")}, frais ${fine(config.fee)} par ordre, glissement ${config.slippageBps} bps`,
);

const full = judgments.length ? run() : null;
console.table({
  "Sans news": row(plain),
  ...(judgments.length
    ? {
        "Biais seul (veto neutralisé)": row(run(noVeto)),
        "Veto seul (biais à zéro)": row(run(noTilt)),
        "Biais + veto": row(full!),
      }
    : {}),
  "Acheter et garder": holdRow(plain),
});

// Profil des allers-retours : une poignée de gros gains peut porter tout le résultat
const profile = (label: string, r: BacktestResult) => [
  label,
  {
    nombre: r.stats.profile.count,
    "% gagnants": pct(r.stats.profile.winRate),
    médiane: fine(r.stats.profile.median),
    p10: fine(r.stats.profile.p10),
    p90: fine(r.stats.profile.p90),
    "pire perte": fine(r.stats.profile.worst),
    "part des 5 meilleurs": pct(r.stats.profile.top5Share),
  },
];
console.log("Profil des allers-retours (rendement par opération) :");
console.table(Object.fromEntries([profile("Sans news", plain), ...(full ? [profile("Biais + veto", full)] : [])]));

if (!judgments.length) console.log("Pas de titres d'époque : lancer `npm run history` pour comparer avec et sans Jev.");
else console.log(`${judgments.length} titres d'époque relus, fenêtre de news ${config.news.windowMs / 3_600_000} h, visibles ${config.news.latencyMs / 1000} s après leur parution.`);

// `--fees` : la même ligne complète rejouée aux frais des plateformes européennes
if (process.argv.includes("--fees")) {
  const table: Record<string, Record<string, string | number>> = {};
  // 0,15 % = maker Bitvavo, 0,25 % = taker Bitvavo (palier < 100 000 € / 30 j), puis deux paliers plus chers
  for (const fee of [0.0005, 0.0015, 0.0025, 0.004]) {
    const r = run({ ...config, fee }, judgments);
    table[`frais ${fine(fee)}`] = {
      rendement: pct(r.stats.strategy.return),
      CAGR: pct(r.stats.strategy.cagr),
      "pire creux": pct(r.stats.strategy.drawdown),
      Sharpe: ratio(r.stats.strategy.sharpe),
      "allers-retours": r.stats.closed,
      [`frais payés ${config.quote}`]: r.stats.fees.toFixed(2),
      "acheter et garder": pct(r.stats.hold.return),
    };
  }
  console.log("Sensibilité aux frais, ligne complète (biais + veto) :");
  console.table(table);
}
