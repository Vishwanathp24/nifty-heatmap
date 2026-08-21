const REFRESH_MS = 20000;

const $ = (sel) => document.querySelector(sel);

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

function symbolLink(symbol) {
  return `<a class="sym-link" href="${tvLink(symbol)}" target="_blank" rel="noopener noreferrer" title="Open ${symbol} chart on TradingView">${symbol}</a>`;
}

function nowIST() {
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  return new Date(istMs);
}

// Self-computed bullish/bearish/neutral read per sector, fetched from
// /api/sector-bias and refreshed alongside everything else - see
// NSEClient.get_sector_bias in the backend for how it's computed.
let sectorBias = {};

function sectorLabel(sector) {
  if (!sector) return `<span class="muted">—</span>`;
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
  if (!since) return `<span class="muted">—</span>`;
  const [h, m] = since.split(":");
  const now = nowIST();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const sinceMins = Number(h) * 60 + Number(m);
  const elapsed = Math.max(0, nowMins - sinceMins);
  const elapsedLabel = elapsed < 1 ? "just now" : elapsed < 60 ? `${elapsed}m ago` : `${Math.floor(elapsed / 60)}h ${elapsed % 60}m ago`;
  return `${h}:${m} <span class="muted">(${elapsedLabel})</span>`;
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
  banner.textContent = `⚠ ${msg} — will keep retrying in the background.`;
  banner.classList.remove("hidden");
}

function clearError() {
  $("#error-banner").classList.add("hidden");
}

// -- Heatmap ------------------------------------------------------------

function tileColor(pChange) {
  const p = pChange ?? 0;
  // Saturate at +/-1.5% (was 3%) and floor at 25% intensity so even tiny
  // moves render as a clearly-colored tile instead of a near-white one.
  const mag = Math.max(Math.min(Math.abs(p), 1.5) / 1.5, p === 0 ? 0 : 0.25);
  if (p > 0) {
    // interpolate darker-light -> dark green
    return mixColor("#7fcfa0", "#0c6e37", mag);
  } else if (p < 0) {
    return mixColor("#e89a9a", "#9c1c26", mag);
  }
  return "#9aa0b4";
}

function mixColor(c1, c2, t) {
  const a = hexToRgb(c1);
  const b = hexToRgb(c2);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}

function hexToRgb(hex) {
  const v = hex.replace("#", "");
  return {
    r: parseInt(v.substring(0, 2), 16),
    g: parseInt(v.substring(2, 4), 16),
    b: parseInt(v.substring(4, 6), 16),
  };
}

// -- Market Overview (index strip + bias) ----------------------------------

