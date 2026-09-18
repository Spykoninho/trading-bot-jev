const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// L'espace fine insécable de fr-FR n'existe pas dans toutes les polices : on la remplace par une insécable classique
const nf = (n, d = 2) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n).replace(/ /g, " ");
const signed = (n, d = 2) => `${n >= 0 ? "+" : "−"}${nf(Math.abs(n), d)}`;
const when = (t) => new Date(t).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const ACTIONS = { BUY: "▲ Acheter", SELL: "▼ Vendre", HOLD: "■ Attendre" };

// Les titres RSS sont des données non fiables : tout passe par des nœuds texte, jamais innerHTML
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "class") node.className = value;
    else if (key === "style") node.style.cssText = value;
    else node.setAttribute(key, value);
  }
  node.append(...children);
  return node;
}

// ---------- Graphiques ----------

// Repères : ligne du capital de départ + réticule vertical sous le pointeur
const guides = {
  id: "guides",
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea: area, scales } = chart;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = css("--axis");
    if (opts.baseline != null) {
      const y = scales.y.getPixelForValue(opts.baseline);
      if (y >= area.top && y <= area.bottom) {
        ctx.beginPath();
        ctx.moveTo(area.left, y);
        ctx.lineTo(area.right, y);
        ctx.stroke();
        ctx.fillStyle = css("--muted");
        ctx.font = `12px ${Chart.defaults.font.family}`;
        ctx.fillText(opts.baselineLabel, area.left + 4, y - 5);
      }
    }
    const active = chart.tooltip?.getActiveElements?.()[0];
    if (active) {
      ctx.beginPath();
      ctx.moveTo(active.element.x, area.top);
      ctx.lineTo(active.element.x, area.bottom);
      ctx.stroke();
    }
    ctx.restore();
  },
};
Chart.register(guides);

function lineChart(canvas, { label, baseline, baselineLabel, markers = false }) {
  const surface = css("--surface");
  const marker = (name, color, rotation) => ({
    label: name,
    data: [],
    showLine: false,
    pointStyle: "triangle",
    rotation,
    pointRadius: 7,
    pointHoverRadius: 9,
    pointBackgroundColor: color,
    pointBorderColor: surface,
    pointBorderWidth: 2,
  });
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  Chart.defaults.color = css("--muted");

  return new Chart(canvas, {
    type: "line",
    data: {
      datasets: [
        { label, data: [], borderColor: css("--series"), borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: css("--series"), tension: 0 },
        ...(markers ? [marker("Achat", css("--good"), 0), marker("Vente", css("--critical"), 180)] : []),
      ],
    },
    options: {
      parsing: false,
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      scales: {
        x: {
          type: "linear",
          bounds: "data",
          grid: { display: false },
          border: { color: css("--axis") },
          ticks: { maxTicksLimit: 6, callback: (v) => when(v) },
        },
        y: {
          grace: "10%",
          grid: { color: css("--grid") },
          border: { display: false },
          // Décimales seulement quand l'écart entre graduations est inférieur à 1
          ticks: { maxTicksLimit: 5, callback: (v, _i, ticks) => nf(v, ticks.length > 1 && ticks[1].value - ticks[0].value < 1 ? 2 : 0) },
        },
      },
      plugins: {
        guides: { baseline, baselineLabel },
        legend: { display: markers, position: "bottom", align: "start", labels: { usePointStyle: true, boxHeight: 8, filter: (item) => item.datasetIndex > 0, color: css("--ink-2") } },
        tooltip: {
          backgroundColor: css("--ink"),
          titleColor: css("--surface"),
          bodyColor: css("--surface"),
          displayColors: false,
          callbacks: {
            title: (items) => when(items[0].parsed.x),
            label: (item) => `${nf(item.parsed.y)} USDT · ${item.dataset.label}`,
          },
        },
      },
    },
  });
}

const charts = { equity: null, prices: {} };

function setData(chart, ...series) {
  series.forEach((data, i) => (chart.data.datasets[i].data = data));
  chart.update("none");
}

// ---------- Rendu ----------

function gauge(value, thresholds) {
  const pct = (v) => `${((Math.max(-1, Math.min(1, v)) + 1) / 2) * 100}%`;
  const zones = thresholds
    ? `background: linear-gradient(to right, color-mix(in srgb, var(--critical) 35%, var(--neutral)) ${pct(thresholds.sell)}, var(--neutral) ${pct(thresholds.sell)} ${pct(thresholds.buy)}, color-mix(in srgb, var(--good) 35%, var(--neutral)) ${pct(thresholds.buy)})`
    : "";
  return el("div", { class: "gauge" }, el("div", { class: "track", style: zones }, el("i", { style: `left:${pct(value)}` })), el("span", {}, signed(value)));
}

