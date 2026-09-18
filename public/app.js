const LW = LightweightCharts;
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// L'espace fine insécable de fr-FR n'existe pas dans toutes les polices : on la remplace par une insécable classique
const nf = (n, d = 2) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n).replace(/ /g, " ");
const signed = (n, d = 2) => `${n >= 0 ? "+" : "−"}${nf(Math.abs(n), d)}`;
const clock = (t) => new Date(t).toLocaleTimeString("fr-FR");
const day = (t) => new Date(t).toLocaleDateString("fr-FR");
const when = (t) => new Date(t).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const base = (symbol) => symbol.replace("USDT", "");
const ACTIONS = { BUY: "▲ Achat", SELL: "▼ Vente" };
const TRENDS = { up: "▲ Tendance haussière", down: "▼ Tendance baissière", none: "■ Pas de tendance" };
const INTERVALS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };
// Volatilité journalière mesurée sur 3 ans de bougies Binance, pour aider à choisir
const ASSET_NOTES = { BTC: "Bitcoin, le moins volatil des trois (≈ 2,3 % par jour)", ETH: "Ethereum, volatilité intermédiaire (≈ 3,2 % par jour)", SOL: "Solana, presque deux fois plus volatil que le Bitcoin (≈ 4,1 % par jour) : gains et pertes amplifiés" };

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
let interval = "4h";
const barTime = (ms) => Math.floor(ms / 1000 / INTERVALS[interval]) * INTERVALS[interval] + TZ;

function createChart(container, seconds) {
  return LW.createChart(container, {
    autoSize: true,
    layout: { background: { type: "solid", color: css("--surface") }, textColor: css("--ink-2"), fontFamily: getComputedStyle(document.body).fontFamily },
    grid: { vertLines: { color: css("--grid") }, horzLines: { color: css("--grid") } },
    rightPriceScale: { borderColor: css("--axis") },
    // minBarSpacing très bas : sinon fitContent ne peut pas faire tenir plusieurs milliers de points
    timeScale: { borderColor: css("--axis"), timeVisible: true, secondsVisible: seconds, minBarSpacing: 0.01 },
    crosshair: { mode: LW.CrosshairMode.Normal },
    localization: { locale: "fr-FR" },
  });
}

const tradeMarker = (t, time) => ({
  time,
  position: t.side === "BUY" ? "belowBar" : "aboveBar",
  shape: t.side === "BUY" ? "arrowUp" : "arrowDown",
  color: t.side === "BUY" ? css("--up") : css("--down"),
});

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
  const panel = el("section", { class: "panel", "aria-label": `Cours ${base(symbol)}` }, el("div", { class: "market-head" }, el("h2", {}, `${base(symbol)} / USDT`), price), chartBox, signal);
  $("markets").append(panel);

  const chart = createChart(chartBox, false);
  const series = chart.addSeries(LW.CandlestickSeries, {
    upColor: css("--up"),
    downColor: css("--down"),
    wickUpColor: css("--up"),
    wickDownColor: css("--down"),
    borderVisible: false,
  });
  const threshold = (title, color) => series.createPriceLine({ price: 0, color, lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: true, title });
  markets[symbol] = { panel, price, signal, chart, series, markers: LW.createSeriesMarkers(series, []), buyLine: threshold("achat", css("--up")), sellLine: threshold("vente", css("--down")), last: null, first: 0 };
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
      if (zoom) m.chart.timeScale().setVisibleLogicalRange({ from: bars.length - 120, to: bars.length + 4 });
      drawMarkers(symbol);
    }),
  );
}

// Un marqueur par ordre, posé sur la bougie qui contient l'instant de l'ordre
function drawMarkers(symbol) {
  const m = markets[symbol];
  m.markers.setMarkers(state.trades.filter((t) => t.symbol === symbol).map((t) => tradeMarker(t, barTime(Date.parse(t.time)))).filter((mark) => mark.time >= m.first));
}

