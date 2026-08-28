const REFRESH_MS = 20000;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ---------------------------------------------------------------- helpers

function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "--";
  return Number(n).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtInt(n) {
  if (n === null || n === undefined) return "--";
  return Number(n).toLocaleString("en-IN");
}

function chgClass(v) {
  if (v > 0) return "up";
  if (v < 0) return "down";
  return "flat";
}

// Trend (20D) is computed server-side (backend/nse_client.py's
// _trend_20d) from the last 20 daily candles - "Uptrend"/"Downtrend"/
// "Neutral". Just maps that label to the same up/down/flat color classes
// used everywhere else.
function trendClass(trend) {
  if (trend === "Uptrend") return "up";
  if (trend === "Downtrend") return "down";
  return "flat";
}

// Numeric rank so the Trend (20D) column can sort like every other
// numeric column - null (not enough daily history yet) sorts like any
// other missing value (always to the bottom, regardless of direction).
function trendRank(trend) {
  if (trend === "Uptrend") return 1;
  if (trend === "Downtrend") return -1;
  if (trend === "Neutral") return 0;
  return null;
}

function sign(v) {
  return v > 0 ? "+" : "";
}

function tvLink(symbol) {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`NSE:${symbol}`)}`;
}

// iOS Universal Links / Android App Links (what hands a tap on a
// tradingview.com link off to the installed TradingView app instead of
// opening it in the mobile browser) only intercept a top-level, same-tab
// navigation - a target="_blank" new-tab open bypasses that check
// entirely and always opens the web page, even with the app installed. So
// on mobile, drop target/rel and let the tap navigate normally (giving
// the OS its shot at the handoff); desktop keeps opening a new tab, since
// there's no "app" to hand off to there and a same-tab navigation would
// just lose the dashboard.
function isMobileDevice() {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function symbolLink(symbol) {
  const linkAttrs = isMobileDevice() ? "" : ` target="_blank" rel="noopener noreferrer"`;
  return `<span class="sym-cell"><a class="sym-link" href="${tvLink(symbol)}"${linkAttrs} title="Open ${symbol} chart on TradingView">${symbol}</a><button type="button" class="verdict-trigger" data-symbol="${symbol}" title="Smart summary for ${symbol} - trend, breakout, pivot read">✦</button></span>`;
}

// Self-computed bullish/bearish/neutral read per sector, fetched from
// /api/sector-bias and refreshed alongside everything else - see
// NSEClient.get_sector_bias in the backend for how it's computed.
let sectorBias = {};

function sectorLabel(sector) {
  if (!sector) return `<span class="flat">&mdash;</span>`;
  const bias = sectorBias[sector];
  if (!bias || !bias.count) return sector;
  const icon = bias.label === "Bullish" ? "🟢" : bias.label === "Bearish" ? "🔴" : "⚪";
  const detail = `${sector} sector avg ${sign(bias.avgPChange)}${fmtNum(bias.avgPChange)}% (${bias.up} up / ${bias.down} down) — ${bias.label}`;
  return `${sector} <span class="sector-bias" title="${detail}">${icon}</span>`;
}

// "HH:MM:SS" (IST) a stock first started qualifying today -> "HH:MM (Xm
// ago)". Returns a dash when the scanner isn't currently flagging the
// stock (or the background tracker hasn't caught up yet).
function fmtSince(since) {
  if (!since) return `<span class="flat">&mdash;</span>`;
  const [h, m] = since.split(":");
  const now = nowIST();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const sinceMins = Number(h) * 60 + Number(m);
  const elapsed = Math.max(0, nowMins - sinceMins);
  const elapsedLabel = elapsed < 1 ? "just now" : elapsed < 60 ? `${elapsed}m ago` : `${Math.floor(elapsed / 60)}h ${elapsed % 60}m ago`;
  return `${h}:${m} <span class="flat">(${elapsedLabel})</span>`;
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

function showError(msg) {
  const banner = $("#error-banner");
  banner.textContent = `⚠ ${msg} — retrying in the background.`;
  banner.classList.remove("hidden");
}

function clearError() {
  $("#error-banner").classList.add("hidden");
}

function isMarketHoursIST() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  const ist = new Date(istMs);
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
}

function nowIST() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  return new Date(istMs);
}

// ---------------------------------------------------------------- theme

function setThemeButton(theme) {
  $("#theme-icon").textContent = theme === "dark" ? "☀️" : "🌙";
  $("#theme-toggle").title = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

function initTheme() {
  const saved = localStorage.getItem("pro-theme");
  const theme = saved === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);
  setThemeButton(theme);
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("pro-theme", next);
    setThemeButton(next);
  });
}

// ---------------------------------------------------------------- nav / routing

const VIEW_TITLES = {
  dashboard: "Dashboard",
  scanner: "F&O Scanner",
  fogainerslosers: "F&O Gainers & Losers",
  scanners: "Scanners",
  breadth: "Market Breadth",
  heatmap: "Sector Heatmap",
  movers: "Top Movers",
  fiftytwo: "52-Week High / Low",
  volume: "Volume Shockers",
  watchlist: "Watchlist",
  settings: "Settings",
};

function switchView(view) {
  $$(".nav-item[data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view[data-view]").forEach((s) => s.classList.toggle("active", s.dataset.view === view));
  $("#page-title").textContent = VIEW_TITLES[view] || view;
  $(".sidebar").classList.remove("open");
}

function initNav() {
  $("#sidebar-nav").addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-item[data-view]");
    if (!btn) return;
    switchView(btn.dataset.view);
  });
  $("#sidebar-burger").addEventListener("click", () => {
    $(".sidebar").classList.toggle("open");
  });
}

// ---------------------------------------------------------------- index strip / clock

let latestIndices = [];
let latestAdSummary = null;
let latestBias = null;

function biasClassFor(label) {
  const lower = label.toLowerCase();
  return lower.startsWith("bull") ? "bullish" : lower.startsWith("bear") ? "bearish" : "neutral";
}

function renderIndexStrip() {
  const el = $("#index-strip");
  const cards = latestIndices
    .map(
      (idx) => `
    <div class="idx-card">
      <div class="idx-name">${idx.symbol}</div>
      <div class="idx-val">${fmtNum(idx.last, 2)}</div>
      <div class="idx-chg ${chgClass(idx.pChange)}">${sign(idx.change)}${fmtNum(idx.change, 2)} (${sign(idx.pChange)}${fmtNum(idx.pChange, 2)}%)</div>
    </div>`
    )
    .join("");

  const adCard = latestAdSummary
    ? `
    <div class="idx-card">
      <div class="idx-name">Adv / Dec</div>
      <div class="idx-val"><span class="up">${fmtInt(latestAdSummary.advances)}</span> / <span class="down">${fmtInt(latestAdSummary.declines)}</span></div>
      <div class="idx-chg flat">${latestAdSummary.unchanged} unchanged</div>
    </div>`
    : `<div class="idx-card"><div class="idx-name">Adv / Dec</div><div class="idx-val">&mdash;</div></div>`;

  const biasCard = latestBias
    ? `
    <div class="idx-card">
      <div class="idx-name">Market Bias</div>
      <div class="idx-val"><span class="bias-value ${biasClassFor(latestBias.label)}">${latestBias.label}</span></div>
    </div>`
    : `<div class="idx-card"><div class="idx-name">Market Bias</div><div class="idx-val">&mdash;</div></div>`;

  el.innerHTML =
    cards +
    adCard +
    biasCard +
    `<div class="idx-card">
      <div class="idx-name">Time</div>
      <div class="idx-time" id="idx-time-value">&mdash;</div>
      <div class="idx-date" id="idx-date-value">&mdash;</div>
    </div>`;
  tickClock();
}

function tickClock() {
  const el = $("#idx-time-value");
  if (!el) return;
  const ist = nowIST();
  el.textContent = ist.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const dateEl = $("#idx-date-value");
  if (dateEl) dateEl.textContent = ist.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

// ---------------------------------------------------------------- market bias

function renderMarketBias(bias) {
  const biasEl = $("#bias-value");
  biasEl.textContent = bias.label;
  biasEl.className = `bias-value ${bias.label.toLowerCase().startsWith("bull") ? "bullish" : bias.label.toLowerCase().startsWith("bear") ? "bearish" : "neutral"}`;
  $("#bias-factors").innerHTML = bias.factors
    .map(
      (f) => `
    <div class="bias-factor">
      <span class="dot ${f.signal}"></span>
      <span class="f-name">${f.name}</span>
      <span class="f-detail">${f.detail}</span>
    </div>`
    )
    .join("");
}

// ---------------------------------------------------------------- advance/decline

const adExpanded = {};

function renderAdvanceDecline(elId, data, navigateTo) {
  const { advances, declines, unchanged, total, stocks } = data;
  const advPct = total ? (advances / total) * 100 : 0;
  const decPct = total ? (declines / total) * 100 : 0;
  const uncPct = total ? (unchanged / total) * 100 : 0;
  const expanded = !navigateTo && !!adExpanded[elId];

  const body = $(`#${elId}`);
  body.innerHTML = `
    <div class="ad-bar"><div class="adv" style="width:${advPct}%"></div><div class="dec" style="width:${decPct}%"></div><div class="unc" style="width:${uncPct}%"></div></div>
    <div class="ad-counts">
      <span class="adv-c">Advancing <b>${advances}</b></span>
      <span class="dec-c">Declining <b>${declines}</b></span>
      <span>Unchanged <b>${unchanged}</b></span>
    </div>
    <button class="ad-toggle" id="${elId}-toggle">${navigateTo ? "Show all 50 stocks" : (expanded ? "Hide" : "Show") + " all 50 stocks"}</button>
    <div id="${elId}-detail"></div>
  `;
  $(`#${elId}-toggle`).addEventListener("click", () => {
    if (navigateTo) {
      switchView(navigateTo);
      return;
    }
    adExpanded[elId] = !adExpanded[elId];
    renderAdvanceDecline(elId, data);
  });
  if (elId === "breadth-body") {
    const noFilter = breadthSelectedSectors.size === 0;
    const hintCount = noFilter ? total : stocks.filter((s) => breadthSelectedSectors.has(s.sector)).length;
    $("#breadth-sector-hint").textContent = noFilter ? "" : `${hintCount} of ${total} Nifty 50 stocks`;
  }
  if (expanded) {
    const detailId = `${elId}-detail`;
    const filteredStocks =
      elId === "breadth-body" && breadthSelectedSectors.size > 0
        ? stocks.filter((s) => breadthSelectedSectors.has(s.sector))
        : stocks;
    const sortState = tableSortState[detailId];
    const sortCols = [
      { key: "open", header: "Open" },
      { key: "lastPrice", header: "LTP" },
      { key: "pctFromOpen", header: "Chg from Open" },
      { key: "dayHigh", header: "Day High" },
      { key: "dayLow", header: "Day Low" },
      { key: "yearHigh", header: "52W High" },
      { key: "pctFromYearHigh", header: "52W High %" },
      { key: "yearLow", header: "52W Low" },
      { key: "pctFromYearLow", header: "52W Low %" },
      { key: "trend20d", header: "Trend (20D)" },
    ];
    const sortedStocks = sortState
      ? [...filteredStocks].sort((a, b) => {
          let av = a[sortState.key], bv = b[sortState.key];
          if (sortState.key === "trend20d") {
            av = trendRank(av);
            bv = trendRank(bv);
          }
          if (av == null && bv == null) return 0;
          if (av == null) return 1;
          if (bv == null) return -1;
          return (av - bv) * sortState.dir;
        })
      : filteredStocks;
    const rows = sortedStocks
      .map(
        (s) => `
      <tr>
        <td>${symbolLink(s.symbol)}</td>
        <td class="cell-left">${sectorLabel(s.sector)}</td>
        <td>${fmtNum(s.open)}</td>
        <td>${fmtNum(s.lastPrice)}</td>
        <td class="${chgClass(s.changeFromOpen)}">${sign(s.pctFromOpen)}${fmtNum(s.pctFromOpen)}%</td>
        <td>${fmtNum(s.dayHigh)}</td>
        <td>${fmtNum(s.dayLow)}</td>
        <td>${fmtNum(s.yearHigh)}</td>
        <td class="${chgClass(s.pctFromYearHigh)}">${sign(s.pctFromYearHigh)}${fmtNum(s.pctFromYearHigh)}%</td>
        <td>${fmtNum(s.yearLow)}</td>
        <td class="${chgClass(s.pctFromYearLow)}">${sign(s.pctFromYearLow)}${fmtNum(s.pctFromYearLow)}%</td>
        <td class="${trendClass(s.trend20d)}">${s.trend20d || "--"}</td>
      </tr>`
      )
      .join("");
    const sortHeadCells = sortCols
      .map((c) => {
        const active = sortState && sortState.key === c.key;
        const arrow = active ? (sortState.dir === 1 ? " ▲" : " ▼") : "";
        return `<th class="sortable" data-sort-key="${c.key}">${c.header}${arrow}</th>`;
      })
      .join("");
    const detailEl = $(`#${detailId}`);
    detailEl.innerHTML = filteredStocks.length
      ? `<table><thead><tr><th>Symbol</th><th class="cell-left">Sector</th>${sortHeadCells}</tr></thead>
      <tbody>${rows}</tbody></table>`
      : `<div class="empty-note">No Nifty 50 stocks in the selected sector${breadthSelectedSectors.size > 1 ? "s" : ""}.</div>`;
    detailEl.querySelectorAll("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sortKey;
        const cur = tableSortState[detailId];
        tableSortState[detailId] = { key, dir: cur && cur.key === key ? -cur.dir : -1 };
        renderAdvanceDecline(elId, data, navigateTo);
      });
    });
  }
}