function renderMarketOverview(data) {
  const strip = $("#index-strip");
  strip.innerHTML = data.indices
    .map(
      (idx) => `
    <div class="index-card">
      <div class="idx-name">${idx.symbol}</div>
      <div class="idx-val">${fmtNum(idx.last, 2)}</div>
      <div class="idx-chg ${chgClass(idx.pChange)}">${sign(idx.change)}${fmtNum(idx.change, 2)} (${sign(idx.pChange)}${fmtNum(idx.pChange, 2)}%)</div>
    </div>`
    )
    .join("");

  const { label, factors } = data.bias;
  const labelEl = $("#bias-label");
  labelEl.textContent = label;
  labelEl.className = `bias-value ${label.toLowerCase().startsWith("bull") ? "bullish" : label.toLowerCase().startsWith("bear") ? "bearish" : "neutral"}`;
  syncScannerToBias(label);

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

function renderHeatmap(sectors) {
  const grid = $("#heatmap-grid");
  grid.innerHTML = "";
  const totalStocks = sectors.reduce((sum, s) => sum + (s.stockCount || 0), 0);
  $("#sector-count").textContent = `(${sectors.length} sectors, ${totalStocks} stocks)`;
  const sorted = [...sectors].sort((a, b) => (b.pChange ?? -Infinity) - (a.pChange ?? -Infinity));
  for (const s of sorted) {
    const tile = document.createElement("div");
    tile.className = "tile";
    tile.style.background = tileColor(s.pChange);
    tile.innerHTML = `
      <div class="sym">${s.symbol} <span class="tile-count">(${s.stockCount ?? "?"})</span></div>
      <div class="val">${fmtNum(s.last, 2)}</div>
      <div class="chg">${sign(s.pChange)}${fmtNum(s.pChange, 2)}%</div>
    `;
    tile.addEventListener("click", () => openSectorModal(s.symbol));
    grid.appendChild(tile);
  }
}

// -- Sector drill-down modal ---------------------------------------------

async function openSectorModal(symbol) {
  const modal = $("#sector-modal");
  modal.classList.remove("hidden");
  $("#modal-title").textContent = symbol;
  $("#modal-body").innerHTML = `<div class="skeleton">Loading…</div>`;
  try {
    const data = await fetchJSON(`/api/sector?symbol=${encodeURIComponent(symbol)}`);
    renderSectorStocks(data.stocks);
  } catch (err) {
    $("#modal-body").innerHTML = `<div class="empty-note">Couldn't load: ${err.message}</div>`;
  }
}

function renderSectorStocks(stocks) {
  if (!stocks.length) {
    $("#modal-body").innerHTML = `<div class="empty-note">No constituent data available.</div>`;
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
  $("#modal-body").innerHTML = `
    <table>
      <thead><tr><th>Symbol</th><th>LTP</th><th>Chg %</th><th>Open</th><th>Volume</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function closeSectorModal() {
  $("#sector-modal").classList.add("hidden");
}

// -- Advance / Decline ----------------------------------------------------

let advDeclExpanded = false;

function renderAdvanceDecline(data) {
  const { advances, declines, unchanged, total, stocks } = data;
  const advPct = total ? (advances / total) * 100 : 0;
  const decPct = total ? (declines / total) * 100 : 0;
  const uncPct = total ? (unchanged / total) * 100 : 0;

  const body = $("#advdecl-body");
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
    <button class="ad-toggle" id="ad-toggle-btn">${advDeclExpanded ? "Hide" : "Show"} all 50 stocks</button>
    <div id="ad-detail"></div>
  `;
  $("#ad-toggle-btn").addEventListener("click", () => {
    advDeclExpanded = !advDeclExpanded;
    renderAdvanceDecline(data);
  });
  if (advDeclExpanded) {
    const sortState = tableSortState["ad-detail"];
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
      ? [...stocks].sort((a, b) => {
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
      : stocks;
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
    const detailEl = $("#ad-detail");
    detailEl.innerHTML = `
      <table>
        <thead><tr><th>Symbol</th><th class="cell-left">Sector</th>${sortHeadCells}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    detailEl.querySelectorAll("th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.sortKey;
        const cur = tableSortState["ad-detail"];
        tableSortState["ad-detail"] = { key, dir: cur && cur.key === key ? -cur.dir : -1 };
        renderAdvanceDecline(data);
      });
    });
  }
}

// -- F&O Gainers / Losers / Volume (paginated "show more") -----------------

const DEFAULT_MOVER_COLUMNS = [
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
  const columns = opts.columns || DEFAULT_MOVER_COLUMNS;
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
      (r) =>
        `<tr>${columns.map((c) => `<td class="${c.cls || ""}">${c.render(r)}</td>`).join("")}</tr>`
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

// -- Sector filter (every F&O-scoped panel: Gainers/Losers, Most Active,
// Volume Gainers, 52-Week High/Low) ------------------------------------------

let selectedSector = "ALL";
const latestFO = {
  gainers: [],
  losers: [],
  mostActiveVolume: [],
  mostActiveValue: [],
  volumeGainers: [],
  week52High: [],
  week52Low: [],
  dayHigh: [],
  dayLow: [],
};

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
    // Filter just won't have extra options beyond "All Sectors" - non-fatal.
  }
}

const MOST_ACTIVE_VOLUME_COLUMNS = [
  ...DEFAULT_MOVER_COLUMNS,
  { header: "Volume", render: (r) => fmtInt(r.totalTradedVolume), sortKey: "totalTradedVolume" },
];
const MOST_ACTIVE_VALUE_COLUMNS = [
  ...DEFAULT_MOVER_COLUMNS,
  { header: "Value (₹)", render: (r) => fmtInt(r.totalTradedValue), sortKey: "totalTradedValue" },
];
const VOLUME_GAINERS_COLUMNS = [
  ...DEFAULT_MOVER_COLUMNS,
  { header: "Volume", render: (r) => fmtInt(r.volume), sortKey: "volume" },
  { header: "1wk Avg Vol", render: (r) => fmtInt(r.week1AvgVolume), sortKey: "week1AvgVolume" },
];
const WEEK52_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "LTP", render: (r) => fmtNum(r.ltp), sortKey: "ltp" },
  {
    header: "Chg %",
    render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>`,
    sortKey: "pChange",
  },
  { header: "52wk Level", render: (r) => fmtNum(r.level), sortKey: "level" },
  { header: "Level Date", render: (r) => r.levelDate || "--" },
];
// Same "diff from the extreme" idea for both - Day High wants the small end
// of (dayHigh - LTP), Day Low wants the small end of (LTP - dayLow); each
// table arrives pre-sorted (closest first) from the server.
const DAY_HIGH_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "LTP", render: (r) => fmtNum(r.ltp), sortKey: "ltp" },
  {
    header: "Chg %",
    render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>`,
    sortKey: "pChange",
  },
  { header: "Day High", render: (r) => fmtNum(r.dayHigh), sortKey: "dayHigh" },
  { header: "Diff from High", render: (r) => fmtNum(r.diff), sortKey: "diff" },
];
const DAY_LOW_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "LTP", render: (r) => fmtNum(r.ltp), sortKey: "ltp" },
  {
    header: "Chg %",
    render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>`,
    sortKey: "pChange",
  },
  { header: "Day Low", render: (r) => fmtNum(r.dayLow), sortKey: "dayLow" },
  { header: "Diff from Low", render: (r) => fmtNum(r.diff), sortKey: "diff" },
];

function renderFOPanels() {
  const gainers = filterBySector(latestFO.gainers);
  const losers = filterBySector(latestFO.losers);
  const mostActiveVolume = filterBySector(latestFO.mostActiveVolume);
  const mostActiveValue = filterBySector(latestFO.mostActiveValue);
  const volumeGainers = filterBySector(latestFO.volumeGainers);
  const week52High = filterBySector(latestFO.week52High);
  const week52Low = filterBySector(latestFO.week52Low);
  const sectorSuffix = selectedSector === "ALL" ? "" : ` for ${selectedSector}`;

  renderMoversTable($("#fo-gainers"), gainers, {
    emptyText: `No F&O gainers${sectorSuffix} right now.`,
  });
  renderMoversTable($("#fo-losers"), losers, {
    emptyText: `No F&O losers${sectorSuffix} right now.`,
  });
  renderMoversTable($("#most-active-volume"), mostActiveVolume, {
    emptyText: `No F&O stocks${sectorSuffix} in today's most-active-by-volume list.`,
    columns: MOST_ACTIVE_VOLUME_COLUMNS,
  });
  renderMoversTable($("#most-active-value"), mostActiveValue, {
    emptyText: `No F&O stocks${sectorSuffix} in today's most-active-by-value list.`,
    columns: MOST_ACTIVE_VALUE_COLUMNS,
  });
  renderMoversTable($("#volume-gainers-table"), volumeGainers, {
    emptyText:
      selectedSector === "ALL"
        ? "None of today's NSE volume-gainer names are F&O stocks right now (that list tends to be dominated by illiquid small caps)."
        : `No F&O stocks${sectorSuffix} in today's volume-gainers list.`,
    columns: VOLUME_GAINERS_COLUMNS,
  });
  renderMoversTable($("#week52-high-table"), week52High, {
    emptyText: `No F&O stocks${sectorSuffix} at a new 52-week high right now.`,
    columns: WEEK52_COLUMNS,
  });
  renderMoversTable($("#week52-low-table"), week52Low, {
    emptyText: `No F&O stocks${sectorSuffix} at a new 52-week low right now.`,
    columns: WEEK52_COLUMNS,
  });
  renderMoversTable($("#day-high-table"), filterBySector(latestFO.dayHigh), {
    emptyText: `No F&O stocks${sectorSuffix} with day-high data right now.`,
    columns: DAY_HIGH_COLUMNS,
  });
  renderMoversTable($("#day-low-table"), filterBySector(latestFO.dayLow), {
    emptyText: `No F&O stocks${sectorSuffix} with day-low data right now.`,
    columns: DAY_LOW_COLUMNS,
  });

  const hint = $("#sector-filter-hint");
  hint.textContent =
    selectedSector === "ALL"
      ? ""
      : `${gainers.length}g · ${losers.length}l · ${mostActiveVolume.length}ma · ${volumeGainers.length}vg · ${week52High.length + week52Low.length}w52`;
}

// -- ORB Scanner -------------------------------------------------------------

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

// -- Buy/Sell Scanner ---------------------------------------------------------

let selectedScanDirection = "buy";
let selectedScanTimeframe = 60;
let scannerAutoSync = true; // stays true until the user manually picks buy/sell

// Daily-leg columns - always shown, meaningfully different per row (real
// NSE EOD history, ready almost immediately).
const SCANNER_DAILY_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "LTP", render: (r) => fmtNum(r.ltp) },
  { header: "Chg %", render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>` },
  { header: "Daily RSI(14)", render: (r) => fmtNum(r.dailyRsi14) },
  { header: "Daily vs SMA20", render: (r) => `${fmtNum(r.dailyClose)} / ${fmtNum(r.dailySma20)}`, cls: "mobile-hide" },
];
// Intraday-leg columns - only worth showing once the selected timeframe's
// self-tracked candle history is ready; before that, every row reads
// "pending" / "Daily only — intraday pending" / "—" identically, which is
// clutter, not information (the status note above the table already says
// the timeframe is still building).
const SCANNER_INTRADAY_COLUMNS = [
  { header: "Intraday RSI(14)", render: (r) => fmtNum(r.intradayRsi14) },
  { header: "Intraday vs SMA20", render: (r) => `${fmtNum(r.intradayClose)} / ${fmtNum(r.intradaySma20)}`, cls: "mobile-hide" },
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

function scannerColumns(intradayReady) {
  return intradayReady ? [...SCANNER_DAILY_COLUMNS, ...SCANNER_INTRADAY_COLUMNS] : SCANNER_DAILY_COLUMNS;
}

function renderScannerStatusNote(status) {
  const note = $("#scanner-status-note");
  if (!status) {
    note.textContent = "";
    return;
  }
  const daily = status.dailyReady
    ? `Daily: ready (${status.dailyBarsAvailable} real trading days).`
    : `Daily: building (${status.dailyBarsAvailable}/${status.dailyBarsNeeded} trading days).`;
  const tf = status.timeframes[String(selectedScanTimeframe)];
  const intraday = tf.ready
    ? `${selectedScanTimeframe}-min: ready (${tf.barsAvailable} bars, self-tracked).`
    : `${selectedScanTimeframe}-min: building (${tf.barsAvailable}/${tf.barsNeeded} bars).`;
  note.textContent = `${daily} ${intraday}`;
}

function syncScannerToBias(label) {
  if (!scannerAutoSync) return;
  const lower = label.toLowerCase();
  const wanted = lower.startsWith("bull") ? "buy" : lower.startsWith("bear") ? "sell" : null;
  if (!wanted || wanted === selectedScanDirection) return;
  selectedScanDirection = wanted;
  $("#scanner-tabs").querySelectorAll(".orb-tab").forEach((b) => b.classList.toggle("active", b.dataset.direction === wanted));
  refreshScanner();
}

async function refreshScanner() {
  try {
    const data = await fetchJSON(`/api/scanner?direction=${selectedScanDirection}&timeframe=${selectedScanTimeframe}`);
    renderScannerStatusNote(data.status);
    const tf = data.status.timeframes[String(selectedScanTimeframe)];
    const columns = scannerColumns(Boolean(tf && tf.ready));
    renderMoversTable($("#scanner-table"), data.stocks.filter((s) => s.dailyPass), {
      emptyText: `No stocks currently pass the daily ${selectedScanDirection} conditions.`,
      columns,
    });
  } catch (err) {
    $("#scanner-table").innerHTML = `<div class="empty-note">Couldn't load scanner data: ${err.message}</div>`;
  }
}

