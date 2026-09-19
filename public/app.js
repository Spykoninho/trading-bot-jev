const LW = LightweightCharts;
const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// L'espace fine insécable de fr-FR n'existe pas dans toutes les polices : on la remplace par une insécable classique
const nf = (n, d = 2) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n).replace(/ /g, " ");
const signed = (n, d = 2) => `${n >= 0 ? "+" : "−"}${nf(Math.abs(n), d)}`;
const clock = (t) => new Date(t).toLocaleTimeString("fr-FR");
const day = (t) => new Date(t).toLocaleDateString("fr-FR");
const when = (t) => new Date(t).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
// Devise de cotation du bot : tout l'affichage en dépend, plus rien n'est codé en dur
const quote = () => state?.config?.quote ?? "USDC";
const base = (symbol) => (symbol.endsWith(`-${quote()}`) ? symbol.slice(0, -quote().length - 1) : symbol);
const short = (title) => (title.length > 180 ? `${title.slice(0, 180)}…` : title);
// Titre + réponses de Jev aux questions propres à la source (décision de taux, escalade commerciale…)
const titleCell = (j) => el("td", {}, short(j.headline.title), ...(j.details ? [el("small", {}, Object.entries(j.details).map(([k, v]) => `${k} : ${v}`).join(" · "))] : []));
const ACTIONS = { BUY: "▲ Achat", SELL: "▼ Vente", HOLD: "■ Attente" };
const TRENDS = { up: "▲ Tendance haussière", down: "▼ Tendance baissière", none: "■ Pas de tendance" };
const INTERVALS = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14_400, "1d": 86_400 };
// Volatilité journalière mesurée sur 3 ans de bougies, pour aider à choisir
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
let holdSeries;
let lastEquityTime = 0;
const markets = {};

function pushEquity(ms, value, hold) {
  const time = sec(ms);
  if (time <= lastEquityTime) return;
  lastEquityTime = time;
  equitySeries.update({ time, value });
  if (typeof hold === "number") holdSeries.update({ time, value: hold });
}