// ---------------------------------------------------------------- heatmap + drawer

let latestSectors = [];

function renderHeatmap(sectors) {
  latestSectors = sectors;
  const grid = $("#heatmap-grid");
  const totalStocks = sectors.reduce((sum, s) => sum + (s.stockCount || 0), 0);
  $("#sector-count").textContent = `${sectors.length} sectors · ${totalStocks} stocks`;
  const sorted = [...sectors].sort((a, b) => (b.pChange ?? -Infinity) - (a.pChange ?? -Infinity));
  grid.innerHTML = sorted
    .map(
      (s) => `
    <div class="hm-tile ${chgClass(s.pChange)}" data-symbol="${s.symbol}">
      <div class="sym">${s.symbol} <span class="count">(${s.stockCount ?? "?"})</span></div>
      <div class="val">${fmtNum(s.last, 2)}</div>
      <div class="chg">${sign(s.pChange)}${fmtNum(s.pChange, 2)}%</div>
    </div>`
    )
    .join("");
  grid.querySelectorAll(".hm-tile").forEach((tile) => {
    tile.addEventListener("click", () => openDrawer(tile.dataset.symbol));
  });
  renderMiniSectors(sorted);
}

function sectorTileHtml(tiles) {
  return tiles
    .map(
      (s) => `
    <div class="mini-sector-tile ${chgClass(s.pChange)}" data-symbol="${s.symbol}">
      ${s.symbol.replace("NIFTY ", "")}
      <span class="pct">${sign(s.pChange)}${fmtNum(s.pChange, 2)}%</span>
    </div>`
    )
    .join("");
}

function renderMiniSectors(sorted) {
  // Rendered in several places, deliberately at different sizes:
  // - Dashboard (#dash-mini-sectors), Market Breadth (#breadth-mini-sectors),
  //   and F&O Scanner (#mini-sectors): the FULL list, all 23 sectors - same
  //   count as the dedicated Sector Heatmap page, just a different
  //   (compact-tile) style. F&O Scanner's is now its own full-width card
  //   above the F&O Stocks (Live) table - NOT side-by-side with the
  //   summary-cards row, which is what caused a height mismatch the two
  //   previous times this was tried there.
  // - F&O Gainers & Losers (#fogl-mini-sectors): a genuinely "mini" widget -
  //   top 5 + bottom 5 only, not just "however the first 10 happened to
  //   sort" (which, on a broadly red day, used to hide the actual worst
  //   decliners entirely).
  // Every tile opens that sector's constituent-stock drawer, same as the
  // full Sector Heatmap page - these are NSE's raw sectoral-index names
  // (HEATMAP_SECTOR_SYMBOLS, e.g. "NIFTY IT"), a deliberately separate
  // taxonomy from the clean per-stock "sector" field (FO_SECTOR_MAP, e.g.
  // "IT") that the Gainers/Losers and Market Breadth sector filters use -
  // the two don't map 1:1, so a tile click can't also drive those filters.
  const targets = [
    { el: $("#dash-mini-sectors"), full: true },
    { el: $("#breadth-mini-sectors"), full: true },
    { el: $("#mini-sectors"), full: true },
    { el: $("#fogl-mini-sectors"), full: false },
  ];
  for (const { el, full } of targets) {
    if (!el) continue;
    const tiles = full || sorted.length <= 10 ? sorted : [...sorted.slice(0, 5), ...sorted.slice(-5)];
    el.innerHTML = sectorTileHtml(tiles);
    el.querySelectorAll(".mini-sector-tile").forEach((tile) => {
      tile.addEventListener("click", () => openDrawer(tile.dataset.symbol));
    });
  }
}