// -- 15-Min Breakout Scanner --------------------------------------------------

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
  note.textContent = status.ready
    ? `Ready (${status.barsAvailable} 15-min bars, self-tracked, persisted across days).`
    : `Building (${status.barsAvailable}/${status.barsNeeded} 15-min bars) — fills within a single session once tracking starts.`;
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

// -- F&O Stock List (Volume & RSI) -------------------------------------------

const FO_STOCK_LIST_COLUMNS = [
  { header: "Symbol", render: (r) => symbolLink(r.symbol) },
  { header: "Sector", render: (r) => sectorLabel(r.sector), cls: "cell-left" },
  { header: "LTP", render: (r) => fmtNum(r.ltp), sortKey: "ltp" },
  {
    header: "Chg %",
    render: (r) => `<span class="${chgClass(r.pChange)}">${sign(r.pChange)}${fmtNum(r.pChange)}%</span>`,
    sortKey: "pChange",
  },
  { header: "Volume", render: (r) => fmtInt(r.volume), sortKey: "volume" },
  { header: "RSI(14)", render: (r) => (r.rsi14 != null ? fmtNum(r.rsi14) : "--"), sortKey: "rsi14" },
  { header: "Mkt Cap (₹Cr)", render: (r) => fmtInt(r.marketCapCr), sortKey: "marketCapCr" },
  { header: "Turnover (₹Cr)", render: (r) => fmtNum(r.turnoverCr), sortKey: "turnoverCr" },
  { header: "Up from 52wL %", render: (r) => fmtNum(r.upFromLowPct), sortKey: "upFromLowPct" },
];