function renderPortfolio({ portfolio: p }) {
  $("equity").replaceChildren(nf(p.equity), el("small", {}, " USDT"));
  const pct = (p.pnl / p.startCash) * 100;
  $("pnl").className = `delta ${p.pnl >= 0 ? "up" : "down"}`;
  $("pnl").textContent = `${p.pnl >= 0 ? "▲" : "▼"} ${signed(p.pnl)} USDT (${signed(pct)} %) depuis le ${when(p.startedAt)}`;

  const rows = [[`Cash`, `${nf(p.cash)} USDT`, ""]];
  for (const pos of p.positions) rows.push([pos.symbol.replace("USDT", ""), `${nf(pos.value)} USDT`, `${nf(pos.qty, 6)} × ${nf(pos.price)}`]);
  if (!p.positions.length) rows.push(["Positions", "Aucune", ""]);
  $("holdings").replaceChildren(...rows.flatMap(([k, v, sub]) => [el("dt", {}, k), el("dd", {}, v, ...(sub ? [el("small", {}, sub)] : []))]));
}

function renderCycles({ cycles, config }) {
  if (!cycles.length) {
    $("cycles").replaceChildren(el("p", { class: "empty" }, "Aucun cycle pour l'instant. Lance un cycle pour voir les jugements de Jev."));
    return;
  }
  const open = new Set([...document.querySelectorAll("#cycles details[open]")].map((d) => d.dataset.time));
  $("cycles").replaceChildren(
    ...cycles.map((c) => {
      const decisions = c.decisions.map((d) =>
        el(
          "div",
          { class: "decision" },
          el("strong", {}, d.symbol.replace("USDT", "")),
          gauge(d.score, config.thresholds),
          el("span", { class: `action ${d.action}` }, ACTIONS[d.action]),
          el("span", { class: "why" }, `${d.reason} · news ${d.newsScore === null ? "–" : signed(d.newsScore)}, tech ${signed(d.techSignal)}, ${d.headlinesUsed} titres${d.result === "-" ? "" : ` → ${d.result}`}`),
        ),
      );
      const head = ["Titre", "Actif", "Confiance", "Sentiment", "Impact marché", "Risque réglementaire"];
      const table = el(
        "table",
        {},
        el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", i > 1 && i !== 3 ? { class: "num" } : {}, h)))),
        el(
          "tbody",
          {},
          ...c.judgments.map((j) =>
            el(
              "tr",
              j.asset === "unrelated" || j.assetConfidence < config.thresholds.minConfidence ? { class: "ignored" } : {},
              el("td", {}, j.headline.title),
              el("td", {}, j.asset),
              el("td", { class: "num" }, nf(j.assetConfidence)),
              el("td", {}, gauge(j.sentiment)),
              el("td", { class: "num" }, nf(j.material)),
              el("td", { class: "num" }, nf(j.regulatoryRisk)),
            ),
          ),
        ),
      );
      const details = el("details", { "data-time": c.time }, el("summary", {}, el("div", { class: "cycle-head" }, el("span", {}, when(c.time))), ...decisions), el("div", { class: "table-wrap" }, table));
      details.open = open.has(c.time);
      return details;
    }),
  );
}

function renderTrades({ trades }) {
  if (!trades.length) {
    $("trades").replaceChildren(el("p", { class: "empty" }, "Aucun ordre pour l'instant : le bot n'achète ou ne vend que lorsque le score sort de la zone neutre."));
    return;
  }
  const head = ["Date", "Actif", "Sens", "Quantité", "Prix", "Montant", "Frais", "Raison"];
  $("trades").replaceChildren(
    el(
      "div",
      { class: "table-wrap" },
      el(
        "table",
        {},
        el("thead", {}, el("tr", {}, ...head.map((h, i) => el("th", i > 2 && i < 7 ? { class: "num" } : {}, h)))),
        el(
          "tbody",
          {},
          ...[...trades].reverse().map((t) =>
            el(
              "tr",
              {},
              el("td", {}, when(t.time)),
              el("td", {}, t.symbol.replace("USDT", "")),
              el("td", {}, el("span", { class: `action ${t.side}` }, ACTIONS[t.side])),
              el("td", { class: "num" }, nf(t.qty, 6)),
              el("td", { class: "num" }, nf(t.price)),
              el("td", { class: "num" }, nf(t.usdt)),
              el("td", { class: "num" }, nf(t.fee, 3)),
              el("td", {}, t.reason),
            ),
          ),
        ),
      ),
    ),
  );
}