async function openDrawer(symbol) {
  const drawer = $("#drawer");
  drawer.classList.remove("hidden");
  $("#drawer-title").textContent = symbol;
  $("#drawer-body").innerHTML = `<div class="skel-line">Loading…</div>`;
  try {
    const data = await fetchJSON(`/api/sector?symbol=${encodeURIComponent(symbol)}`);
    renderDrawerStocks(data.stocks);
  } catch (err) {
    $("#drawer-body").innerHTML = `<div class="empty-note">Couldn't load: ${err.message}</div>`;
  }
}

function renderDrawerStocks(stocks) {
  if (!stocks.length) {
    $("#drawer-body").innerHTML = `<div class="empty-note">No constituent data available.</div>`;
    return;
  }
  const rows = stocks
    .map(
      (s) => `
    <tr>
      <td>${symbolLink(s.symbol)}</td>
      <td>${fmtNum(s.lastPrice)}</td>
      <td class="${chgClass(s.pChange)}">${sign(s.pChange)}${fmtNum(s.pChange)}%</td>
      <td>${fmtNum(s.open)}</td>
      <td>${fmtInt(s.totalTradedVolume)}</td>
    </tr>`
    )
    .join("");
  $("#drawer-body").innerHTML = `
    <table><thead><tr><th>Symbol</th><th>LTP</th><th>Chg %</th><th>Open</th><th>Volume</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

function closeDrawer() {
  $("#drawer").classList.add("hidden");
}

// ---------------------------------------------------------------- stock verdict ("smart summary")
// Click-to-open panel, wired via event delegation to every ".verdict-trigger"
// button symbolLink() renders - survives the tables re-rendering every 20s
// without needing to re-attach a listener per row. No external AI call -
// GET /api/stock-verdict just combines signals this app already computes
// (see NSEClient.get_stock_verdict) into one plain-language read.

async function openVerdict(symbol) {
  const drawer = $("#verdict-drawer");
  drawer.classList.remove("hidden");
  $("#verdict-title").textContent = symbol;
  $("#verdict-body").innerHTML = `<div class="skel-line">Loading…</div>`;
  try {
    const data = await fetchJSON(`/api/stock-verdict?symbol=${encodeURIComponent(symbol)}`);
    renderVerdict(data);
  } catch (err) {
    $("#verdict-body").innerHTML = `<div class="empty-note">Couldn't load: ${err.message}</div>`;
  }
}

function renderVerdict(v) {
  const verdictClass = v.verdict === "Bullish" ? "up" : v.verdict === "Bearish" ? "down" : "flat";
  const reasons = v.reasons.length
    ? `<ul class="verdict-reasons">${v.reasons.map((r) => `<li>${r}</li>`).join("")}</ul>`
    : `<p class="empty-note">No signals firing either way right now.</p>`;
  const pivotRows = v.pivot
    ? `
    <table class="verdict-pivot">
      <tbody>
        <tr><td>R3</td><td>${fmtNum(v.pivot.r3)}</td></tr>
        <tr><td>R2</td><td>${fmtNum(v.pivot.r2)}</td></tr>
        <tr><td>R1</td><td>${fmtNum(v.pivot.r1)}</td></tr>
        <tr class="verdict-pivot-pp"><td>Pivot</td><td>${fmtNum(v.pivot.pp)}</td></tr>
        <tr><td>S1</td><td>${fmtNum(v.pivot.s1)}</td></tr>
        <tr><td>S2</td><td>${fmtNum(v.pivot.s2)}</td></tr>
        <tr><td>S3</td><td>${fmtNum(v.pivot.s3)}</td></tr>
      </tbody>
    </table>`
    : `<p class="empty-note">Not enough daily history yet for pivot levels.</p>`;
  $("#verdict-body").innerHTML = `
    <div class="verdict-head">
      <span class="verdict-badge ${verdictClass}">${v.verdict}</span>
      <span class="verdict-ltp">${fmtNum(v.ltp)} <span class="${chgClass(v.pChange)}">${sign(v.pChange)}${fmtNum(v.pChange)}%</span></span>
    </div>
    ${reasons}
    <h3 class="verdict-subhead">Pivot levels (prior session H/L/C)${v.pivotPosition ? ` &mdash; trading ${v.pivotPosition}` : ""}</h3>
    ${pivotRows}
  `;
}

function closeVerdictDrawer() {
  $("#verdict-drawer").classList.add("hidden");
}

function initVerdictTriggers() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".verdict-trigger");
    if (!btn) return;
    e.preventDefault();
    openVerdict(btn.dataset.symbol);
  });
}

// ---------------------------------------------------------------- generic movers table

const DEFAULT_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "LTP", render: (r) => fmtNum(r.lastPrice ?? r.ltp), sortKey: "lastPrice" },
  {
    header: "Chg %",
    render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>`,
    sortKey: "pChange",
  },
];

const tableSortState = {};
const tablePageState = {}; // el.id -> current page index (0-based)
const TABLE_PAGE_SIZE = 10;

function renderMoversTable(el, rows, opts = {}) {
  if (!rows.length) {
    el.innerHTML = `<div class="empty-note">${opts.emptyText || "No data right now."}</div>`;
    return;
  }
  const columns = opts.columns || DEFAULT_COLUMNS;
  const pageSize = opts.pageSize || TABLE_PAGE_SIZE;
  const state = tableSortState[el.id];
  const sortedRows = state
    ? [...rows].sort((a, b) => {
        const av = a[state.key], bv = b[state.key];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        return (av - bv) * state.dir;
      })
    : rows;

  // Paginated so a long list (e.g. the Downtrend Scanner's ~200+ F&O
  // universe) doesn't dump everything onto one page. Page index is kept
  // per element id, clamped to whatever range today's row count allows -
  // so switching tabs (same table element, different data) never crashes,
  // it just snaps back into range.
  const pageCount = Math.max(1, Math.ceil(sortedRows.length / pageSize));
  let page = tablePageState[el.id] || 0;
  if (page >= pageCount) page = pageCount - 1;
  if (page < 0) page = 0;
  tablePageState[el.id] = page;
  const pageRows = sortedRows.slice(page * pageSize, page * pageSize + pageSize);

  const head = columns
    .map((c) => {
      if (!c.sortKey) return `<th class="${c.cls || ""}">${c.header}</th>`;
      const active = state && state.key === c.sortKey;
      const arrow = active ? (state.dir === 1 ? " ▲" : " ▼") : "";
      return `<th class="${c.cls || ""} sortable" data-sort-key="${c.sortKey}">${c.header}${arrow}</th>`;
    })
    .join("");
  const body = pageRows
    .map((r) => `<tr>${columns.map((c) => `<td class="${c.cls || ""}">${c.render(r)}</td>`).join("")}</tr>`)
    .join("");
  const pager =
    pageCount > 1
      ? `<div class="table-pager">
          <button type="button" class="table-pager-prev" ${page === 0 ? "disabled" : ""}>&larr; Prev</button>
          <span class="table-pager-info">Page ${page + 1} of ${pageCount} &middot; ${sortedRows.length} stocks</span>
          <button type="button" class="table-pager-next" ${page >= pageCount - 1 ? "disabled" : ""}>Next &rarr;</button>
        </div>`
      : "";
  el.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${pager}`;

  el.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      const cur = tableSortState[el.id];
      tableSortState[el.id] = { key, dir: cur && cur.key === key ? -cur.dir : -1 };
      tablePageState[el.id] = 0; // new sort order - back to page 1
      renderMoversTable(el, rows, opts);
    });
  });
  const prevBtn = el.querySelector(".table-pager-prev");
  const nextBtn = el.querySelector(".table-pager-next");
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      tablePageState[el.id] = Math.max(0, page - 1);
      renderMoversTable(el, rows, opts);
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      tablePageState[el.id] = Math.min(pageCount - 1, page + 1);
      renderMoversTable(el, rows, opts);
    });
  }
}