async function refreshFoStockList() {
  try {
    const data = await fetchJSON("/api/fo-stock-list");
    const qualifying = data.stocks.filter((s) => s.qualifies);
    $("#fo-stock-list-note").textContent =
      `${qualifying.length} of ${data.symbolsWithData} F&O stocks qualify on the 4 applied conditions ` +
      `(ROCE condition not applied - see note above).`;
    renderMoversTable($("#fo-stock-list-table"), qualifying, {
      emptyText: "No F&O stocks currently qualify on all 4 conditions.",
      columns: FO_STOCK_LIST_COLUMNS,
    });
  } catch (err) {
    $("#fo-stock-list-table").innerHTML = `<div class="empty-note">Couldn't load F&O stock list: ${err.message}</div>`;
  }
}

// -- Fetch cycle ------------------------------------------------------------

async function refreshAll() {
  // Fetched (and applied to the `sectorBias` global) before the main batch
  // below so every sectorLabel() call this cycle - inside refreshOrb()/
  // refreshScanner()/refreshBreakoutScanner()/refreshFoStockList(), which
  // run concurrently in that batch - sees the freshest data rather than
  // racing it.
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
    fetchJSON("/api/fo/gainers-losers"),
    fetchJSON("/api/most-active"),
    fetchJSON("/api/volume-gainers"),
    fetchJSON("/api/52-week"),
    fetchJSON("/api/day-level-stocks"),
    refreshOrb(),
    refreshScanner(),
    refreshBreakoutScanner(),
    refreshFoStockList(),
  ]);

  const [overviewRes, heatmapRes, advDeclRes, foRes, mostActiveRes, volGainersRes, week52Res, dayLevelRes] = results;
  const failures = results.filter((r) => r.status === "rejected");

  if (overviewRes.status === "fulfilled") renderMarketOverview(overviewRes.value);
  if (heatmapRes.status === "fulfilled") renderHeatmap(heatmapRes.value.sectors);
  if (advDeclRes.status === "fulfilled") renderAdvanceDecline(advDeclRes.value);
  if (foRes.status === "fulfilled") {
    latestFO.gainers = foRes.value.gainers;
    latestFO.losers = foRes.value.losers;
  }
  if (mostActiveRes.status === "fulfilled") {
    latestFO.mostActiveVolume = mostActiveRes.value.byVolume;
    latestFO.mostActiveValue = mostActiveRes.value.byValue;
  }
  if (volGainersRes.status === "fulfilled") {
    latestFO.volumeGainers = volGainersRes.value.stocks;
  }
  if (week52Res.status === "fulfilled") {
    latestFO.week52High = week52Res.value.high;
    latestFO.week52Low = week52Res.value.low;
  }
  if (dayLevelRes.status === "fulfilled") {
    latestFO.dayHigh = dayLevelRes.value.high;
    latestFO.dayLow = dayLevelRes.value.low;
  }
  if (
    foRes.status === "fulfilled" ||
    mostActiveRes.status === "fulfilled" ||
    volGainersRes.status === "fulfilled" ||
    week52Res.status === "fulfilled" ||
    dayLevelRes.status === "fulfilled"
  ) {
    renderFOPanels();
  }

  if (failures.length) {
    showError(failures[0].reason?.message || "Some data failed to load");
  } else {
    clearError();
  }

  $("#as-of").innerHTML = `<span class="as-of-label">Last updated: </span>${new Date().toLocaleTimeString("en-IN")}`;
  $("#market-status").textContent = isMarketHoursIST() ? "Market Live" : "Market Closed";
}