function renderPrices(state, candles) {
  for (const symbol of state.config.symbols) {
    if (!charts.prices[symbol]) {
      const canvas = el("canvas");
      const price = el("strong", { id: `price-${symbol}` });
      $("prices").append(
        el("figure", { class: "panel" }, el("figcaption", { class: "price-head" }, el("span", {}, `${symbol.replace("USDT", "")} en USDT, 72 dernières heures`), price), el("div", { class: "chart" }, canvas)),
      );
      charts.prices[symbol] = lineChart(canvas, { label: symbol.replace("USDT", ""), markers: true });
    }
    const live = state.prices[symbol];
    if (live) $(`price-${symbol}`).textContent = nf(live);
    const line = (candles[symbol] ?? []).map((c) => ({ x: c.time, y: c.close }));
    if (live && line.length) line.push({ x: Date.now(), y: live });
    const marks = (side) => state.trades.filter((t) => t.symbol === symbol && t.side === side && line.length && new Date(t.time) >= line[0].x).map((t) => ({ x: new Date(t.time).getTime(), y: t.price }));
    setData(charts.prices[symbol], line, marks("BUY"), marks("SELL"));
  }
}

function render(state, candles) {
  $("mode").textContent = `Portefeuille papier sur prix Binance réels${state.config.live ? ", ordres répliqués sur le testnet" : ""}. Un cycle Jev toutes les ${state.config.intervalMin} min, ordres de ${nf(state.config.orderUsdt, 0)} USDT.`;
  $("reset").textContent = `Recommencer à ${nf(state.portfolio.startCash, 0)} USDT`;
  $("run").disabled = state.running;
  $("run").textContent = state.running ? "Cycle en cours…" : "Lancer un cycle";

  renderPortfolio(state);
  charts.equity ??= lineChart($("equityChart"), { label: "Portefeuille", baseline: state.portfolio.startCash, baselineLabel: `Départ ${nf(state.portfolio.startCash, 0)}` });
  // Un seul point juste après un reset : on fixe une fenêtre d'une heure pour garder un axe lisible
  const x = charts.equity.options.scales.x;
  [x.min, x.max] = state.history.length < 2 ? [Date.now() - 1_800_000, Date.now() + 1_800_000] : [undefined, undefined];
  setData(charts.equity, state.history.map((h) => ({ x: new Date(h.time).getTime(), y: h.equity })));
  renderPrices(state, candles);
  renderCycles(state);
  renderTrades(state);
}

// ---------- Données ----------

let candles = {};

function notify(message, error = false) {
  $("status").hidden = !message;
  $("status").className = `status${error ? " error" : ""}`;
  $("status").textContent = message;
}

async function api(path, method = "GET") {
  const res = await fetch(path, { method });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
  return body;
}

async function loadCandles(symbols) {
  const entries = await Promise.all(symbols.map(async (s) => [s, await api(`/api/candles/${s}`)]));
  candles = Object.fromEntries(entries);
}

async function refresh() {
  try {
    const state = await api("/api/state");
    if (!Object.keys(candles).length) await loadCandles(state.config.symbols);
    render(state, candles);
  } catch (err) {
    notify(`Impossible de joindre le bot : ${err.message}. Vérifie que « npm start » tourne.`, true);
  }
}

async function act(path, pending, done) {
  notify(pending);
  $("run").disabled = true;
  try {
    render(await api(path, "POST"), candles);
    notify(done);
  } catch (err) {
    notify(err.message, true);
  } finally {
    $("run").disabled = false;
  }
}

$("run").addEventListener("click", () => act("/api/cycle", "Cycle en cours : Jev juge les derniers titres…", "Cycle terminé."));
$("reset").addEventListener("click", () => {
  if (confirm("Remettre le portefeuille à son capital de départ et effacer l'historique ?")) act("/api/reset", "Remise à zéro…", "Portefeuille remis à zéro.");
});

// Changement clair/sombre : les couleurs des graphiques sont lues au moment de leur création
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => location.reload());

refresh();
setInterval(refresh, 10_000);
setInterval(async () => Object.keys(candles).length && loadCandles(Object.keys(candles)), 60_000);