// ---------------------------------------------------------------- Scanners (self-tracked)
// Opening Range Breakout / Buy-Sell (Bullish-Bearish) / 15-Min Breakout -
// ported from the classic dashboard's identical scanners (same backend
// routes, same rules). See frontend/app.js for the original.

// -- ORB Scanner --------------------------------------------------------------

let selectedOrbWindow = 5;
let orbStatusByWindow = {};

const ORB_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "ORB Time", render: (r) => r.orbTime },
  { header: "ORB High", render: (r) => fmtNum(r.orbHigh) },
  { header: "ORB Low", render: (r) => fmtNum(r.orbLow) },
  { header: "LTP", render: (r) => fmtNum(r.ltp) },
  { header: "Chg %", render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>` },
  {
    header: "Breakout",
    render: (r) =>
      r.breakout === "up"
        ? `<span class="breakout-up">▲ Above ${fmtNum(r.breakoutPrice)}</span>`
        : r.breakout === "down"
        ? `<span class="breakout-down">▼ Below ${fmtNum(r.breakoutPrice)}</span>`
        : `<span class="breakout-none">Inside range</span>`,
  },
  { header: "Since", render: (r) => fmtSince(r.since) },
];

function renderOrbStatusNote() {
  const note = $("#orb-status-note");
  const status = orbStatusByWindow[selectedOrbWindow];
  if (!status) {
    note.textContent = "";
    return;
  }
  note.textContent = status.formed
    ? `Range formed ${status.label} IST — tracking breakouts live.`
    : `Range not formed yet — forms at ${status.label.split("–")[1]} IST. ` +
      `This only works while the app has been running since 09:15 IST; nothing shows outside a live session.`;
}

async function refreshOrb() {
  try {
    const { windows } = await fetchJSON("/api/orb/status");
    orbStatusByWindow = Object.fromEntries(windows.map((w) => [w.window, w]));
    renderOrbStatusNote();

    const data = await fetchJSON(`/api/orb?window=${selectedOrbWindow}`);
    const el = $("#orb-table");

    if (!data.formed) {
      el.innerHTML = `<div class="empty-note">No range captured for this window yet today.</div>`;
      return;
    }

    const breakouts = data.stocks.filter((s) => s.breakout !== "none");
    renderMoversTable(el, breakouts, {
      emptyText: `No stocks have broken their ${selectedOrbWindow}-min opening range yet (${data.stocks.length} tracked, all still inside range).`,
      columns: ORB_COLUMNS,
    });
  } catch (err) {
    $("#orb-table").innerHTML = `<div class="empty-note">Couldn't load ORB data: ${err.message}</div>`;
  }
}

// -- Buy/Sell Scanner -----------------------------------------------------------

let selectedScanDirection = "buy";
let selectedScanTimeframe = 60;
let scannerAutoSync = true; // stays true until the user manually picks buy/sell

// Daily-leg columns - always shown, meaningfully different per row (real
// NSE EOD history, ready almost immediately).
const BUYSELL_DAILY_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "LTP", render: (r) => fmtNum(r.ltp) },
  { header: "Chg %", render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>` },
  { header: "Daily RSI(14)", render: (r) => fmtNum(r.dailyRsi14) },
  { header: "Daily vs SMA20", render: (r) => `${fmtNum(r.dailyClose)} / ${fmtNum(r.dailySma20)}` },
];
// Intraday-leg columns - only worth showing once the selected timeframe's
// self-tracked candle history is ready; before that, every row reads
// "pending" / "Daily only — intraday pending" / "—" identically, which is
// clutter, not information (the status note above the table already says
// the timeframe is still building).
const BUYSELL_INTRADAY_COLUMNS = [
  { header: "Intraday RSI(14)", render: (r) => fmtNum(r.intradayRsi14) },
  { header: "Intraday vs SMA20", render: (r) => `${fmtNum(r.intradayClose)} / ${fmtNum(r.intradaySma20)}` },
  {
    header: "Status",
    render: (r) =>
      r.qualifies
        ? `<span class="up">✓ Qualified (daily + intraday)</span>`
        : `<span class="flat">Daily only</span>`,
  },
  { header: "Since", render: (r) => fmtSince(r.since) },
  {
    header: "Signal %",
    render: (r) => `<span class="${chgClass(r.signalPct)}">${sign(r.signalPct)}${fmtNum(r.signalPct)}%</span>`,
  },
  { header: "R-Factor", render: (r) => (r.rFactor == null ? "--" : `${sign(r.rFactor)}${fmtNum(r.rFactor)}R`) },
];

function buysellColumns(intradayReady) {
  return intradayReady ? [...BUYSELL_DAILY_COLUMNS, ...BUYSELL_INTRADAY_COLUMNS] : BUYSELL_DAILY_COLUMNS;
}

function renderBuySellStatusNote(status) {
  const note = $("#buysell-status-note");
  if (!status) {
    note.textContent = "";
    return;
  }
  const daily = status.dailyReady
    ? `Daily: ready (${status.dailyBarsAvailable} real trading days).`
    : `Daily: building (${status.dailyBarsAvailable}/${status.dailyBarsNeeded} trading days).`;
  const tf = status.timeframes[String(selectedScanTimeframe)];
  let intraday;
  if (!tf.todayBarCompleted) {
    intraday = `${selectedScanTimeframe}-min: waiting for today's first ${selectedScanTimeframe}-min candle to close — intraday signal not current yet.`;
  } else if (tf.ready) {
    intraday = `${selectedScanTimeframe}-min: ready (${tf.barsAvailable} bars, self-tracked).`;
  } else {
    intraday = `${selectedScanTimeframe}-min: building (${tf.barsAvailable}/${tf.barsNeeded} bars).`;
  }
  note.textContent = `${daily} ${intraday}`;
}

function syncScannerToBias(label) {
  if (!scannerAutoSync) return;
  const lower = label.toLowerCase();
  const wanted = lower.startsWith("bull") ? "buy" : lower.startsWith("bear") ? "sell" : null;
  if (!wanted || wanted === selectedScanDirection) return;
  selectedScanDirection = wanted;
  $$("#buysell-tabs .qf-chip").forEach((b) => b.classList.toggle("active", b.dataset.direction === wanted));
  refreshBuySellScanner();
}

async function refreshBuySellScanner() {
  try {
    const data = await fetchJSON(`/api/scanner?direction=${selectedScanDirection}&timeframe=${selectedScanTimeframe}`);
    renderBuySellStatusNote(data.status);
    const tf = data.status.timeframes[String(selectedScanTimeframe)];
    const columns = buysellColumns(Boolean(tf && tf.ready));
    const relevant = data.stocks.filter((s) => s.dailyPass);
    renderMoversTable($("#buysell-table"), relevant, {
      emptyText: `No stocks currently pass the daily ${selectedScanDirection} conditions.`,
      columns,
    });
  } catch (err) {
    $("#buysell-table").innerHTML = `<div class="empty-note">Couldn't load scanner data: ${err.message}</div>`;
  }
}

// -- 15-Min Breakout Scanner ------------------------------------------------------

let selectedBreakoutDirection = "buy";

const BREAKOUT_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "LTP", render: (r) => fmtNum(r.ltp), sortKey: "ltp" },
  {
    header: "Chg %",
    render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>`,
    sortKey: "pChange",
  },
  { header: "15m Close", render: (r) => fmtNum(r.close15m), sortKey: "close15m" },
  { header: "Prior 20-bar Close High", render: (r) => fmtNum(r.priorMaxClose20), sortKey: "priorMaxClose20" },
  { header: "15m Volume", render: (r) => fmtInt(r.volume15m), sortKey: "volume15m" },
  { header: "Vol SMA(20)", render: (r) => fmtInt(r.volSma20), sortKey: "volSma20" },
  {
    header: "Status",
    render: (r) => (r.qualifies ? `<span class="up">✓ Qualified</span>` : `<span class="flat">—</span>`),
  },
  { header: "Since", render: (r) => fmtSince(r.since) },
  {
    header: "Signal %",
    render: (r) => `<span class="${chgClass(r.signalPct)}">${sign(r.signalPct)}${fmtNum(r.signalPct)}%</span>`,
  },
  { header: "R-Factor", render: (r) => (r.rFactor == null ? "--" : `${sign(r.rFactor)}${fmtNum(r.rFactor)}R`) },
];

function renderBreakoutStatusNote(status) {
  const note = $("#breakout-status-note");
  if (!status) {
    note.textContent = "";
    return;
  }
  if (!status.todayBarCompleted) {
    note.textContent = "Waiting for today's first 15-min candle to close — no fresh breakouts to show yet.";
  } else {
    note.textContent = status.ready
      ? `Ready (${status.barsAvailable} 15-min bars, self-tracked, persisted across days).`
      : `Building (${status.barsAvailable}/${status.barsNeeded} 15-min bars) — fills within a single session once tracking starts.`;
  }
}

async function refreshBreakoutScanner() {
  try {
    const data = await fetchJSON(`/api/breakout-scanner?direction=${selectedBreakoutDirection}`);
    renderBreakoutStatusNote(data.status);
    renderMoversTable($("#breakout-table"), data.stocks, {
      emptyText: `No stocks currently pass the ${selectedBreakoutDirection} breakout conditions.`,
      columns: BREAKOUT_COLUMNS,
    });
  } catch (err) {
    $("#breakout-table").innerHTML = `<div class="empty-note">Couldn't load breakout scanner data: ${err.message}</div>`;
  }
}

