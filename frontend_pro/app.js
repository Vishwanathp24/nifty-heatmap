const REFRESH_MS = 20000;

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------- helpers

function fmtNum(n, digits = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "--";
  return Number(n).toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
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

function sign(v) {
  return v > 0 ? "+" : "";
}

function tvLink(symbol) {
  return `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(`NSE:${symbol}`)}`;
}

function symbolLink(symbol) {
  return `<a class="sym-link" href="${tvLink(symbol)}" target="_blank" rel="noopener noreferrer" title="Open ${symbol} chart on TradingView">${symbol}</a>`;
}

function sectorLabel(sector) {
  return sector ? sector : `<span class="flat">&mdash;</span>`;
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

// ---------------------------------------------------------------- heatmap

function tileBarColor(pChange) {
  const p = pChange ?? 0;
  if (p > 0) return "var(--up)";
  if (p < 0) return "var(--down)";
  return "var(--text-faint)";
}

function tileBarWidth(pChange) {
  const p = Math.abs(pChange ?? 0);
  return `${Math.max(Math.min((p / 1.5) * 100, 100), 12)}%`;
}

function renderHeatmap(sectors) {
  const grid = $("#heatmap-grid");
  grid.innerHTML = "";
  const totalStocks = sectors.reduce((sum, s) => sum + (s.stockCount || 0), 0);
  $("#sector-count").textContent = `${sectors.length} sectors · ${totalStocks} stocks`;
  const sorted = [...sectors].sort((a, b) => (b.pChange ?? -Infinity) - (a.pChange ?? -Infinity));
  for (const s of sorted) {
    const tile = document.createElement("div");
    tile.className = "hm-tile";
    tile.innerHTML = `
      <div class="sym">${s.symbol} <span class="count">(${s.stockCount ?? "?"})</span></div>
      <div class="val">${fmtNum(s.last, 2)}</div>
      <div class="chg ${chgClass(s.pChange)}">${sign(s.pChange)}${fmtNum(s.pChange, 2)}%</div>
      <div class="bar" style="width:${tileBarWidth(s.pChange)};background:${tileBarColor(s.pChange)}"></div>
    `;
    tile.addEventListener("click", () => openDrawer(s.symbol));
    grid.appendChild(tile);
  }
}

// ---------------------------------------------------------------- drawer

async function openDrawer(symbol) {
  const drawer = $("#drawer");
  drawer.classList.remove("hidden");
  $("#drawer-title").textContent = symbol;
  $("#drawer-body").innerHTML = `<div class="skel-line"></div>`;
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
    <table>
      <thead><tr><th>Symbol</th><th>LTP</th><th>Chg %</th><th>Open</th><th>Volume</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function closeDrawer() {
  $("#drawer").classList.add("hidden");
}

// ---------------------------------------------------------------- market overview

function renderMarketOverview(data) {
  $("#index-cards").innerHTML = data.indices
    .map(
      (idx) => `
    <div class="idx-card">
      <div class="idx-name">${idx.symbol}</div>
      <div class="idx-val">${fmtNum(idx.last, 2)}</div>
      <div class="idx-chg ${chgClass(idx.pChange)}">${sign(idx.change)}${fmtNum(idx.change, 2)} (${sign(idx.pChange)}${fmtNum(idx.pChange, 2)}%)</div>
    </div>`
    )
    .join("");

  const { label, factors } = data.bias;
  const biasEl = $("#bias-value");
  biasEl.textContent = label;
  biasEl.className = `bias-value ${label.toLowerCase().startsWith("bull") ? "bullish" : label.toLowerCase().startsWith("bear") ? "bearish" : "neutral"}`;

  $("#bias-factors").innerHTML = factors
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

let adExpanded = false;

function renderAdvanceDecline(data) {
  const { advances, declines, unchanged, total, stocks } = data;
  const advPct = total ? (advances / total) * 100 : 0;
  const decPct = total ? (declines / total) * 100 : 0;
  const uncPct = total ? (unchanged / total) * 100 : 0;

  const body = $("#ad-body");
  body.innerHTML = `
    <div class="ad-summary">
      <div class="ad-bar">
        <div class="adv" style="width:${advPct}%"></div>
        <div class="dec" style="width:${decPct}%"></div>
        <div class="unc" style="width:${uncPct}%"></div>
      </div>
      <div class="ad-counts">
        <span class="adv-c">Advancing <b>${advances}</b></span>
        <span class="dec-c">Declining <b>${declines}</b></span>
        <span>Unchanged <b>${unchanged}</b></span>
      </div>
    </div>
    <button class="ad-toggle" id="ad-toggle-btn">${adExpanded ? "Hide" : "Show"} all 50 stocks</button>
    <div id="ad-detail"></div>
  `;
  $("#ad-toggle-btn").addEventListener("click", () => {
    adExpanded = !adExpanded;
    renderAdvanceDecline(data);
  });
  if (adExpanded) {
    const rows = stocks
      .map(
        (s) => `
      <tr>
        <td>${symbolLink(s.symbol)}</td>
        <td class="cell-left">${sectorLabel(s.sector)}</td>
        <td>${fmtNum(s.open)}</td>
        <td>${fmtNum(s.lastPrice)}</td>
        <td class="${chgClass(s.changeFromOpen)}">${sign(s.pctFromOpen)}${fmtNum(s.pctFromOpen)}%</td>
      </tr>`
      )
      .join("");
    $("#ad-detail").innerHTML = `
      <table>
        <thead><tr><th>Symbol</th><th class="cell-left">Sector</th><th>Open</th><th>LTP</th><th>Chg from Open</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }
}

// ---------------------------------------------------------------- F&O tables

const DEFAULT_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "LTP", render: (r) => fmtNum(r.lastPrice), sortKey: "lastPrice" },
  {
    header: "Chg %",
    render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>`,
    sortKey: "pChange",
  },
];

// Per-table (by element id) current sort - {key, dir} or absent for
// "whatever order the data arrived in" (usually already ranked server-side).
const tableSortState = {};

function renderMoversTable(el, rows, opts = {}) {
  if (!rows.length) {
    el.innerHTML = `<div class="empty-note">${opts.emptyText || "No data right now."}</div>`;
    return;
  }
  const columns = opts.columns || DEFAULT_COLUMNS;
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

  const head = columns
    .map((c) => {
      if (!c.sortKey) return `<th class="${c.cls || ""}">${c.header}</th>`;
      const active = state && state.key === c.sortKey;
      const arrow = active ? (state.dir === 1 ? " ▲" : " ▼") : "";
      return `<th class="${c.cls || ""} sortable" data-sort-key="${c.sortKey}">${c.header}${arrow}</th>`;
    })
    .join("");
  const body = sortedRows
    .map(
      (r) => `<tr>${columns.map((c) => `<td class="${c.cls || ""}">${c.render(r)}</td>`).join("")}</tr>`
    )
    .join("");
  el.innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;

  el.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      const cur = tableSortState[el.id];
      tableSortState[el.id] = { key, dir: cur && cur.key === key ? -cur.dir : -1 };
      renderMoversTable(el, rows, opts);
    });
  });
}

