const LW = LightweightCharts;
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// L'espace fine insécable de fr-FR n'existe pas dans toutes les polices : on la remplace par une insécable classique
const nf = (n, d = 2) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n).replace(/ /g, " ");
const signed = (n, d = 2) => `${n >= 0 ? "+" : "−"}${nf(Math.abs(n), d)}`;
const clock = (t) => new Date(t).toLocaleTimeString("fr-FR");
const when = (t) => new Date(t).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const base = (symbol) => symbol.replace("USDT", "");
const ACTIONS = { BUY: "▲ Achat", SELL: "▼ Vente", HOLD: "■ Attente" };
const INTERVALS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };

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

// ---------- Graphiques (TradingView lightweight-charts) ----------

// La lib affiche l'UTC : on décale les timestamps pour montrer l'heure locale
const TZ = -new Date().getTimezoneOffset() * 60;
const sec = (ms) => Math.floor(ms / 1000) + TZ;
let interval = "1m";
const barTime = (ms) => Math.floor(ms / 1000 / INTERVALS[interval]) * INTERVALS[interval] + TZ;

function createChart(container, seconds) {
  return LW.createChart(container, {
    autoSize: true,
    layout: { background: { type: "solid", color: css("--surface") }, textColor: css("--ink-2"), fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
    rightPriceScale: { borderColor: css("--axis") },
    timeScale: { borderColor: css("--axis"), timeVisible: true, secondsVisible: seconds },
    crosshair: { mode: LW.CrosshairMode.Normal },
    localization: { locale: "fr-FR" },
  });
}

let state;
let equitySeries;
let lastEquityTime = 0;
const markets = {};

function pushEquity(ms, value) {
  const time = sec(ms);
  if (time <= lastEquityTime) return;
  lastEquityTime = time;
  equitySeries.update({ time, value });
}

function setupEquity() {
  const up = css("--up");
  const down = css("--down");
  equitySeries = createChart($("equityChart"), true).addSeries(LW.BaselineSeries, {
    baseValue: { type: "price", price: state.startCash },
    topLineColor: up,
    topFillColor1: `${up}47`,
    topFillColor2: `${up}0a`,
    bottomLineColor: down,
    bottomFillColor1: `${down}0a`,
    bottomFillColor2: `${down}47`,
    lineWidth: 2,
  });
}

function loadEquity() {
  lastEquityTime = 0;
  equitySeries.setData([]);
  for (const h of state.history) pushEquity(Date.parse(h.time), h.equity);
}

function setupMarket(symbol) {
  const price = el("strong", {}, "–");
  const chartBox = el("div", { class: "chart" });
  const signal = el("div", { class: "signal" });
  $("markets").append(el("section", { class: "panel", "aria-label": `Cours ${base(symbol)}` }, el("div", { class: "market-head" }, el("h2", {}, `${base(symbol)} / USDT`), price), chartBox, signal));

  const chart = createChart(chartBox, false);
  const series = chart.addSeries(LW.CandlestickSeries, {
    upColor: css("--up"),
    downColor: css("--down"),
    wickUpColor: css("--up"),
    wickDownColor: css("--down"),
    borderVisible: false,
  });
  markets[symbol] = { price, signal, chart, series, markers: LW.createSeriesMarkers(series, []), last: null, first: 0 };
}

// zoom = true au chargement et au changement d'intervalle, pas lors des resynchronisations
async function loadCandles(zoom = false) {
  await Promise.all(
    state.config.symbols.map(async (symbol) => {
      const candles = await api(`/api/candles/${symbol}?interval=${interval}`);
      const bars = candles.map((c) => ({ ...c, time: sec(c.time) }));
      const m = markets[symbol];
      m.series.setData(bars);
      m.last = bars.at(-1);
      m.first = bars[0]?.time ?? 0;
      if (zoom) m.chart.timeScale().setVisibleLogicalRange({ from: bars.length - 90, to: bars.length + 4 });
      drawMarkers(symbol);
    }),
  );
}

// Un marqueur par ordre, posé sur la bougie qui contient l'instant de l'ordre
function drawMarkers(symbol) {
  const m = markets[symbol];
  const marks = state.trades
    .filter((t) => t.symbol === symbol)
    .map((t) => ({
      time: barTime(Date.parse(t.time)),
      position: t.side === "BUY" ? "belowBar" : "aboveBar",
      shape: t.side === "BUY" ? "arrowUp" : "arrowDown",
      color: t.side === "BUY" ? css("--up") : css("--down"),
    }))
    .filter((mark) => mark.time >= m.first);
  m.markers.setMarkers(marks);
}

// La bougie en cours est animée par le flux de prix, sans recharger l'historique
function pushPrice(symbol, price, ms) {
  const m = markets[symbol];
  if (!m?.last || !price) return;
  const time = barTime(ms);
  m.last = time > m.last.time ? { time, open: m.last.close, high: price, low: price, close: price } : { ...m.last, high: Math.max(m.last.high, price), low: Math.min(m.last.low, price), close: price };
  m.series.update(m.last);
}

// ---------- Rendu ----------

function gauge(value, zones) {
  const pct = (v) => `${((Math.max(-1, Math.min(1, v)) + 1) / 2) * 100}%`;
  const mix = (token) => `color-mix(in srgb, var(${token}) 45%, var(--neutral))`;
  const bg = zones ? `background: linear-gradient(to right, ${mix("--down")} ${pct(zones.exit)}, var(--neutral) ${pct(zones.exit)} ${pct(zones.enter)}, ${mix("--up")} ${pct(zones.enter)})` : "";
  return el("div", { class: "gauge" }, el("div", { class: "track", style: bg }, el("i", { style: `left:${pct(value)}` })), el("span", {}, signed(value)));
}

function renderLive(live) {
  $("feed").className = `feed${live.feedOk ? " ok" : ""}`;
  $("feed").textContent = live.feedOk ? `Prix Binance en direct, ${clock(live.time)}` : "Flux de prix interrompu, reconnexion…";

  $("equity").replaceChildren(nf(live.equity), el("small", {}, " USDT"));
  $("pnl").className = `delta ${live.pnl >= 0 ? "up" : "down"}`;
  $("pnl").textContent = `${live.pnl >= 0 ? "▲" : "▼"} ${signed(live.pnl)} USDT (${signed((live.pnl / state.startCash) * 100)} %) depuis le ${when(state.startedAt)}`;

  const rows = [["Cash", `${nf(live.cash)} USDT`, ""]];
  for (const p of live.positions) rows.push([base(p.symbol), `${nf(p.value)} USDT`, `entrée ${nf(p.entryPrice)}, ${signed(p.gain * 100)} %`]);
  if (!live.positions.length) rows.push(["Positions", "Aucune", ""]);
  $("holdings").replaceChildren(...rows.flatMap(([k, v, sub]) => [el("dt", {}, k), el("dd", {}, v, ...(sub ? [el("small", {}, sub)] : []))]));

  const s = live.stats;
  $("stats").textContent = s.closed
    ? `${s.closed} aller-retour(s), ${nf((s.wins / s.closed) * 100, 0)} % gagnants, ${signed(s.realized)} USDT réalisés dont ${nf(s.fees)} USDT de frais.`
    : "Aucun aller-retour terminé pour l'instant.";

  for (const symbol of state.config.symbols) {
    const m = markets[symbol];
    const price = live.prices[symbol];
    if (price) m.price.textContent = nf(price);
    pushPrice(symbol, price, live.time);

    const d = live.signals[symbol];
    if (!live.speedMs) m.signal.replaceChildren(el("span", { class: "why" }, "Bot en pause : aucune décision n'est prise."));
    else if (d) {
      const detail = `${d.reason} · micro ${signed(d.micro)}, news ${d.news === null ? "–" : signed(d.news)} (${d.headlinesUsed} titres)`;
      m.signal.replaceChildren(gauge(d.score, state.config.micro), el("span", { class: `action ${d.action === "BUY" ? "up" : d.action === "SELL" ? "down" : ""}` }, ACTIONS[d.action]), el("span", { class: "why" }, detail));
    }
  }

  pushEquity(live.time, live.equity);
  for (const button of $("speed").children) button.setAttribute("aria-pressed", String(Number(button.dataset.ms) === live.speedMs));
}

function table(head, rows) {
  return el("table", {}, el("thead", {}, el("tr", {}, ...head.map(([label, cls]) => el("th", cls ? { class: cls } : {}, label)))), el("tbody", {}, ...rows));
}

function renderTrades() {
  if (!state.trades.length) {
    $("trades").replaceChildren(el("p", { class: "empty" }, "Aucun ordre pour l'instant. Le bot a besoin d'une minute de prix avant de prendre sa première décision."));
    return;
  }
  const head = [["Heure"], ["Actif"], ["Sens"], ["Prix", "num"], ["Montant", "num"], ["Résultat net", "num"], ["Raison"]];
  const rows = [...state.trades].reverse().slice(0, 200).map((t) =>
    el(
      "tr",
      {},
      el("td", { class: "nowrap" }, clock(t.time)),
      el("td", {}, base(t.symbol)),
      el("td", {}, el("span", { class: `action ${t.side === "BUY" ? "up" : "down"}` }, ACTIONS[t.side])),
      el("td", { class: "num" }, nf(t.price)),
      el("td", { class: "num" }, nf(t.usdt)),
      el("td", { class: `num ${t.pnl === undefined ? "" : t.pnl >= 0 ? "up" : "down"}` }, t.pnl === undefined ? "" : signed(t.pnl, 3)),
      el("td", {}, t.reason),
    ),
  );
  $("trades").replaceChildren(table(head, rows));
}

function renderNews() {
  if (!state.judgments.length) {
    $("news").replaceChildren(el("p", { class: "empty" }, "Jev n'a encore jugé aucun titre."));
    return;
  }
  const head = [["Paru"], ["Titre"], ["Actif"], ["Confiance", "num"], ["Sentiment"], ["Impact marché", "num"], ["Risque réglementaire", "num"]];
  const rows = state.judgments.map((j) =>
    el(
      "tr",
      j.asset === "unrelated" || j.assetConfidence < state.config.news.minConfidence ? { class: "ignored" } : {},
      el("td", { class: "nowrap" }, when(j.headline.publishedAt)),
      el("td", {}, j.headline.title),
      el("td", {}, j.asset),
      el("td", { class: "num" }, nf(j.assetConfidence)),
      el("td", {}, gauge(j.sentiment)),
      el("td", { class: "num" }, nf(j.material)),
      el("td", { class: "num" }, nf(j.regulatoryRisk)),
    ),
  );
  $("news").replaceChildren(table(head, rows));
}

function segmented(container, options, onPick) {
  container.replaceChildren(
    ...options.map(([label, value]) => {
      const button = el("button", { "aria-pressed": "false" }, label);
      button.dataset.ms = value;
      button.addEventListener("click", () => onPick(value, button));
      return button;
    }),
  );
}

// ---------- Données ----------

function notify(message) {
  $("status").hidden = !message;
  $("status").textContent = message;
}

async function api(path, method = "GET") {
  const res = await fetch(path, { method });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
  return body;
}

async function load() {
  state = await api("/api/state");
  loadEquity();
  renderTrades();
  renderNews();
  renderLive(state.live);
  await loadCandles(true);
}

async function init() {
  state = await api("/api/state");
  setupEquity();
  state.config.symbols.forEach(setupMarket);
  $("reset").textContent = `Recommencer à ${nf(state.startCash, 0)} USDT`;

  segmented($("speed"), Object.entries(state.config.speeds).map(([label, ms]) => [ms ? `${label} (${ms / 1000} s)` : label, ms]), (ms) => api(`/api/speed/${ms}`, "POST").catch((err) => notify(err.message)));
  segmented($("intervals"), Object.keys(INTERVALS).map((key) => [key === "1d" ? "1D" : key, key]), async (key) => {
    interval = key;
    for (const button of $("intervals").children) button.setAttribute("aria-pressed", String(button.dataset.ms === key));
    await loadCandles(true);
  });
  $("intervals").firstChild.setAttribute("aria-pressed", "true");

  await load();

  const stream = new EventSource("/api/stream");
  stream.addEventListener("tick", (e) => renderLive(JSON.parse(e.data)));
  stream.addEventListener("trade", (e) => {
    const trade = JSON.parse(e.data);
    state.trades.push(trade);
    renderTrades();
    drawMarkers(trade.symbol);
  });
  stream.addEventListener("news", (e) => {
    state.judgments = JSON.parse(e.data);
    renderNews();
  });
  stream.addEventListener("reset", load);
  stream.onopen = () => notify("");
  stream.onerror = () => notify("Connexion au bot perdue. Vérifie que « npm start » tourne ; la page se reconnecte toute seule.");

  // Resynchronise les bougies avec Binance une fois par minute
  setInterval(() => loadCandles().catch(() => {}), 60_000);
}

$("reset").addEventListener("click", () => {
  if (confirm("Remettre le portefeuille à son capital de départ et effacer l'historique des ordres ?")) api("/api/reset", "POST").catch((err) => notify(err.message));
});

init().catch((err) => notify(`Impossible de joindre le bot : ${err.message}`));