// -- Downtrend Scanner ------------------------------------------------------

let selectedDowntrendMode = "daily";

const DOWNTREND_DAILY_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "LTP", render: (r) => fmtNum(r.ltp), sortKey: "ltp" },
  {
    header: "Chg %",
    render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>`,
    sortKey: "pChange",
  },
  { header: "Close", render: (r) => fmtNum(r.close), sortKey: "close" },
  {
    header: "EMA 20 / 50 / 200",
    render: (r) => `${fmtNum(r.emas["20"])} / ${fmtNum(r.emas["50"])} / ${fmtNum(r.emas["200"])}`,
  },
  { header: "RSI(14)", render: (r) => fmtNum(r.rsi), sortKey: "rsi" },
  { header: "ADX(14)", render: (r) => fmtNum(r.adx), sortKey: "adx" },
  {
    header: "Status",
    render: (r) => (r.qualifies ? `<span class="down">✓ Downtrend</span>` : `<span class="flat">—</span>`),
  },
];

const DOWNTREND_INTRADAY_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "LTP", render: (r) => fmtNum(r.ltp), sortKey: "ltp" },
  {
    header: "Chg %",
    render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>`,
    sortKey: "pChange",
  },
  { header: "15m Close / EMA200", render: (r) => `${fmtNum(r.close15m)} / ${fmtNum(r.ema200_15m)}` },
  {
    header: "5m Close / EMA 20-50-200",
    render: (r) => `${fmtNum(r.close5m)} / ${fmtNum(r.emas5m["20"])} / ${fmtNum(r.emas5m["50"])} / ${fmtNum(r.emas5m["200"])}`,
  },
  { header: "15m RSI(14)", render: (r) => fmtNum(r.rsi15m), sortKey: "rsi15m" },
  { header: "15m ADX(14)", render: (r) => fmtNum(r.adx15m), sortKey: "adx15m" },
  { header: "15m Vol / SMA(20)", render: (r) => `${fmtInt(r.volume15m)} / ${fmtInt(r.volSma20)}` },
  {
    header: "Status",
    render: (r) => (r.qualifies ? `<span class="down">✓ Downtrend</span>` : `<span class="flat">—</span>`),
  },
];

function renderDowntrendStatusNote(status) {
  const note = $("#downtrend-status-note");
  if (!status) {
    note.textContent = "";
    return;
  }
  if (selectedDowntrendMode === "daily") {
    const d = status.daily;
    note.textContent = d.ready
      ? `Daily: ready (${d.barsAvailable} real trading days, background-warmed).`
      : `Daily: building EMA(200) history in the background (${d.barsAvailable}/${d.barsNeeded} trading days) — this can take a while after a restart.`;
    return;
  }
  const m5 = status.intraday5m;
  const m15 = status.intraday15m;
  const leg = (label, tf) =>
    !tf.todayBarCompleted
      ? `${label}: waiting for today's first candle to close.`
      : tf.ready
        ? `${label}: ready (${tf.barsAvailable} bars).`
        : `${label}: building (${tf.barsAvailable}/${tf.barsNeeded} bars, self-tracked).`;
  note.textContent = `${leg("5-min", m5)} ${leg("15-min", m15)}`;
}

async function refreshDowntrendScanner() {
  try {
    const data = await fetchJSON(`/api/downtrend-scanner?mode=${selectedDowntrendMode}`);
    renderDowntrendStatusNote(data.status);
    renderMoversTable($("#downtrend-table"), data.stocks, {
      emptyText: `No stocks currently pass the ${selectedDowntrendMode} downtrend conditions.`,
      columns: selectedDowntrendMode === "daily" ? DOWNTREND_DAILY_COLUMNS : DOWNTREND_INTRADAY_COLUMNS,
    });
  } catch (err) {
    $("#downtrend-table").innerHTML = `<div class="empty-note">Couldn't load downtrend scanner data: ${err.message}</div>`;
  }
}

function initScannersTabControls() {
  $("#orb-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".qf-chip");
    if (!btn) return;
    selectedOrbWindow = Number(btn.dataset.window);
    $$("#orb-tabs .qf-chip").forEach((b) => b.classList.toggle("active", b === btn));
    renderOrbStatusNote();
    refreshOrb();
  });
  $("#buysell-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".qf-chip");
    if (!btn) return;
    scannerAutoSync = false; // user took control - stop auto-following Market Bias
    selectedScanDirection = btn.dataset.direction;
    $$("#buysell-tabs .qf-chip").forEach((b) => b.classList.toggle("active", b === btn));
    refreshBuySellScanner();
  });
  $("#buysell-timeframe-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".qf-chip");
    if (!btn) return;
    selectedScanTimeframe = Number(btn.dataset.timeframe);
    $$("#buysell-timeframe-tabs .qf-chip").forEach((b) => b.classList.toggle("active", b === btn));
    refreshBuySellScanner();
  });
  $("#breakout-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".qf-chip");
    if (!btn) return;
    selectedBreakoutDirection = btn.dataset.direction;
    $$("#breakout-tabs .qf-chip").forEach((b) => b.classList.toggle("active", b === btn));
    refreshBreakoutScanner();
  });
  $("#downtrend-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".qf-chip");
    if (!btn) return;
    selectedDowntrendMode = btn.dataset.mode;
    $$("#downtrend-tabs .qf-chip").forEach((b) => b.classList.toggle("active", b === btn));
    refreshDowntrendScanner();
  });
}

async function refreshScannersTab() {
  await Promise.allSettled([refreshOrb(), refreshBuySellScanner(), refreshBreakoutScanner(), refreshDowntrendScanner()]);
}

// ---------------------------------------------------------------- F&O Scanner

const SCANNER_COLUMNS = [
  { key: "symbol", header: "Stock", cls: "cell-left", render: (r) => symbolLink(r.symbol), essential: true },
  { key: "sector", header: "Sector", cls: "cell-left", render: (r) => sectorLabel(r.sector) },
  { key: "ltp", header: "LTP (₹)", render: (r) => fmtNum(r.ltp), sortable: true, essential: true },
  {
    key: "pChange",
    header: "Change (%)",
    render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>`,
    sortable: true,
    essential: true,
  },
  {
    key: "change",
    header: "Change (₹)",
    render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.change)}${fmtNum(r.change)}</span>`,
    sortable: true,
  },
  { key: "volume", header: "Volume", render: (r) => fmtInt(r.volume), sortable: true },
  { key: "valueCr", header: "Value (₹ Cr)", render: (r) => fmtNum(r.valueCr), sortable: true },
  { key: "prevClose", header: "Prev Close (₹)", render: (r) => fmtNum(r.prevClose), sortable: true },
  { key: "yearHigh", header: "52W High (₹)", render: (r) => fmtNum(r.yearHigh), sortable: true },
  { key: "yearLow", header: "52W Low (₹)", render: (r) => fmtNum(r.yearLow), sortable: true },
];

let scannerData = null;
let scannerQuickFilter = "all";
let scannerApplied = { mcap: "all", sector: "ALL", price: "all" };
let scannerSearch = "";
let scannerSort = null; // {key, dir}
let scannerPage = 1;
let scannerRowsPerPage = 10;
const scannerVisibleCols = new Set(SCANNER_COLUMNS.map((c) => c.key));