// La bougie en cours est animée par le flux de prix, sans recharger l'historique
function pushPrice(symbol, price, ms) {
  const m = markets[symbol];
  if (!m?.last || !price) return;
  const time = barTime(ms);
  m.last = time > m.last.time ? { time, open: m.last.close, high: price, low: price, close: price } : { ...m.last, high: Math.max(m.last.high, price), low: Math.min(m.last.low, price), close: price };
  m.series.update(m.last);
}

// ---------- Rendu du direct ----------

// Jauge divergente : zone rouge sous `zones.low`, verte au-dessus de `zones.high`
function gauge(value, zones, label = signed(value)) {
  const pct = (v) => `${((Math.max(-1, Math.min(1, v)) + 1) / 2) * 100}%`;
  const mix = (token) => `color-mix(in srgb, var(${token}) 45%, var(--neutral))`;
  const bg = zones ? `background: linear-gradient(to right, ${mix("--down")} ${pct(zones.low)}, var(--neutral) ${pct(zones.low)} ${pct(zones.high)}, ${mix("--up")} ${pct(zones.high)})` : "";
  return el("div", { class: "gauge" }, el("div", { class: "track", style: bg }, el("i", { style: `left:${pct(value)}` })), el("span", {}, label));
}

function renderSignal(symbol, d, price) {
  const m = markets[symbol];
  m.buyLine.applyOptions({ price: d.buyAbove });
  m.sellLine.applyOptions({ price: d.sellBelow });

  // Position du prix par rapport à l'EMA, sur une échelle de ±5 %
  const SCALE = 0.05;
  const gap = price / d.ema - 1;
  const zones = { low: (d.sellBelow / d.ema - 1) / SCALE, high: (d.buyAbove / d.ema - 1) / SCALE };
  const active = state.active.includes(symbol);
  m.panel.classList.toggle("inactive", !active);
  const detail = `${active ? d.reason : "Actif non retenu pour cette simulation : le bot n'y investit pas"}. Prix ${signed(gap * 100, 1)} % par rapport à l'EMA ${state.config.strategy.emaPeriod} (${nf(d.ema)}), achat au-dessus de ${nf(d.buyAbove)}, vente sous ${nf(d.sellBelow)}. Biais news ${d.news === null ? "–" : signed(d.news)} (${d.headlinesUsed} titres).`;
  m.signal.replaceChildren(gauge(gap / SCALE, zones, `${signed(gap * 100, 1)} %`), el("span", { class: `action ${d.trend === "up" ? "up" : d.trend === "down" ? "down" : ""}` }, TRENDS[d.trend]), el("span", { class: "why" }, detail));
}

function renderLive(live) {
  $("feed").className = `feed${live.feedOk ? " ok" : ""}`;
  $("feed").textContent = live.feedOk ? `Prix Binance en direct, ${clock(live.time)}. Décisions à chaque clôture de bougie ${state.config.strategy.interval}.` : "Flux de prix interrompu, reconnexion…";

  $("equity").replaceChildren(nf(live.equity), el("small", {}, " USDT"));
  $("pnl").className = `delta ${live.pnl >= 0 ? "up" : "down"}`;
  $("pnl").textContent = `${live.pnl >= 0 ? "▲" : "▼"} ${signed(live.pnl)} USDT (${signed((live.pnl / state.startCash) * 100)} %) depuis le ${when(state.startedAt)}`;

  const rows = [["Cash", `${nf(live.cash)} USDT`, ""]];
  for (const p of live.positions) rows.push([base(p.symbol), `${nf(p.value)} USDT`, `entrée ${nf(p.entryPrice)}, ${signed(p.gain * 100)} %`]);
  if (!live.positions.length) rows.push(["Positions", "Aucune", ""]);
  $("holdings").replaceChildren(...rows.flatMap(([k, v, sub]) => [el("dt", {}, k), el("dd", {}, v, ...(sub ? [el("small", {}, sub)] : []))]));

  const s = live.stats;
  $("stats").textContent = s.closed
    ? `${s.closed} aller-retour(s) terminé(s), ${nf((s.wins / s.closed) * 100, 0)} % gagnants, ${signed(s.realized)} USDT réalisés, ${nf(s.fees)} USDT de frais.`
    : `${nf(s.fees)} USDT de frais payés, aucun aller-retour terminé pour l'instant.`;

  for (const symbol of state.config.symbols) {
    const price = live.prices[symbol];
    if (!price) continue;
    markets[symbol].price.textContent = nf(price);
    pushPrice(symbol, price, live.time);
    if (live.signals[symbol]) renderSignal(symbol, live.signals[symbol], price);
  }
  pushEquity(live.time, live.equity);
}