function setupEquity() {
  const up = css("--up");
  const down = css("--down");
  const chart = createChart($("equityChart"), true);
  // Témoin : ce que vaudrait le capital de départ acheté une fois puis jamais touché
  holdSeries = chart.addSeries(LW.LineSeries, { color: css("--plain"), lineWidth: 2, lineStyle: LW.LineStyle.Dashed, priceLineVisible: false, title: "acheter et garder" });
  equitySeries = chart.addSeries(LW.BaselineSeries, {
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
  holdSeries.setData([]);
  for (const h of state.history) pushEquity(Date.parse(h.time), h.equity, h.hold);
}

function setupMarket(symbol) {
  const price = el("strong", {}, "–");
  const chartBox = el("div", { class: "chart" });
  const signal = el("div", { class: "signal" });
  const panel = el("section", { class: "panel", "aria-label": `Cours ${base(symbol)}` }, el("div", { class: "market-head" }, el("h2", {}, `${base(symbol)} / ${quote()}`), price), chartBox, signal);
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
  const detail = `${active ? d.reason : "actif non retenu pour cette simulation"} · achat au-dessus de ${nf(d.buyAbove)}, vente sous ${nf(d.sellBelow)} · biais news ${d.news === null ? "–" : signed(d.news)}`;
  m.signal.replaceChildren(gauge(gap / SCALE, zones, `${signed(gap * 100, 1)} %`), el("span", { class: `action ${d.trend === "up" ? "up" : d.trend === "down" ? "down" : ""}` }, TRENDS[d.trend]), el("span", { class: "why" }, detail));
}

// Bandeau rouge : désynchronisation avec l'exchange, ou actif dont les bougies ne se chargent plus
function renderAlerts(live) {
  const down = Object.entries(live.unavailable ?? {}).map(([symbol, why]) => `${base(symbol)} indisponible : ${why}`);
  const lines = [live.desynced ? `Portefeuille papier et compte Bitvavo ne correspondent plus : ${live.desynced}. Vérifie tes positions sur Bitvavo avant de continuer.` : "", ...down].filter(Boolean);
  $("alert").hidden = !lines.length;
  $("alert").textContent = lines.join(" · ");
}

// ---------- Notifications (cloche, panneau, toasts) ----------
// Contrat : live.alerts / state.alerts = { id, time, level: "error"|"warn"|"info", message }[], id croissant.
// Le champ peut être absent ou vide tant que l'autre agent ne l'a pas encore branché côté serveur.

const ALERT_LEVELS = { error: { label: "Erreur" }, warn: { label: "Avertissement" }, info: { label: "Info" } };
const TOAST_TTL_MS = 8000;
const MAX_TOASTS = 4;
const RECENT_ERROR_MS = 10 * 60 * 1000;
const LAST_SEEN_KEY = "jev-notif-last-seen-id";
const REDUCE_MOTION = matchMedia("(prefers-reduced-motion: reduce)");

function loadLastSeenId() {
  try {
    return Number(localStorage.getItem(LAST_SEEN_KEY)) || 0;
  } catch {
    return 0;
  }
}
function saveLastSeenId(id) {
  try {
    localStorage.setItem(LAST_SEEN_KEY, String(id));
  } catch {}
}

const notif = { alerts: [], lastSeenId: loadLastSeenId(), highWaterId: 0, panelOpen: false };
let alertsBootstrapped = false;
let connectionLost = false;
const toastMap = new Map();
const toastTimers = new Map();

const levelOf = (a) => (ALERT_LEVELS[a.level] ? a.level : "info");

function relTime(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 10) return "à l'instant";
  if (s < 60) return `il y a ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return `il y a ${Math.floor(h / 24)} j`;
}

// Icônes statiques, aucune donnée externe n'y transite (le message, lui, reste toujours en textContent)
const ICON_PATHS = {
  error: '<circle cx="8" cy="8" r="6.3"/><line x1="8" y1="4.6" x2="8" y2="8.6"/><circle cx="8" cy="11.2" r="0.7" fill="currentColor" stroke="none"/>',
  warn: '<path d="M8 2.2 14.3 13.4H1.7Z"/><line x1="8" y1="6.2" x2="8" y2="9.6"/><circle cx="8" cy="11.6" r="0.7" fill="currentColor" stroke="none"/>',
  info: '<circle cx="8" cy="8" r="6.3"/><line x1="8" y1="7.2" x2="8" y2="11.4"/><circle cx="8" cy="4.9" r="0.7" fill="currentColor" stroke="none"/>',
};
function icon(level) {
  const span = el("span", { class: `notif-icon notif-${level}`, "aria-hidden": "true" });
  span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[level] ?? ICON_PATHS.info}</svg>`;
  return span;
}

function ingestAlerts(list) {
  const map = new Map(notif.alerts.map((a) => [a.id, a]));
  for (const a of list) if (a && typeof a.id === "number" && typeof a.message === "string") map.set(a.id, a);
  notif.alerts = [...map.values()].sort((a, b) => a.id - b.id).slice(-300);
}

// Point d'entrée unique pour toute source d'alertes (état initial, tick, flux dédié) : tolère un champ absent
function syncAlerts(list) {
  const bootstrap = !alertsBootstrapped;
  alertsBootstrapped = true;
  if (Array.isArray(list) && list.length) ingestAlerts(list);
  const maxId = notif.alerts.at(-1)?.id ?? 0;

  if (bootstrap) {
    // Premier chargement : pas de rejeu de l'historique en toasts, sauf les erreurs encore fraîches (< 10 min)
    const now = Date.now();
    for (const a of notif.alerts.filter((a) => a.level === "error" && now - a.time < RECENT_ERROR_MS)) pushToast({ id: a.id, level: "error", time: a.time, message: a.message });
    notif.highWaterId = maxId;
    notif.lastSeenId = Math.max(notif.lastSeenId, maxId);
    saveLastSeenId(notif.lastSeenId);
  } else {
    const fresh = notif.alerts.filter((a) => a.id > notif.highWaterId);
    if (fresh.length) {
      notif.highWaterId = fresh.at(-1).id;
      for (const a of fresh) pushToast({ id: a.id, level: levelOf(a), time: a.time, message: a.message });
    }
  }
  updateBadge();
  if (notif.panelOpen) renderNotifPanel();
}

function updateBadge() {
  const unread = notif.alerts.filter((a) => a.id > notif.lastSeenId).length;
  $("notifBadge").hidden = unread === 0;
  $("notifBadge").textContent = unread > 99 ? "99+" : String(unread);
  $("notifBtn").setAttribute("aria-label", unread ? `Notifications, ${unread} non lue${unread > 1 ? "s" : ""}` : "Notifications");
}

function renderNotifPanel() {
  const list = [...notif.alerts].reverse();
  if (!list.length) {
    $("notifList").replaceChildren(el("p", { class: "empty-panel" }, "Aucune alerte pour l'instant."));
    return;
  }
  $("notifList").replaceChildren(
    ...list.map((a) => {
      const lvl = levelOf(a);
      return el(
        "div",
        { class: `notif-item notif-${lvl}${a.id > notif.lastSeenId ? " unread" : ""}` },
        icon(lvl),
        el(
          "div",
          { class: "notif-item-body" },
          el("div", { class: "notif-item-head" }, el("span", { class: "notif-level" }, ALERT_LEVELS[lvl].label), el("time", { title: when(a.time) }, relTime(a.time))),
          el("p", {}, a.message),
        ),
      );
    }),
  );
}

function markAllRead() {
  notif.lastSeenId = Math.max(notif.lastSeenId, notif.highWaterId, notif.alerts.at(-1)?.id ?? 0);
  saveLastSeenId(notif.lastSeenId);
  updateBadge();
  renderNotifPanel();
}

function openNotifPanel() {
  notif.panelOpen = true;
  $("notifPanel").hidden = false;
  $("notifBtn").setAttribute("aria-expanded", "true");
  renderNotifPanel();
  document.addEventListener("keydown", onNotifKeydown);
  document.addEventListener("click", onNotifOutsideClick, true);
}
function closeNotifPanel(returnFocus = true) {
  if (!notif.panelOpen) return;
  notif.panelOpen = false;
  $("notifPanel").hidden = true;
  $("notifBtn").setAttribute("aria-expanded", "false");
  document.removeEventListener("keydown", onNotifKeydown);
  document.removeEventListener("click", onNotifOutsideClick, true);
  if (returnFocus) $("notifBtn").focus();
}
function onNotifKeydown(event) {
  if (event.key === "Escape") {
    event.stopPropagation();
    closeNotifPanel();
  }
}
function onNotifOutsideClick(event) {
  if (!$("notifPanel").contains(event.target) && !$("notifBtn").contains(event.target)) closeNotifPanel(false);
}

// ---------- Toasts ----------

function buildToastNode({ id, level, time, message, protectedToast }) {
  const lvl = ALERT_LEVELS[level] ? level : "info";
  const closeBtn = el("button", { type: "button", class: "toast-close", "aria-label": "Fermer la notification" }, "×");
  const node = el(
    "div",
    { class: `toast toast-${lvl}`, role: lvl === "error" ? "alert" : "status", "data-level": lvl },
    icon(lvl),
    el("div", { class: "toast-body" }, el("div", { class: "toast-head" }, el("span", { class: "toast-level" }, ALERT_LEVELS[lvl].label), el("time", {}, clock(time))), el("p", { class: "toast-message" }, message)),
    closeBtn,
  );
  node._toastId = id;
  if (protectedToast) node.dataset.protected = "true";
  closeBtn.addEventListener("click", () => dismissToast(id));
  if (lvl !== "error") {
    node.addEventListener("mouseenter", () => pauseToastTimer(id));
    node.addEventListener("mouseleave", () => resumeToastTimer(id));
    node.addEventListener("focusin", () => pauseToastTimer(id));
    node.addEventListener("focusout", () => resumeToastTimer(id));
  }
  return node;
}

// info/warn se referment seuls après ~8 s (pause au survol/focus) ; error reste jusqu'à fermeture manuelle
function pushToast({ id, level, time, message }, { protectedToast = false } = {}) {
  if (toastMap.has(id)) return;
  const node = buildToastNode({ id, level, time, message, protectedToast });
  toastMap.set(id, node);
  $("toasts").append(node);
  if (level !== "error") startToastTimer(id);
  trimToasts();
  refreshToastsLiveness();
}

function dismissToast(id) {
  const node = toastMap.get(id);
  if (!node) return;
  toastMap.delete(id);
  stopToastTimer(id);
  collapseAndRemove(node);
  refreshToastsLiveness();
}

// Maximum 4 toasts visibles : les plus anciens se replient (le toast de connexion persistant y échappe)
function trimToasts() {
  const container = $("toasts");
  let extra = container.children.length - MAX_TOASTS;
  for (const node of [...container.children]) {
    if (extra <= 0) break;
    if (node.dataset.protected === "true" || node.classList.contains("toast-leaving")) continue;
    dismissToast(node._toastId);
    extra--;
  }
}

function collapseAndRemove(node) {
  if (REDUCE_MOTION.matches) return node.remove();
  node.classList.add("toast-leaving");
  const remove = () => node.remove();
  node.addEventListener("transitionend", remove, { once: true });
  setTimeout(remove, 400);
}

function refreshToastsLiveness() {
  const hasError = [...$("toasts").children].some((n) => n.dataset.level === "error" && !n.classList.contains("toast-leaving"));
  $("toasts").setAttribute("aria-live", hasError ? "assertive" : "polite");
}

function startToastTimer(id) {
  toastTimers.set(id, { remaining: TOAST_TTL_MS, start: Date.now(), timeoutId: null });
  scheduleToastTimeout(id);
}
function scheduleToastTimeout(id) {
  const t = toastTimers.get(id);
  if (!t) return;
  t.start = Date.now();
  t.timeoutId = setTimeout(() => dismissToast(id), t.remaining);
}
function pauseToastTimer(id) {
  const t = toastTimers.get(id);
  if (!t || t.timeoutId === null) return;
  clearTimeout(t.timeoutId);
  t.remaining -= Date.now() - t.start;
  t.timeoutId = null;
}
function resumeToastTimer(id) {
  const t = toastTimers.get(id);
  if (!t || t.timeoutId !== null || t.remaining <= 0) return;
  scheduleToastTimeout(id);
}
function stopToastTimer(id) {
  const t = toastTimers.get(id);
  if (t) clearTimeout(t.timeoutId);
  toastTimers.delete(id);
}

// Connexion perdue/rétablie : toast d'erreur persistant unique, remplacé par un toast info au retour
function markConnectionLost() {
  if (connectionLost) return;
  connectionLost = true;
  dismissToast("connection-restored");
  pushToast({ id: "connection-lost", level: "error", time: Date.now(), message: "Connexion au bot perdue" }, { protectedToast: true });
}
function markConnectionRestored() {
  if (!connectionLost) return;
  connectionLost = false;
  dismissToast("connection-lost");
  pushToast({ id: "connection-restored", level: "info", time: Date.now(), message: "Connexion rétablie" });
}

$("notifBtn").addEventListener("click", () => (notif.panelOpen ? closeNotifPanel() : openNotifPanel()));
$("notifMarkAll").addEventListener("click", markAllRead);
updateBadge();

function renderLive(live) {
  $("feed").className = `feed${live.feedOk ? " ok" : ""}`;
  const mode = { paper: "Portefeuille papier", real: "ORDRES RÉELS sur Bitvavo" }[state.config.mode];
  $("feed").textContent = live.feedOk ? `${mode}. Prix en direct, ${clock(live.time)}.` : "Flux de prix interrompu, reconnexion…";
  renderAlerts(live);
  syncAlerts(live.alerts);

  $("equity").replaceChildren(nf(live.equity), el("small", {}, ` ${quote()}`));
  $("pnl").className = `delta ${live.pnl >= 0 ? "up" : "down"}`;
  $("pnl").textContent = `${live.pnl >= 0 ? "▲" : "▼"} ${signed(live.pnl)} ${quote()} (${signed((live.pnl / state.startCash) * 100)} %) depuis le ${when(state.startedAt)}`;

  const rows = [["Cash", `${nf(live.cash)} ${quote()}`, ""]];
  for (const p of live.positions) rows.push([`${base(p.symbol)}${p.event ? " (événement)" : ""}`, `${nf(p.value)} ${quote()}`, `entrée ${nf(p.entryPrice)}, ${signed(p.gain * 100)} %${p.exitAt ? `, sortie à ${clock(p.exitAt)}` : ""}`]);
  if (!live.positions.length) rows.push(["Positions", "Aucune", ""]);
  $("holdings").replaceChildren(...rows.flatMap(([k, v, sub]) => [el("dt", {}, k), el("dd", {}, v, ...(sub ? [el("small", {}, sub)] : []))]));

  const s = live.stats;
  $("stats").textContent = s.closed
    ? `${s.closed} aller-retour(s) terminé(s), ${nf((s.wins / s.closed) * 100, 0)} % gagnants, ${signed(s.realized)} ${quote()} réalisés, ${nf(s.fees)} ${quote()} de frais.`
    : `${nf(s.fees)} ${quote()} de frais payés, aucun aller-retour terminé pour l'instant.`;

  for (const symbol of state.config.symbols) {
    const price = live.prices[symbol];
    if (!price) continue;
    markets[symbol].price.textContent = nf(price);
    pushPrice(symbol, price, live.time);
    if (live.signals[symbol]) renderSignal(symbol, live.signals[symbol], price);
  }
  pushEquity(live.time, live.equity, live.hold);
  renderVersus(live);
}

// Le bot face à « acheter une fois et ne plus toucher », depuis le même départ
function renderVersus(live) {
  if (typeof live.hold !== "number") return void ($("versus").textContent = "");
  const gap = live.equity - live.hold;
  $("versus").replaceChildren(
    `Acheter et garder : ${nf(live.hold)} ${quote()} (${signed((live.hold / state.startCash - 1) * 100)} %). Le bot fait `,
    el("strong", { class: gap >= 0 ? "up" : "down" }, `${signed(gap)} ${quote()}`),
    gap >= 0 ? " de mieux." : " de moins.",
  );
}

function table(head, rows) {
  return el("table", {}, el("thead", {}, el("tr", {}, ...head.map(([label, cls]) => el("th", cls ? { class: cls } : {}, label)))), el("tbody", {}, ...rows));
}

function renderTrades() {
  // Ordres et attentes dans un même journal, du plus récent au plus ancien
  const journal = [...state.trades, ...state.waits.map((w) => ({ ...w, side: "HOLD" }))].sort((a, b) => b.time.localeCompare(a.time)).slice(0, 200);
  if (!journal.length) {
    $("trades").replaceChildren(el("p", { class: "empty" }, "Aucune décision pour l'instant : la première arrive à la prochaine clôture de bougie."));
    return;
  }
  const head = [["Date"], ["Actif"], ["Décision"], ["Prix", "num"], ["Montant", "num"], ["Résultat net", "num"], ["Raison"]];
  const rows = journal.map((t) =>
    el(
      "tr",
      {},
      el("td", { class: "nowrap" }, when(t.time)),
      el("td", {}, base(t.symbol)),
      el("td", {}, el("span", { class: `action ${t.side === "BUY" ? "up" : t.side === "SELL" ? "down" : ""}` }, ACTIONS[t.side])),
      el("td", { class: "num" }, nf(t.price)),
      el("td", { class: "num" }, t.usdt === undefined ? "" : nf(t.usdt)),
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
  const head = [["Paru"], ["Source"], ["Titre"], ["Actif"], ["Confiance", "num"], ["Sentiment"], ["Impact marché", "num"], ["Risque réglementaire", "num"]];
  const rows = state.judgments.map((j) =>
    el(
      "tr",
      j.asset === "unrelated" || j.assetConfidence < state.config.news.minConfidence ? { class: "ignored" } : {},
      el("td", { class: "nowrap" }, when(j.headline.publishedAt)),
      el("td", {}, j.headline.source),
      titleCell(j),
      el("td", {}, j.asset),
      el("td", { class: "num" }, nf(j.assetConfidence)),
      el("td", {}, gauge(j.sentiment)),
      el("td", { class: "num" }, nf(j.material)),
      el("td", { class: "num" }, nf(j.regulatoryRisk)),
    ),
  );
  $("news").replaceChildren(table(head, rows));
}

const HORIZON_LABELS = { 5: "+5 min", 15: "+15 min", 60: "+1 h", 240: "+4 h" };

function renderEvents() {
  const { list, scoreboard, sources } = state.events;
  const names = (kind) => sources.filter((s) => s.kind === kind).map((s) => s.name.replace(/ \(.*/, "")).join(", ");
  const rules = state.config.eventRules.map((r) => `« ${r.name} » → achat de ${nf(r.share * 100, 0)} %, revendu après ${r.holdMin / 60} h`);
  $("sources").textContent = `Presse : ${names("presse")}. Sources primaires : ${names("primaire")}. Circuit immédiat : ${rules.join(" ; ") || "désactivé"}.`;

  if (!list.length) {
    $("eventStats").replaceChildren();
    $("events").replaceChildren(el("p", { class: "empty" }, "Aucune publication captée à chaud pour l'instant."));
    return;
  }

  // Bilan : rendement moyen dans le sens de Jev, et nombre de cas où le prix l'a suivi
  const cell = (g) => el("td", { class: "num" }, g.n ? `${signed(g.mean * 100)} % (${g.wins}/${g.n})` : "…");
  const bilan = Object.entries({ "Fort impact selon Jev": scoreboard.groups.fort, Autres: scoreboard.groups.autres }).map(([label, group]) =>
    el("tr", {}, el("td", {}, label), ...Object.keys(HORIZON_LABELS).map((h) => cell(group[h]))),
  );
  $("eventStats").replaceChildren(
    el("p", {}, `${scoreboard.tracked} publications captées depuis le ${when(list.at(-1).seenAt)}, retard médian ${scoreboard.medianLatencySec} s. Entre parenthèses : cas où le prix a suivi Jev.`),
    table([["Bilan"], ...Object.values(HORIZON_LABELS).map((name) => [name, "num"])], bilan),
  );

  const head = [["Vu à"], ["Source"], ["Retard", "num"], ["Titre"], ["Actif"], ["Avis de Jev"], ["Impact", "num"], ...Object.values(HORIZON_LABELS).map((name) => [name, "num"])];
  const rows = list.map((e) => {
    const readings = Object.keys(HORIZON_LABELS).map((h) => {
      if (e.after[h] === undefined) return el("td", { class: "num" }, "…");
      const r = e.direction * (e.after[h] / e.priceAtSeen - 1);
      return el("td", { class: `num ${r >= 0 ? "up" : "down"}` }, `${signed(r * 100)} %`);
    });
    return el(
      "tr",
      {},
      el("td", { class: "nowrap" }, when(e.seenAt)),
      el("td", {}, e.judgment.headline.source),
      el("td", { class: "num nowrap" }, `${e.latencySec} s`),
      titleCell(e.judgment),
      el("td", {}, base(e.symbol)),
      el("td", {}, el("span", { class: `action ${e.direction > 0 ? "up" : "down"}` }, `${e.direction > 0 ? "▲" : "▼"} ${signed(e.judgment.sentiment)}`)),
      el("td", { class: "num" }, nf(e.judgment.material)),
      ...readings,
    );
  });
  $("events").replaceChildren(table(head, rows));
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
const replay = { data: null, chart: null, index: 0, speed: 5, timer: null, jev: null, plain: null, hold: null, markers: null };

function setupReplay() {
  replay.chart = createChart($("replayChart"), false);
  const line = (color) => replay.chart.addSeries(LW.LineSeries, { color, lineWidth: 2, priceLineVisible: false });
  replay.hold = line(css("--muted"));
  replay.plain = line(css("--plain"));
  replay.jev = line(css("--accent"));
}

function replayStep() {
  const { times, hold, holdStats, plain, jev, news } = replay.data;
  // Les flèches suivent la variante principale : avec Jev si les titres d'époque sont disponibles
  const main = jev ?? plain;
  const lines = [[replay.hold, hold], [replay.plain, plain.curve], ...(jev ? [[replay.jev, jev.curve]] : [])];
  // speed = nombre de bougies révélées par image ; Infinity affiche tout d'un coup
  const end = Math.min(times.length, replay.index + replay.speed);
  for (const [series, curve] of lines) {
    if (end - replay.index > 500) series.setData(times.slice(0, end).map((t, i) => ({ time: sec(t), value: curve[i] })));
    else for (let i = replay.index; i < end; i++) series.update({ time: sec(times[i]), value: curve[i] });
  }
  replay.index = end;
  const now = times[end - 1];
  const done = main.trades.filter((t) => Date.parse(t.time) <= now);
  replay.markers ??= LW.createSeriesMarkers(jev ? replay.jev : replay.plain, []);
  replay.markers.setMarkers(done.map((t) => tradeMarker(t, sec(Date.parse(t.time)))));
  replay.chart.timeScale().fitContent();

  const assets = replay.data.symbols.map(base).join(" + ");
  const pct = (n) => `${signed(n * 100, 1)} %`;
  if (end < times.length) {
    const live = [jev && `avec Jev ${nf(jev.curve[end - 1])}`, `sans news ${nf(plain.curve[end - 1])}`, `acheter et garder ${nf(hold[end - 1])}`].filter(Boolean).join(", ");
    $("replayStats").textContent = `${assets}, ${day(now)} : ${live} ${quote()}, ${done.length} ordres.`;
    return;
  }
  clearInterval(replay.timer);
  // Rendement, risque et régularité : le rendement seul ne dit pas à quel prix il a été obtenu
  const ratios = (c) => `CAGR ${pct(c.cagr)}, Sharpe ${nf(c.sharpe)}, Sortino ${nf(c.sortino)}, MAR ${nf(c.mar)}`;
  const line = (label, s) => `${label} ${pct(s.strategy.return)} (pire creux −${nf(s.strategy.drawdown * 100, 0)} %, ${ratios(s.strategy)}, ${s.closed} allers-retours dont ${s.wins} gagnants, ${nf(s.fees)} ${quote()} de frais)`;
  const profile = (p) => `Allers-retours : ${p.count}, ${nf(p.winRate * 100, 0)} % gagnants, médiane ${pct(p.median)}, p10 ${pct(p.p10)}, p90 ${pct(p.p90)}, pire perte ${pct(p.worst)}, les 5 meilleurs font ${nf(p.top5Share * 100, 0)} % du gain cumulé.`;
  const parts = [
    `${assets}, du ${day(times[0])} au ${day(now)}.`,
    jev ? `${line("Avec Jev :", jev.stats)}.` : "",
    `${line("Sans news :", plain.stats)}.`,
    `Acheter et garder : ${pct(holdStats.return)} (pire creux −${nf(holdStats.drawdown * 100, 0)} %, ${ratios(holdStats)}).`,
    profile((jev ?? plain).stats.profile),
    jev
      ? `Jev a jugé ${nf(news.headlines, 0)} titres d'époque, qui couvrent ${news.daysCovered} jours sur ${news.days} ; les autres jours, les deux variantes décident à l'identique.`
      : "Pas encore de titres d'époque : lance « npm run history » pour comparer avec et sans Jev.",
    "Un résultat passé ne garantit rien pour la suite.",
  ];
  $("replayStats").textContent = parts.filter(Boolean).join(" ");
}

function playReplay() {
  clearInterval(replay.timer);
  if (replay.data && replay.speed && replay.index < replay.data.times.length) replay.timer = setInterval(replayStep, FRAME_MS);
}

async function startReplay() {
  if (!replay.data) {
    $("replayStats").textContent = `Chargement de ${state.config.backtestYears} ans de bougies…`;
    replay.data = await api("/api/backtest");
  }
  $("replayChart").hidden = false;
  $("replayLegend").hidden = false;
  if (!replay.chart) setupReplay();
  replay.index = 0;
  for (const series of [replay.jev, replay.plain, replay.hold]) series.setData([]);
  $("keyJev").hidden = !replay.data.jev;
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
  syncAlerts(state.alerts);
  // Le replay dépend des actifs choisis : on le recalcule à la prochaine lecture
  clearInterval(replay.timer);
  replay.data = null;
  for (const series of [replay.jev, replay.plain, replay.hold]) series?.setData([]);
  replay.markers?.detach();
  replay.markers = null;
  $("replayStats").textContent = "";
  loadEquity();
  renderTrades();
  renderNews();
  renderEvents();
  renderLive(state.live);
  await loadCandles(true);
}

// En réel, le tableau de bord ne sert qu'au suivi : ni replay, ni nouvelle simulation
function applyMode() {
  const real = state.config.mode === "real";
  $("reset").hidden = real;
  $("replaySection").hidden = real;
}

async function init() {
  state = await api("/api/state");
  applyMode();
  setupEquity();
  $("equityCaption").textContent = `Valeur du portefeuille en ${quote()}, vert au-dessus du capital de départ, rouge en dessous. En pointillés orange : le même capital acheté au départ puis jamais touché.`;
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
  stream.addEventListener("waits", (e) => {
    state.waits = JSON.parse(e.data);
    renderTrades();
  });
  stream.addEventListener("news", (e) => {
    state.judgments = JSON.parse(e.data);
    renderNews();
  });
  stream.addEventListener("events", (e) => {
    state.events = JSON.parse(e.data);
    renderEvents();
  });
  // Canal dédié éventuel, en plus de state.alerts et live.alerts : syncAlerts() dédoublonne par id dans tous les cas
  stream.addEventListener("alerts", (e) => syncAlerts(JSON.parse(e.data)));
  stream.addEventListener("reset", load);
  stream.onopen = () => {
    notify("");
    markConnectionRestored();
  };
  stream.onerror = () => {
    notify("Connexion au bot perdue. Vérifie que « npm start » tourne ; la page se reconnecte toute seule.");
    markConnectionLost();
  };

  // Resynchronise les bougies avec la plateforme une fois par minute
  setInterval(() => loadCandles().catch(() => {}), 60_000);
}

// Nouvelle simulation : choix des actifs, puis remise à zéro du portefeuille
$("reset").addEventListener("click", () => {
  $("setupIntro").textContent = `Le portefeuille repart à ${nf(state.startCash, 0)} ${quote()}, répartis à parts égales entre les actifs cochés. L'historique des ordres est effacé.`;
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

init().catch((err) => {
  notify(`Impossible de joindre le bot : ${err.message}`);
  markConnectionLost();
});