// ---------------------------------------------------------------- sector filter

const VOLUME_LEADERS_DEFAULT_COUNT = 20;
let selectedSector = "ALL";
const latestFO = { gainers: [], losers: [], leaders: [], spurts: [] };

function filterBySector(rows) {
  if (selectedSector === "ALL") return rows;
  return rows.filter((r) => r.sector === selectedSector);
}

async function loadSectorFilterOptions() {
  try {
    const { labels } = await fetchJSON("/api/sector-labels");
    const select = $("#sector-filter");
    for (const label of labels) {
      const opt = document.createElement("option");
      opt.value = label;
      opt.textContent = label;
      select.appendChild(opt);
    }
  } catch {
    // non-fatal - filter just has fewer options
  }
}

function renderFOPanels() {
  const gainers = filterBySector(latestFO.gainers);
  const losers = filterBySector(latestFO.losers);
  let leaders = filterBySector(latestFO.leaders);
  const spurts = filterBySector(latestFO.spurts);

  if (selectedSector === "ALL") leaders = leaders.slice(0, VOLUME_LEADERS_DEFAULT_COUNT);

  renderMoversTable($("#fo-gainers"), gainers, {
    emptyText: selectedSector === "ALL" ? "No F&O gainers data." : `No ${selectedSector} stocks in today's F&O gainers.`,
  });
  renderMoversTable($("#fo-losers"), losers, {
    emptyText: selectedSector === "ALL" ? "No F&O losers data." : `No ${selectedSector} stocks in today's F&O losers.`,
  });
  renderMoversTable($("#fo-volume"), leaders, {
    emptyText: selectedSector === "ALL" ? "No volume data available." : `No ${selectedSector} F&O stocks found.`,
    columns: [
      ...DEFAULT_COLUMNS,
      { header: "Volume", render: (r) => fmtInt(r.totalTradedVolume), sortKey: "totalTradedVolume" },
    ],
  });
  renderMoversTable($("#fo-spurts"), spurts, {
    emptyText:
      selectedSector === "ALL"
        ? "None of today's NSE volume-spurt names are in the F&O list right now."
        : `No ${selectedSector} stocks in today's volume-spurt list.`,
    columns: [
      ...DEFAULT_COLUMNS,
      { header: "1wk Avg Vol", render: (r) => fmtInt(r.week1AvgVolume), sortKey: "week1AvgVolume" },
    ],
  });

  const hint = $("#filter-hint");
  hint.textContent = selectedSector === "ALL" ? "" : `${gainers.length}g · ${losers.length}l · ${leaders.length}v`;
}