function table(head, rows) {
  return el("table", {}, el("thead", {}, el("tr", {}, ...head.map(([label, cls]) => el("th", cls ? { class: cls } : {}, label)))), el("tbody", {}, ...rows));
}

function renderTrades() {
  if (!state.trades.length) {
    $("trades").replaceChildren(el("p", { class: "empty" }, "Aucun ordre pour l'instant : le bot n'achète que lorsqu'une bougie clôture au-dessus du seuil d'achat."));
    return;
  }
  const head = [["Date"], ["Actif"], ["Sens"], ["Prix", "num"], ["Montant", "num"], ["Résultat net", "num"], ["Raison"]];
  const rows = [...state.trades].reverse().slice(0, 200).map((t) =>
    el(
      "tr",
      {},
      el("td", { class: "nowrap" }, when(t.time)),
      el("td", {}, base(t.symbol)),
      el("td", {}, el("span", { class: `action ${t.side === "BUY" ? "up" : "down"}` }, ACTIONS[t.side])),
      el("td", { class: "num" }, nf(t.price)),
      el("td", { class: "num" }, nf(t.usdt)),
      el("td", { class: `num ${t.pnl === undefined ? "" : t.pnl >= 0 ? "up" : "down"}` }, t.pnl === undefined ? "" : signed(t.pnl)),
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

function segmented(container, options, selected, onPick) {
  const press = (value) => [...container.children].forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === String(value))));
  container.replaceChildren(
    ...options.map(([label, value]) => {
      const button = el("button", {}, label);
      button.dataset.value = value;
      button.addEventListener("click", () => {
        press(value);
        onPick(value);
      });
      return button;
    }),
  );
  press(selected);
}

// ---------- Replay du backtest ----------

const FRAME_MS = 50;
const replay = { data: null, chart: null, index: 0, speed: 5, timer: null, strategy: null, hold: null, markers: null };

function setupReplay() {
  replay.chart = createChart($("replayChart"), false);
  replay.hold = replay.chart.addSeries(LW.LineSeries, { color: css("--muted"), lineWidth: 2, priceLineVisible: false });
  replay.strategy = replay.chart.addSeries(LW.LineSeries, { color: css("--accent"), lineWidth: 2, priceLineVisible: false });
  replay.markers = LW.createSeriesMarkers(replay.strategy, []);
}

function replayStep() {
  const { times, strategy, hold, trades, stats } = replay.data;
  // speed = nombre de bougies révélées par image ; Infinity affiche tout d'un coup
  const end = Math.min(times.length, replay.index + replay.speed);
  if (end - replay.index > 500) {
    replay.strategy.setData(times.slice(0, end).map((t, i) => ({ time: sec(t), value: strategy[i] })));
    replay.hold.setData(times.slice(0, end).map((t, i) => ({ time: sec(t), value: hold[i] })));
  } else {
    for (let i = replay.index; i < end; i++) {
      replay.strategy.update({ time: sec(times[i]), value: strategy[i] });
      replay.hold.update({ time: sec(times[i]), value: hold[i] });
    }
  }
  replay.index = end;
  const now = times[end - 1];
  const done = trades.filter((t) => Date.parse(t.time) <= now);
  replay.markers.setMarkers(done.map((t) => tradeMarker(t, sec(Date.parse(t.time)))));
  replay.chart.timeScale().fitContent();

  const pct = (n) => `${signed(n * 100, 1)} %`;
  const assets = replay.data.symbols.map(base).join(" + ");
  if (end < times.length) {
    $("replayStats").textContent = `${assets}, ${day(now)} : stratégie ${nf(strategy[end - 1])} USDT, acheter et garder ${nf(hold[end - 1])} USDT, ${done.length} ordres.`;
    return;
  }
  clearInterval(replay.timer);
  $("replayStats").textContent = `${assets}, du ${day(times[0])} au ${day(now)} : stratégie ${pct(stats.strategyReturn)} (pire creux −${nf(stats.strategyDrawdown * 100, 0)} %), acheter et garder ${pct(stats.holdReturn)} (pire creux −${nf(stats.holdDrawdown * 100, 0)} %). ${stats.closed} allers-retours dont ${stats.wins} gagnants, ${nf(stats.fees)} USDT de frais : le suivi de tendance perd souvent un peu et gagne rarement beaucoup. Un résultat passé ne garantit rien pour la suite.`;
}