function pctFromHigh(r) {
  return r.yearHigh ? (r.ltp / r.yearHigh - 1) * 100 : null;
}
function pctFromLow(r) {
  return r.yearLow ? (r.ltp / r.yearLow - 1) * 100 : null;
}

function marketCapBand(mcapCr) {
  if (mcapCr == null) return null;
  if (mcapCr > 20000) return "large";
  if (mcapCr >= 5000) return "mid";
  return "small";
}

function getFilteredScannerRows() {
  if (!scannerData) return [];
  let rows = scannerData.stocks;

  if (scannerQuickFilter === "breakout") rows = rows.filter((r) => r.breakout);
  else if (scannerQuickFilter === "priceUp") rows = rows.filter((r) => r.pChange > 0);
  else if (scannerQuickFilter === "priceDown") rows = rows.filter((r) => r.pChange < 0);
  else if (scannerQuickFilter === "highVolume") rows = rows.filter((r) => r.highVolume);
  else if (scannerQuickFilter === "high52w") rows = rows.filter((r) => { const p = pctFromHigh(r); return p !== null && p >= -1; });
  else if (scannerQuickFilter === "low52w") rows = rows.filter((r) => { const p = pctFromLow(r); return p !== null && p <= 1; });

  if (scannerApplied.mcap !== "all") rows = rows.filter((r) => marketCapBand(r.marketCapCr) === scannerApplied.mcap);
  if (scannerApplied.sector !== "ALL") rows = rows.filter((r) => r.sector === scannerApplied.sector);
  if (scannerApplied.price !== "all") {
    rows = rows.filter((r) => {
      if (scannerApplied.price === "lt500") return r.ltp < 500;
      if (scannerApplied.price === "500-1000") return r.ltp >= 500 && r.ltp <= 1000;
      if (scannerApplied.price === "1000-2500") return r.ltp > 1000 && r.ltp <= 2500;
      if (scannerApplied.price === "gt2500") return r.ltp > 2500;
      return true;
    });
  }

  if (scannerSearch) {
    const q = scannerSearch.toLowerCase();
    rows = rows.filter((r) => r.symbol.toLowerCase().includes(q));
  }

  if (scannerSort) {
    const { key, dir } = scannerSort;
    rows = [...rows].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
  }

  return rows;
}

function renderScannerSummary() {
  const el = $("#scanner-summary");
  if (!scannerData) return;
  const s = scannerData.summary;
  const cardIcon = (svg) => `<span class="sc-icon">${svg}</span>`;
  el.innerHTML = `
    <div class="summary-card total">
      ${cardIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>')}
      <div><div class="sc-label">Total F&amp;O Stocks</div><div class="sc-value">${fmtInt(s.total)}</div><div class="sc-sub">Live from NSE</div></div>
    </div>
    <div class="summary-card up">
      ${cardIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>')}
      <div><div class="sc-label">Advancers</div><div class="sc-value">${fmtInt(s.advancers)}</div><div class="sc-sub">${fmtNum((s.advancers / s.total) * 100, 2)}%</div></div>
    </div>
    <div class="summary-card down">
      ${cardIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>')}
      <div><div class="sc-label">Decliners</div><div class="sc-value">${fmtInt(s.decliners)}</div><div class="sc-sub">${fmtNum((s.decliners / s.total) * 100, 2)}%</div></div>
    </div>
    <div class="summary-card flat">
      ${cardIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/></svg>')}
      <div><div class="sc-label">Unchanged</div><div class="sc-value">${fmtInt(s.unchanged)}</div><div class="sc-sub">${fmtNum((s.unchanged / s.total) * 100, 2)}%</div></div>
    </div>
    <div class="summary-card vol">
      ${cardIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/></svg>')}
      <div><div class="sc-label">Total Volume</div><div class="sc-value">${fmtNum(s.totalVolumeCr, 2)} Cr</div><div class="sc-sub">Today</div></div>
    </div>
    <div class="summary-card total">
      ${cardIcon('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/></svg>')}
      <div><div class="sc-label">Sectors Up / Down</div><div class="sc-value"><span class="up">${latestSectors.filter((sec) => (sec.pChange ?? 0) > 0).length}</span> / <span class="down">${latestSectors.filter((sec) => (sec.pChange ?? 0) < 0).length}</span></div><div class="sc-sub">of ${latestSectors.length || 23} sectors</div></div>
    </div>
  `;
}

function renderColumnsMenu() {
  const menu = $("#columns-menu");
  menu.innerHTML = SCANNER_COLUMNS.filter((c) => !c.essential)
    .map(
      (c) => `
    <label><input type="checkbox" data-col="${c.key}" ${scannerVisibleCols.has(c.key) ? "checked" : ""}/> ${c.header}</label>`
    )
    .join("");
  menu.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const key = e.target.dataset.col;
      if (e.target.checked) scannerVisibleCols.add(key);
      else scannerVisibleCols.delete(key);
      renderScannerTable();
    });
  });
}

function buildPageButtons(current, total) {
  if (total <= 1) return "";
  const pages = [];
  const add = (p) => pages.push(p);
  add(1);
  for (let p = current - 1; p <= current + 1; p++) if (p > 1 && p < total) add(p);
  if (total > 1) add(total);
  const unique = [...new Set(pages)].sort((a, b) => a - b);
  let html = `<button class="page-btn" id="page-prev" ${current === 1 ? "disabled" : ""}>&laquo;</button>`;
  let prev = 0;
  for (const p of unique) {
    if (p - prev > 1) html += `<span class="page-ellipsis">…</span>`;
    html += `<button class="page-btn ${p === current ? "active" : ""}" data-page="${p}">${p}</button>`;
    prev = p;
  }
  html += `<button class="page-btn" id="page-next" ${current === total ? "disabled" : ""}>&raquo;</button>`;
  return html;
}

function renderScannerTable() {
  const el = $("#scanner-table");
  const filtered = getFilteredScannerRows();
  const total = filtered.length;

  if (!total) {
    el.innerHTML = `<div class="empty-note">No F&amp;O stocks match the current filters.</div>`;
    $("#table-range-note").textContent = "Showing 0 of 0 entries";
    $("#table-pagination").innerHTML = "";
    return;
  }

  const perPage = scannerRowsPerPage || total;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (scannerPage > totalPages) scannerPage = totalPages;
  const start = (scannerPage - 1) * perPage;
  const pageRows = filtered.slice(start, start + perPage);

  const cols = SCANNER_COLUMNS.filter((c) => scannerVisibleCols.has(c.key));
  const head = cols
    .map((c) => {
      if (!c.sortable) return `<th class="${c.cls || ""}">${c.header}</th>`;
      const active = scannerSort && scannerSort.key === c.key;
      const arrow = active ? (scannerSort.dir === 1 ? " ▲" : " ▼") : "";
      return `<th class="${c.cls || ""} sortable" data-sort-key="${c.key}">${c.header}${arrow}</th>`;
    })
    .join("");
  const body = pageRows
    .map((r) => `<tr>${cols.map((c) => `<td class="${c.cls || ""}">${c.render(r)}</td>`).join("")}</tr>`)
    .join("");
  el.innerHTML = `<div class="scanner-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;

  el.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      scannerSort = { key, dir: scannerSort && scannerSort.key === key ? -scannerSort.dir : -1 };
      scannerPage = 1;
      renderScannerTable();
    });
  });

  $("#table-range-note").textContent = `Showing ${start + 1} to ${Math.min(start + perPage, total)} of ${total} entries`;
  $("#table-pagination").innerHTML = buildPageButtons(scannerPage, totalPages);
  const prevBtn = $("#page-prev"), nextBtn = $("#page-next");
  if (prevBtn) prevBtn.addEventListener("click", () => { scannerPage = Math.max(1, scannerPage - 1); renderScannerTable(); });
  if (nextBtn) nextBtn.addEventListener("click", () => { scannerPage = Math.min(totalPages, scannerPage + 1); renderScannerTable(); });
  $("#table-pagination").querySelectorAll("button[data-page]").forEach((b) => {
    b.addEventListener("click", () => { scannerPage = Number(b.dataset.page); renderScannerTable(); });
  });
}

// Same Symbol / Sector / LTP / (Chg % or Volume) table markup and cell
// classes as DEFAULT_COLUMNS elsewhere in the app - headers + alignment
// match every other table, just capped to 5 rows with no sort/paginate.
function renderMiniList(elId, rows, valueHeader, valueFn) {
  const el = $(`#${elId}`);
  if (!rows.length) {
    el.innerHTML = `<div class="empty-note">No data.</div>`;
    return;
  }
  const body = rows
    .map(
      (r) => `
    <tr>
      <td>${symbolLink(r.symbol)}</td>
      <td class="cell-left">${sectorLabel(r.sector)}</td>
      <td>${fmtNum(r.ltp)}</td>
      <td>${valueFn(r)}</td>
    </tr>`
    )
    .join("");
  el.innerHTML = `<table><thead><tr><th>Symbol</th><th class="cell-left">Sector</th><th>LTP</th><th>${valueHeader}</th></tr></thead><tbody>${body}</tbody></table>`;
}