// ---------------------------------------------------------------- fetch cycle

async function refreshAll() {
  const results = await Promise.allSettled([
    fetchJSON("/api/market-overview"),
    fetchJSON("/api/heatmap"),
    fetchJSON("/api/advance-decline"),
    fetchJSON("/api/fo/gainers-losers"),
    fetchJSON("/api/fo/volume"),
  ]);

  const [overviewRes, heatmapRes, advDeclRes, foRes, volRes] = results;
  const failures = results.filter((r) => r.status === "rejected");

  if (overviewRes.status === "fulfilled") renderMarketOverview(overviewRes.value);
  if (heatmapRes.status === "fulfilled") renderHeatmap(heatmapRes.value.sectors);
  if (advDeclRes.status === "fulfilled") renderAdvanceDecline(advDeclRes.value);
  if (foRes.status === "fulfilled") {
    latestFO.gainers = foRes.value.gainers;
    latestFO.losers = foRes.value.losers;
  }
  if (volRes.status === "fulfilled") {
    latestFO.leaders = volRes.value.leaders;
    latestFO.spurts = volRes.value.spurts;
  }
  if (foRes.status === "fulfilled" || volRes.status === "fulfilled") renderFOPanels();

  if (failures.length) {
    showError(failures[0].reason?.message || "Some data failed to load");
  } else {
    clearError();
  }

  $("#as-of").textContent = new Date().toLocaleTimeString("en-IN");
  const status = $("#market-status");
  const live = isMarketHoursIST();
  status.textContent = live ? "Market Live" : "Market Closed";
  status.classList.toggle("live", live);
}

function isMarketHoursIST() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  const ist = new Date(istMs);
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
}

function init() {
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-backdrop").addEventListener("click", closeDrawer);
  $("#refresh-btn").addEventListener("click", refreshAll);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });
  $("#sector-filter").addEventListener("change", (e) => {
    selectedSector = e.target.value;
    renderFOPanels();
  });

  loadSectorFilterOptions();
  refreshAll();
  setInterval(refreshAll, REFRESH_MS);
}

init();