function isMarketHoursIST() {
  // IST = UTC+5:30. NSE cash session: 09:15–15:30 IST, Mon–Fri.
  const now = new Date();
  const istMs = now.getTime() + (5.5 * 60 + now.getTimezoneOffset()) * 60000;
  const ist = new Date(istMs);
  const day = ist.getDay();
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return day >= 1 && day <= 5 && mins >= 555 && mins <= 930;
}

// -- Theme toggle -------------------------------------------------------------

function currentTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark" || attr === "light") return attr;
  // No explicit choice made yet - reflect system preference (the page is
  // already following it live via CSS; this is just so the icon matches).
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function setThemeIcon(theme) {
  $("#theme-toggle").textContent = theme === "dark" ? "☀️" : "🌙";
}

function initTheme() {
  setThemeIcon(currentTheme());
  $("#theme-toggle").addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("nifty-theme", next);
    setThemeIcon(next);
  });
}

async function init() {
  initTheme();
  $("#modal-close").addEventListener("click", closeSectorModal);
  $("#modal-backdrop").addEventListener("click", closeSectorModal);
  $("#refresh-btn").addEventListener("click", refreshAll);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeSectorModal();
  });
  $("#sector-filter").addEventListener("change", (e) => {
    selectedSector = e.target.value;
    renderFOPanels();
  });
  $("#orb-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".orb-tab");
    if (!btn) return;
    selectedOrbWindow = Number(btn.dataset.window);
    $("#orb-tabs").querySelectorAll(".orb-tab").forEach((b) => b.classList.toggle("active", b === btn));
    renderOrbStatusNote();
    refreshOrb();
  });
  $("#scanner-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".orb-tab");
    if (!btn) return;
    scannerAutoSync = false; // user took control - stop auto-following Market Bias
    selectedScanDirection = btn.dataset.direction;
    $("#scanner-tabs").querySelectorAll(".orb-tab").forEach((b) => b.classList.toggle("active", b === btn));
    refreshScanner();
  });
  $("#scanner-timeframe-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".orb-tab");
    if (!btn) return;
    selectedScanTimeframe = Number(btn.dataset.timeframe);
    $("#scanner-timeframe-tabs").querySelectorAll(".orb-tab").forEach((b) => b.classList.toggle("active", b === btn));
    refreshScanner();
  });
  $("#breakout-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".orb-tab");
    if (!btn) return;
    selectedBreakoutDirection = btn.dataset.direction;
    $("#breakout-tabs").querySelectorAll(".orb-tab").forEach((b) => b.classList.toggle("active", b === btn));
    refreshBreakoutScanner();
  });
  $("#fo-stock-list-toggle").addEventListener("click", () => {
    const expanded = $("#fo-stock-list-content").classList.toggle("hidden") === false;
    $("#fo-stock-list-toggle").textContent = expanded ? "Hide qualifying stocks" : "Show qualifying stocks";
  });

  loadSectorFilterOptions();
  refreshAll();
  setInterval(refreshAll, REFRESH_MS);
}

init();