function renderScannerBottomPanels() {
  if (!scannerData) return;
  const rows = scannerData.stocks;
  const topGainers = [...rows].filter((r) => r.pChange > 0).sort((a, b) => b.pChange - a.pChange).slice(0, 5);
  const topLosers = [...rows].filter((r) => r.pChange < 0).sort((a, b) => a.pChange - b.pChange).slice(0, 5);
  const highVol = [...rows].sort((a, b) => b.volume - a.volume).slice(0, 5);
  const chgCell = (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>`;
  const volCell = (r) => fmtInt(r.volume);

  // Top Gainers/Losers/High Volume lists live only on the Dashboard now -
  // the F&O Scanner tab used to duplicate them here, removed as redundant.
  renderMiniList("dash-top-gainers", topGainers, "Chg %", chgCell);
  renderMiniList("dash-top-losers", topLosers, "Chg %", chgCell);
  renderMiniList("dash-high-volume", highVol, "Volume", volCell);
  if (latestSectors.length) renderMiniSectors([...latestSectors].sort((a, b) => (b.pChange ?? 0) - (a.pChange ?? 0)));
}

function exportScannerCSV() {
  const rows = getFilteredScannerRows();
  const cols = SCANNER_COLUMNS.filter((c) => scannerVisibleCols.has(c.key));
  const header = cols.map((c) => c.header.replace(/<[^>]+>/g, "")).join(",");
  const lines = rows.map((r) =>
    cols
      .map((c) => {
        const v = r[c.key];
        return v === null || v === undefined ? "" : String(v).replace(/,/g, "");
      })
      .join(",")
  );
  const csv = [header, ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fo-scanner-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function loadSectorFilterOptions(selectEl) {
  try {
    const { labels } = await fetchJSON("/api/sector-labels");
    for (const label of labels) {
      const opt = document.createElement("option");
      opt.value = label;
      opt.textContent = label;
      selectEl.appendChild(opt);
    }
  } catch {
    // non-fatal - the dropdown just won't have extra options beyond "All"
  }
}

// -- F&O Gainers & Losers: multi-select sector filter, full F&O universe ----
//
// NSE's own "variations" endpoint (what /api/fo/gainers-losers used to
// source this from) is a fixed top-20-each official list, not the full
// ~210-stock F&O universe - most sectors had nothing in it at any given
// moment, making the sector filter often look "broken" (correctly showing
// 0 results for a sector NSE's list just didn't include). Fixed by
// deriving gainers/losers from the SAME full-universe data the F&O
// Scanner table already fetches (scannerData, /api/fo-scanner) instead -
// every advancer/decliner in the whole F&O list, not just NSE's top 20.
// This also matches what the Dashboard's own Top Gainers/Losers mini-lists
// already do (see renderScannerBottomPanels).
// Generic multi-select "sector" filter dropdown: a checkbox menu (Select
// all / Clear + one row per sector, from /api/sector-labels) wired to a
// Set the caller owns, calling back on any change. Used here and by the
// Market Breadth page below - one implementation, two instances.
function initSectorMultiSelect({ btnId, menuId, dropdownId, selectedSet, onChange }) {
  let labels = [];

  function updateButtonLabel() {
    const btn = $(`#${btnId}`);
    const n = selectedSet.size;
    btn.textContent = n === 0 ? "All Sectors" : n === 1 ? [...selectedSet][0] : `${n} sectors selected`;
  }

  function renderMenu() {
    const menu = $(`#${menuId}`);
    menu.innerHTML =
      `<div class="dropdown-menu-actions">
        <button type="button" class="link-btn" data-action="all">Select all</button>
        <button type="button" class="link-btn" data-action="clear">Clear</button>
      </div>` +
      labels
        .map(
          (label) =>
            `<label><input type="checkbox" data-sector="${label}" ${selectedSet.has(label) ? "checked" : ""}/> ${label}</label>`
        )
        .join("");
    menu.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        const label = e.target.dataset.sector;
        if (e.target.checked) selectedSet.add(label);
        else selectedSet.delete(label);
        updateButtonLabel();
        onChange();
      });
    });
    menu.querySelector('[data-action="all"]').addEventListener("click", () => {
      selectedSet.clear();
      labels.forEach((l) => selectedSet.add(l));
      renderMenu();
      updateButtonLabel();
      onChange();
    });
    menu.querySelector('[data-action="clear"]').addEventListener("click", () => {
      selectedSet.clear();
      renderMenu();
      updateButtonLabel();
      onChange();
    });
  }

  $(`#${btnId}`).addEventListener("click", () => {
    $(`#${menuId}`).classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(`#${dropdownId}`)) $(`#${menuId}`).classList.add("hidden");
  });

  return {
    async load() {
      try {
        const res = await fetchJSON("/api/sector-labels");
        labels = res.labels;
        renderMenu();
      } catch {
        // non-fatal - menu just stays empty; "All Sectors" (no filter) still works
      }
    },
  };
}

let foglSelectedSectors = new Set(); // empty = no filter (every sector)
const foglSectorControl = initSectorMultiSelect({
  btnId: "fogl-sector-btn",
  menuId: "fogl-sector-menu",
  dropdownId: "fogl-sector-dropdown",
  selectedSet: foglSelectedSectors,
  onChange: renderFoGainersLosers,
});

function renderFoGainersLosers() {
  if (!scannerData) return;
  const rows = scannerData.stocks;
  const allGainers = [...rows].filter((r) => r.pChange > 0).sort((a, b) => b.pChange - a.pChange);
  const allLosers = [...rows].filter((r) => r.pChange < 0).sort((a, b) => a.pChange - b.pChange);
  const noFilter = foglSelectedSectors.size === 0;
  const gainers = noFilter ? allGainers : allGainers.filter((r) => foglSelectedSectors.has(r.sector));
  const losers = noFilter ? allLosers : allLosers.filter((r) => foglSelectedSectors.has(r.sector));
  const suffix = noFilter ? "" : ` for the selected sector${foglSelectedSectors.size > 1 ? "s" : ""}`;
  renderMoversTable($("#fogl-gainers"), gainers, { emptyText: `No F&O gainers${suffix} right now.` });
  renderMoversTable($("#fogl-losers"), losers, { emptyText: `No F&O losers${suffix} right now.` });
  $("#fogl-sector-hint").textContent = noFilter ? "" : `${gainers.length} gainers · ${losers.length} losers`;
}

// -- Market Breadth: multi-select sector filter -------------------------
//
// Uses the same generic initSectorMultiSelect() as F&O Gainers & Losers
// above. Nifty 50 is only 50 stocks, so several sectors will legitimately
// have zero members here even though they're well-represented in the full
// F&O universe - that's correct, not a bug (same caveat as the Gainers/
// Losers fix). Only the expanded stock-detail table is filtered; the
// headline advances/declines/unchanged counts and bar stay whole-Nifty-50
// always, since those are the actual "market breadth" summary, not a
// filtered view.
let breadthSelectedSectors = new Set();
const breadthSectorControl = initSectorMultiSelect({
  btnId: "breadth-sector-btn",
  menuId: "breadth-sector-menu",
  dropdownId: "breadth-sector-dropdown",
  selectedSet: breadthSelectedSectors,
  onChange: () => {
    if (latestAdSummary) renderAdvanceDecline("breadth-body", latestAdSummary);
  },
});

async function refreshScanner() {
  try {
    scannerData = await fetchJSON("/api/fo-scanner");
    renderScannerSummary();
    renderScannerTable();
    renderScannerBottomPanels();
    renderFoGainersLosers();
  } catch (err) {
    $("#scanner-table").innerHTML = `<div class="empty-note">Couldn't load F&amp;O scanner data: ${err.message}</div>`;
  }
}