function playReplay() {
  clearInterval(replay.timer);
  if (replay.data && replay.speed && replay.index < replay.data.times.length) replay.timer = setInterval(replayStep, FRAME_MS);
}

async function startReplay() {
  if (!replay.data) {
    $("replayStats").textContent = `Chargement de ${state.config.backtestYears} ans de bougies Binance…`;
    replay.data = await api("/api/backtest");
  }
  $("replayChart").hidden = false;
  $("replayLegend").hidden = false;
  if (!replay.chart) setupReplay();
  replay.index = 0;
  replay.strategy.setData([]);
  replay.hold.setData([]);
  playReplay();
}

// ---------- Données ----------

function notify(message) {
  $("status").hidden = !message;
  $("status").textContent = message;
}

async function api(path, method = "GET", payload) {
  const res = await fetch(path, { method, ...(payload ? { headers: { "content-type": "application/json" }, body: JSON.stringify(payload) } : {}) });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);
  return body;
}

async function load() {
  state = await api("/api/state");
  // Le replay dépend des actifs choisis : on le recalcule à la prochaine lecture
  clearInterval(replay.timer);
  replay.data = null;
  replay.strategy?.setData([]);
  replay.hold?.setData([]);
  replay.markers?.setMarkers([]);
  $("replayStats").textContent = "";
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

  segmented($("intervals"), Object.keys(INTERVALS).map((key) => [key === "1d" ? "1D" : key, key]), interval, (key) => {
    interval = key;
    loadCandles(true).catch((err) => notify(err.message));
  });
  segmented($("replaySpeed"), [["Pause", 0], ["×1", 1], ["×5", 5], ["×25", 25], ["Fin", Infinity]], replay.speed, (value) => {
    replay.speed = Number(value);
    playReplay();
  });
  $("replayStart").addEventListener("click", () => startReplay().catch((err) => notify(err.message)));

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

// Nouvelle simulation : choix des actifs, puis remise à zéro du portefeuille
$("reset").addEventListener("click", () => {
  $("setupIntro").textContent = `Le portefeuille repart à ${nf(state.startCash, 0)} USDT, répartis à parts égales entre les actifs cochés. L'historique des ordres est effacé.`;
  $("setupError").textContent = "";
  $("setupAssets").replaceChildren(
    ...state.config.symbols.map((symbol) => {
      const input = el("input", { type: "checkbox", name: "symbols", value: symbol });
      input.checked = state.active.includes(symbol);
      return el("label", { class: "asset" }, input, el("strong", {}, base(symbol)), el("small", {}, ASSET_NOTES[base(symbol)] ?? ""));
    }),
  );
  $("setup").showModal();
});

$("setupStart").addEventListener("click", async (event) => {
  event.preventDefault();
  const symbols = [...$("setupAssets").querySelectorAll("input:checked")].map((input) => input.value);
  try {
    await api("/api/reset", "POST", { symbols });
    $("setup").close();
  } catch (err) {
    $("setupError").textContent = err.message;
  }
});

init().catch((err) => notify(`Impossible de joindre le bot : ${err.message}`));