function initScannerControls() {
  $("#qf-chips").addEventListener("click", (e) => {
    const btn = e.target.closest(".qf-chip");
    if (!btn) return;
    $$("#qf-chips .qf-chip").forEach((b) => b.classList.toggle("active", b === btn));
    scannerQuickFilter = btn.dataset.filter;
    scannerPage = 1;
    renderScannerTable();
  });

  $("#f-apply").addEventListener("click", () => {
    scannerApplied = { mcap: $("#f-mcap").value, sector: $("#f-sector").value, price: $("#f-price").value };
    scannerPage = 1;
    renderScannerTable();
  });

  $("#f-reset").addEventListener("click", () => {
    $("#f-mcap").value = "all";
    $("#f-sector").value = "ALL";
    $("#f-price").value = "all";
    scannerApplied = { mcap: "all", sector: "ALL", price: "all" };
    scannerQuickFilter = "all";
    $$("#qf-chips .qf-chip").forEach((b) => b.classList.toggle("active", b.dataset.filter === "all"));
    $("#table-search").value = "";
    scannerSearch = "";
    scannerPage = 1;
    renderScannerTable();
  });

  $("#table-search").addEventListener("input", (e) => {
    scannerSearch = e.target.value.trim();
    scannerPage = 1;
    renderScannerTable();
  });

  $("#rows-per-page").addEventListener("change", (e) => {
    scannerRowsPerPage = Number(e.target.value);
    scannerPage = 1;
    renderScannerTable();
  });

  $("#columns-btn").addEventListener("click", () => {
    $("#columns-menu").classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#columns-dropdown")) $("#columns-menu").classList.add("hidden");
  });
  renderColumnsMenu();

  $("#export-csv-btn").addEventListener("click", exportScannerCSV);
}

// ---------------------------------------------------------------- fetch cycle

let refreshTimer = null;

async function refreshAll() {
  // Fetched (and applied to the `sectorBias` global) before the main batch
  // below so every sectorLabel() call this cycle - inside refreshScanner()/
  // refreshScannersTab(), which run concurrently in that batch - sees the
  // freshest data rather than racing it.
  try {
    const { sectors } = await fetchJSON("/api/sector-bias");
    sectorBias = sectors || {};
  } catch (err) {
    // leave sectorBias as whatever it was - sector labels just show their
    // plain name (no bias badge) until this succeeds.
  }

  const results = await Promise.allSettled([
    fetchJSON("/api/market-overview"),
    fetchJSON("/api/heatmap"),
    fetchJSON("/api/advance-decline"),
    fetchJSON("/api/most-active"),
    fetchJSON("/api/52-week"),
    fetchJSON("/api/volume-gainers"),
    fetchJSON("/api/day-level-stocks"),
    refreshScanner(),
    refreshScannersTab(),
  ]);

  const [
    overviewRes,
    heatmapRes,
    advDeclRes,
    activeRes,
    week52Res,
    volRes,
    dayLevelRes,
  ] = results;
  const failures = results.filter((r) => r.status === "rejected");

  if (overviewRes.status === "fulfilled") {
    latestIndices = overviewRes.value.indices;
    latestBias = overviewRes.value.bias;
    renderMarketBias(overviewRes.value.bias);
    syncScannerToBias(overviewRes.value.bias.label);
  }
  if (heatmapRes.status === "fulfilled") {
    renderHeatmap(heatmapRes.value.sectors);
    // refreshScanner() (above, inside the same Promise.allSettled batch)
    // already painted the summary cards using whatever latestSectors was
    // BEFORE this line updated it - repaint now so the Sectors Up/Down
    // card isn't a cycle stale.
    if (scannerData) renderScannerSummary();
  }
  if (advDeclRes.status === "fulfilled") {
    latestAdSummary = advDeclRes.value;
    renderAdvanceDecline("dash-ad-body", advDeclRes.value, "breadth");
    renderAdvanceDecline("breadth-body", advDeclRes.value);
  }
  renderIndexStrip();

  // F&O Gainers & Losers (fogl-gainers/fogl-losers) are rendered inside
  // refreshScanner() above, not here - see renderFoGainersLosers()'s
  // comment for why (full F&O universe via scannerData, not a separate
  // capped NSE feed).
  if (activeRes.status === "fulfilled") {
    renderMoversTable($("#movers-active-volume"), activeRes.value.byVolume, {
      emptyText: "No F&O names in NSE's Most Active (By Volume) list right now.",
      columns: [...DEFAULT_COLUMNS, { header: "Volume", render: (r) => fmtInt(r.totalTradedVolume), sortKey: "totalTradedVolume" }],
    });
    renderMoversTable($("#movers-active-value"), activeRes.value.byValue, {
      emptyText: "No F&O names in NSE's Most Active (By Value) list right now.",
      columns: [...DEFAULT_COLUMNS, { header: "Value (₹)", render: (r) => fmtInt(r.totalTradedValue), sortKey: "totalTradedValue" }],
    });
  }
  if (week52Res.status === "fulfilled") {
    renderMoversTable($("#week52-high"), week52Res.value.high, {
      emptyText: "No F&O stocks hit a fresh 52-week high today.",
      columns: [...DEFAULT_COLUMNS.map((c) => (c.sortKey === "lastPrice" ? { ...c, render: (r) => fmtNum(r.ltp) } : c))],
    });
    renderMoversTable($("#week52-low"), week52Res.value.low, {
      emptyText: "No F&O stocks hit a fresh 52-week low today.",
      columns: [...DEFAULT_COLUMNS.map((c) => (c.sortKey === "lastPrice" ? { ...c, render: (r) => fmtNum(r.ltp) } : c))],
    });
  }
  if (volRes.status === "fulfilled") {
    renderMoversTable($("#volume-shockers"), volRes.value.stocks, {
      emptyText: "None of today's NSE volume-spurt names are in the F&O list right now.",
      columns: [
        ...DEFAULT_COLUMNS,
        { header: "Volume", render: (r) => fmtInt(r.volume), sortKey: "volume" },
        { header: "1wk Avg Vol", render: (r) => fmtInt(r.week1AvgVolume), sortKey: "week1AvgVolume" },
      ],
    });
  }
  if (dayLevelRes.status === "fulfilled") {
    // Backend rows use "ltp" (not "lastPrice") - same convention as the
    // 52-week high/low remap just above.
    const ltpColumns = DEFAULT_COLUMNS.map((c) => (c.sortKey === "lastPrice" ? { ...c, render: (r) => fmtNum(r.ltp), sortKey: "ltp" } : c));
    renderMoversTable($("#movers-day-high"), dayLevelRes.value.high, {
      emptyText: "No F&O stock day-high data right now.",
      columns: [...ltpColumns, { header: "Day High", render: (r) => fmtNum(r.dayHigh), sortKey: "dayHigh" }, { header: "Diff from High", render: (r) => fmtNum(r.diff), sortKey: "diff" }],
    });
    renderMoversTable($("#movers-day-low"), dayLevelRes.value.low, {
      emptyText: "No F&O stock day-low data right now.",
      columns: [...ltpColumns, { header: "Day Low", render: (r) => fmtNum(r.dayLow), sortKey: "dayLow" }, { header: "Diff from Low", render: (r) => fmtNum(r.diff), sortKey: "diff" }],
    });
  }

  if (failures.length) showError(failures[0].reason?.message || "Some data failed to load");
  else clearError();

  $("#as-of").textContent = new Date().toLocaleTimeString("en-IN");
  const status = $("#market-status");
  const live = isMarketHoursIST();
  status.textContent = live ? "Market Live" : "Market Closed";
  status.classList.toggle("live", live);
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshAll, REFRESH_MS);
}
function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function init() {
  initTheme();
  initNav();
  initScannerControls();
  initScannersTabControls();

  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-backdrop").addEventListener("click", closeDrawer);
  $("#verdict-close").addEventListener("click", closeVerdictDrawer);
  $("#verdict-backdrop").addEventListener("click", closeVerdictDrawer);
  initVerdictTriggers();
  $("#refresh-btn").addEventListener("click", refreshAll);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeDrawer();
      closeVerdictDrawer();
    }
  });
  $("#auto-refresh-checkbox").addEventListener("change", (e) => {
    if (e.target.checked) startAutoRefresh();
    else stopAutoRefresh();
  });

  loadSectorFilterOptions($("#f-sector"));
  foglSectorControl.load();
  breadthSectorControl.load();
  refreshAll();
  startAutoRefresh();
  setInterval(tickClock, 1000);
}

init();
