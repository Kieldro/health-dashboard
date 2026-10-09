import { loadAllData } from './data.js';

const COLORS = {
  blue: '#4a9eff',
  red: '#ff6b6b',
  green: '#51cf66',
  yellow: '#ffd43b',
  purple: '#cc5de8',
  orange: '#ff922b',
  cyan: '#22d3ee',
  pink: '#ff6bcb',
  blueFaded: 'rgba(74,158,255,0.3)',
  blueBar: 'rgba(74,158,255,0.7)',
};

// Personal goals from /home/keo/Documents/notes/goals.md.
// Near-term targets (Summer 2026); a few longer-term values noted in comments.
const GOALS = {
  weightLbs: 190,        // updated 2026-09-30 (was 193) — late Oct 2026 per goals.md
  bodyFatPct: 12,        // updated 2026-08-10 (was 13). DEXA scale — pairs with the 193 lb goal.
                         // Ignore the Renpho body-fat number: it isn't a measurement, it's
                         // 0.105 * weight - 5.28 (R^2 = 0.996 vs weight alone, Feb-Aug 2026).
  rhrBpm: 55,            // Jan 2027 (currently ~62)
  hrvMs: 44,             // late 2027 (currently ~25)
  vo2max: 50,            // Jan 2027 (currently ~40)
  hrRecovery60Bpm: 50,   // Jan 2027 (currently ~34)
};

// User-maintained event log — annotations get drawn on charts in matching scope.
// Edit this array to add race days, diet changes, injuries, etc.
const EVENTS = [
  // Personal events → dashed vertical line on matching charts.
  // scope: 'body' | 'running' | 'lifts' | 'all'. Uncomment / edit with real dates:
  // { date: '2026-04-19', label: 'Spring 5K',  scope: 'running' },
  // { date: '2026-01-01', label: 'New gym',    scope: 'lifts' },
  // { date: '2026-03-15', label: 'Cut start',  scope: 'body' },
];

// Lift-chart roster: canvas id → [exercise (as normalized by workout_sync.py),
// legend label, PR-star label, color, history start]. Retired lifts stay —
// they're history. When the programme changes add a row here; each card's
// "N of M lifts active" chip is what gives a stale roster away.
// Machine/cable loads aren't comparable across gyms, so those lifts clip their
// history to GYM_START (the current gym).
const GYM_START = '2026-01-01';
const LIFT_CHARTS = {
  upperMachineChart: [
    ['chest press', 'Chest Press', 'Chest', 'red', GYM_START],
    ['incline press', 'Incline Press', 'Incline', 'green', GYM_START],
    ['row machine', 'Row Machine', 'Row', 'blue', GYM_START],
    ['cable row', 'Cable Row', 'Cable Row', 'yellow', GYM_START],
    ['dips machine', 'Dips (machine)', 'Dips M', 'orange', GYM_START],
    ['dips weighted', 'Dips (weighted)', 'Dips W', 'purple', GYM_START],
  ],
  upperDBChart: [
    ['lateral raise', 'Lat Raise', 'Lat Raise', 'green'],
    ['hammer curl', 'Hammer Curls', 'Hammer', 'yellow'],
    ['kelso shrugs', 'Kelso Shrugs', 'Shrug', 'blue'],
    ['row db', 'DB Row', 'DB Row', 'red'],
    ['wrist curls', 'Wrist Curls', 'Wrist Curl', 'purple'],
    ['wrist extensions', 'Wrist Extensions', 'Wrist Ext', 'orange'],
    ['turkish getups', 'Turkish Get-ups', 'TGU', 'cyan'],
  ],
  lowerLegsChart: [
    ['leg press', 'Leg Press', 'Leg Press', 'purple', GYM_START],
    ['leg curl', 'Leg Curl (unilateral)', 'Leg Curl', 'blue', GYM_START],
    ['leg extension', 'Leg Extension', 'Leg Ext', 'pink', GYM_START],
    ['calf raise seated', 'Calf Raise (seated)', 'Calf', 'yellow'],
    ['leg press explosive', 'Leg Press (explosive)', 'Explosive', 'orange', GYM_START],
    ['tib machine', 'Tib Machine', 'Tib', 'green', GYM_START],
  ],
  lowerHipCoreChart: [
    ['abductors', 'Abductors', 'Abd', 'orange', GYM_START],
    ['adductors', 'Adductors', 'Add', 'red', GYM_START],
    ['side bend', 'Side Bend', 'Side', 'green'],
    ['ab machine', 'Ab Machine', 'Ab Mach', 'cyan'],
    ['cable crunches', 'Cable Crunches', 'Crunch', 'blue', GYM_START],
    ['cable wood chops', 'Cable Wood Chops', 'Wood Chop', 'yellow', GYM_START],
    ['hyper extensions', 'Hyperextensions', 'Hyper', 'purple'],
    ['decline sit ups weight on head', 'Decline Sit-ups (weighted)', 'Sit-up', 'pink'],
  ],
  lowerBBDBChart: [
    ['rdl barbell', 'RDL Barbell', 'RDL BB', 'red'],
    ['rdl dumbbell', 'RDL Dumbbell', 'RDL DB', 'yellow'],
    ['rack pulls', 'Rack Pulls', 'Rack Pull', 'blue'],
  ],
};
// The two hand-built lift charts (dual axis / weight-sized dots) — listed only
// so applyChartMetadata() gives them the same staleness chip.
const LIFT_CHART_EXTRA = {
  bodyweightChart: ['pull ups', 'v ups', 'push ups', 'calf raise bw', 'dead hang', 'gripper', 'front lever'],
  neckChart: ['neck extension', 'neck flexion'],
};

const GRID_COLOR = 'rgba(255,255,255,0.06)';
const TICK_COLOR = '#8b8fa3';

const ANIMATION = { duration: 1000, easing: 'easeOutQuart' };

function goalLineAnnotation(value, label, color = COLORS.yellow) {
  return {
    type: 'line',
    yMin: value,
    yMax: value,
    borderColor: color,
    borderWidth: 1.5,
    borderDash: [6, 4],
    label: {
      display: true,
      content: label,
      position: 'end',
      backgroundColor: 'transparent',
      color: color,
      font: { size: 10 },
      yAdjust: -8,
    },
  };
}

// ── Dates ───────────────────────────────────────────────────────────────
// Row dates are civil "YYYY-MM-DD" strings, so everything here works in LOCAL
// calendar days. toISOString() is UTC — already tomorrow after 19:00 CDT — and
// new Date("YYYY-MM-DD") is UTC midnight (the previous evening here), so the
// old ms/86400000 math called today's row "yesterday" every evening.

/** Local calendar date as "YYYY-MM-DD". */
function localISO(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Civil-day index of a "YYYY-MM-DD" string. The difference of two is a whole
 *  number of calendar days — no timezone or DST in it. */
function dayNum(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

/** Calendar days from a row date to today (0 = today, 1 = yesterday). */
function daysAgo(dateStr) {
  return dayNum(localISO()) - dayNum(dateStr);
}

/** "YYYY-MM-DD" → "May 13" (with the year when it isn't this one). */
function fmtDay(dateStr) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const opts = { month: 'short', day: 'numeric' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localISO(d);
}

/** Compute chart x-axis min for a preset key. `null` means "show all". */
function rangeMin(preset) {
  switch (preset) {
    case '1M': return isoDaysAgo(30);
    case '3M': return isoDaysAgo(90);
    case '6M': return isoDaysAgo(180);
    case '1Y': return isoDaysAgo(365);
    case 'All': return null;
    case 'YTD':
    default: return `${new Date().getFullYear()}-01-01`;
  }
}

/**
 * Build a name→annotation map for an array of `{date, label}` events.
 * Renders each as a dashed vertical line at the date with a small label at the top.
 */
function eventAnnotations(events, color = 'rgba(139,143,163,0.5)') {
  const ann = {};
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    ann[`event_${i}`] = {
      type: 'line',
      xMin: e.date,
      xMax: e.date,
      borderColor: color,
      borderWidth: 1,
      borderDash: [4, 4],
      label: {
        display: true,
        content: e.label,
        position: 'start',
        backgroundColor: 'transparent',
        color: color,
        font: { size: 9 },
        yAdjust: 8,
      },
    };
  }
  return ann;
}

/** Build the event list for a given chart scope ('body'|'running'|'lifts').
 *  DEXA scan dates are NOT auto-included as event lines — they already appear
 *  as green diamonds on the Body Fat chart, so labeling them on every chart
 *  was noise. Only user-defined events in EVENTS render as vertical lines. */
function eventsForScope(scope) {
  return EVENTS.filter(e => e.scope === scope || e.scope === 'all');
}

/** Merge an annotations map into opts.plugins.annotation, preserving any existing entries (goal lines, PR markers). */
function mergeAnnotations(opts, annotations) {
  if (!annotations || Object.keys(annotations).length === 0) return;
  opts.plugins.annotation = opts.plugins.annotation || { annotations: {} };
  opts.plugins.annotation.annotations = opts.plugins.annotation.annotations || {};
  Object.assign(opts.plugins.annotation.annotations, annotations);
}

function safeGetItem(key) {
  // localStorage access *throws* (not just returns null) on cookie-blocked
  // Safari and sandboxed iframes; an unguarded read at module load would abort
  // the whole app before the Chart fallback at the bottom can even run.
  try { return localStorage.getItem(key); } catch { return null; }
}
const SAVED_RANGE = safeGetItem('range') || 'YTD';
let currentRange = ['1M','3M','6M','YTD','1Y','All'].includes(SAVED_RANGE) ? SAVED_RANGE : 'YTD';
// x-axis window shared by every chart. Both ends are recomputed on each rebuild
// (see rebuildCharts) so a tab left open for days doesn't keep a stale window.
let currentMin = rangeMin(currentRange);
let currentMax = localISO();
const allCharts = [];

function relativeAgo(dateStr) {
  if (!dateStr) return '';
  const days = daysAgo(dateStr);
  if (days < 0) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days/7)}w ago`;
  return `${Math.floor(days/30)}mo ago`;
}

/** A row keyed by week start covers that day + 6, so it's "this week" until 7
 *  days after the key (weeks run Saturday→Friday). */
function isCurrentWeek(weekStr) {
  const days = daysAgo(weekStr);
  return days >= 0 && days < 7;
}

/** relativeAgo for week-keyed rows. */
function relativeWeek(weekStr) {
  if (!weekStr) return '';
  const days = daysAgo(weekStr);
  if (days < 0) return '';
  if (days < 7) return 'this wk';
  if (days < 14) return 'last wk';
  return relativeAgo(weekStr);
}

// Staleness thresholds for the "last updated" chip, in days since the data's
// own date. Week-keyed rows get WEEK_SPAN days of grace (the row is still
// being filled until the week ends).
const STALE_AMBER_DAYS = 7;
const STALE_RED_DAYS = 21;
const WEEK_SPAN = 6;

/** `weekly`: lastDate is a week-start key rather than a day. */
function setChartMeta(canvasId, latest, lastDate, goalNote, { weekly = false } = {}) {
  const canvas = document.getElementById(canvasId);
  const card = canvas?.closest('.chart-card');
  if (!card) return;
  let meta = card.querySelector('.chart-meta');
  if (!meta) {
    meta = document.createElement('div');
    meta.className = 'chart-meta';
    card.querySelector('h2')?.after(meta);
  }
  const ago = weekly ? relativeWeek(lastDate) : relativeAgo(lastDate);
  // Staleness: flag metrics that haven't updated within their expected cadence
  // (catches a silently-broken sync — e.g. hr-recovery that's weeks behind).
  const days = lastDate ? daysAgo(lastDate) - (weekly ? WEEK_SPAN : 0) : -1;
  const stale = days > STALE_RED_DAYS ? ' stale-red' : days > STALE_AMBER_DAYS ? ' stale-amber' : '';
  meta.innerHTML =
    (latest ? `<span class="chart-latest">${latest}</span>` : '') +
    (goalNote ? `<span class="chart-goal">${goalNote}</span>` : '') +
    (ago ? `<span class="chart-updated${stale}" title="updated ${ago}">${ago}</span>` : '');
}

function updateRangeCaption() {
  const el = document.getElementById('rangeCaption');
  if (!el) return;
  el.textContent = currentMin
    ? `Showing ${currentMin} → ${currentMax} (${currentRange})`
    : `Showing all data (${currentRange})`;
}

function fmtPace(minPerMi) {
  if (minPerMi == null) return '';
  let m = Math.floor(minPerMi);
  let s = Math.round((minPerMi - m) * 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${String(s).padStart(2, '0')}/mi`;
}

/** Shared x-scale so every chart reads `currentMin`/`currentMax` from one place.
 *  `max` is pinned to today: left to auto-fit, an axis ends at its last point,
 *  so a series that stopped months ago looked current (and at 1M, with nothing
 *  in range, collapsed to a blank one-day axis). */
function xScale(timeUnit = 'month') {
  return {
    type: 'time',
    time: { unit: timeUnit },
    min: currentMin,
    max: currentMax,
    grid: { color: GRID_COLOR },
    ticks: { color: TICK_COLOR },
  };
}

/** Shared defaults for all charts */
function baseOptions({ timeUnit = 'month', showLegend = false, yLabel = '' } = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      title: { display: false },
      legend: {
        display: showLegend,
        labels: { color: TICK_COLOR, boxWidth: 12 },
      },
      tooltip: {
        filter: (item) => !item.dataset.label?.startsWith('_'),
      },
      zoom: {
        // 'xy' enables both wheel-zoom Y and drag-pan Y in addition to X.
        // Dual-axis charts (5K, Bodyweight) override back to 'x' below since
        // y-zoom on a two-scale chart is ambiguous about which scale to zoom.
        zoom: {
          wheel: { enabled: true },
          pinch: { enabled: true },
          mode: 'xy',
          // A bare wheel must scroll the page, not get swallowed by whichever
          // chart is under the cursor: in the grid, wheel-zoom needs Ctrl (which
          // is also what a trackpad pinch sends). The expanded full-page view
          // has nothing to scroll, so a plain wheel zooms there. Returning false
          // rejects the zoom before the plugin calls preventDefault. Checked
          // per event rather than via wheel.modifierKey so it follows the card
          // in and out of the expanded view without touching chart options.
          onZoomStart: ({ chart, event }) => event.type !== 'wheel' || event.ctrlKey
            || chart.canvas.closest('.chart-card.expanded') != null,
        },
        pan: {
          enabled: true,
          mode: 'xy',
        },
      },
    },
    scales: {
      x: xScale(timeUnit),
      y: {
        grid: { color: GRID_COLOR },
        ticks: { color: TICK_COLOR },
        ...(yLabel ? { title: { display: true, text: yLabel, color: TICK_COLOR } } : {}),
      },
    },
  };
}

/** Hidden trendline dataset (label prefixed with `_` so tooltips/legend skip it). */
function trendline(label, points, color, opts = {}) {
  return {
    label: `_${label}Trend`,
    data: linearTrendline(points),
    ...lineDefaults(color),
    pointRadius: 0,
    borderDash: [6, 3],
    tension: 0,
    ...opts,
  };
}

/** Shared dataset defaults for line charts */
function lineDefaults(color) {
  return {
    borderColor: color,
    backgroundColor: color,
    pointRadius: 2,
    pointHoverRadius: 4,
    tension: 0.3,
    borderWidth: 2,
    fill: false,
  };
}

/** Compute simple linear regression and return trendline points */
function linearTrendline(points) {
  // Drop null/NaN y's first: one null makes sumY NaN and the whole trendline
  // vanishes (hrv/vo2/sleep-score series can carry gaps).
  points = points.filter(p => p.y != null && !Number.isNaN(p.y));
  if (points.length < 2) return [];
  const xs = points.map(p => new Date(p.x).getTime());
  const ys = points.map(p => p.y);
  const n = xs.length;
  const sumX = xs.reduce((a, b) => a + b, 0);
  const sumY = ys.reduce((a, b) => a + b, 0);
  const sumXY = xs.reduce((a, x, i) => a + x * ys[i], 0);
  const sumX2 = xs.reduce((a, x) => a + x * x, 0);
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return [];  // every point shares one x → no slope (avoid NaN)
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  const first = xs[0];
  const last = xs[xs.length - 1];
  return [
    { x: new Date(first).toISOString().split('T')[0], y: slope * first + intercept },
    { x: new Date(last).toISOString().split('T')[0], y: slope * last + intercept },
  ];
}

/** Trailing moving average over the last `days` CALENDAR days (rows must be
 *  date-ascending). A sample-count window isn't a "30-day" MA: these series
 *  have gaps, so the last 30 rows can reach back well past 30 days. */
function computeMA(data, key, days) {
  const nums = data.map(d => dayNum(d.date));
  let start = 0;
  return data.map((d, i) => {
    while (nums[i] - nums[start] >= days) start++;
    // Skip nulls: a null coerces to 0 in the sum but still counts in the
    // denominator, dragging the average toward zero (hrv/vo2 aren't NULL-filtered
    // server-side). A window with no real values yields y:null (a gap, not 0).
    const slice = data.slice(start, i + 1).filter(s => s[key] != null);
    if (!slice.length) return { x: d.date, y: null };
    const avg = slice.reduce((sum, s) => sum + s[key], 0) / slice.length;
    return { x: d.date, y: Math.round(avg * 10) / 10 };
  });
}

/**
 * Create a chart with empty datasets and no animation.
 * Returns { chart, datasets } so data can be applied later in sync.
 */
function createChart(canvasId, type, datasets, options) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) {
    console.warn(`Canvas #${canvasId} not found`);
    return null;
  }
  const emptyDatasets = datasets.map(ds => {
    const copy = {};
    for (const [k, v] of Object.entries(ds)) {
      if (k !== 'data' && typeof v !== 'function') copy[k] = v;
    }
    copy.data = [];
    return copy;
  });
  const chart = new Chart(ctx, {
    type,
    data: { datasets: emptyDatasets },
    options: { ...options, animation: false },
  });
  return { chart, datasets };
}

// ── Cross-chart crosshair plugin ────────────────────────────────────────
// Hover any chart on a page → a faint vertical dashed line appears at the
// same x-date on every other chart on the same page. Helps correlate metrics
// at a glance (e.g. weight spike vs. that week's HRV dip).
//
// Performance: sibling redraws are throttled via requestAnimationFrame so
// rapid mouse motion doesn't redraw 5+ charts at 60Hz.
const Crosshair = {
  id: 'crosshair',
  state: { ts: null, origin: null },
  _raf: null,

  afterEvent(chart, args) {
    const e = args.event;
    const xs = chart.scales?.x;
    if (!xs) return;
    if (e.type === 'mousemove' && e.x >= xs.left && e.x <= xs.right) {
      const ts = xs.getValueForPixel(e.x);
      if (ts !== Crosshair.state.ts) {
        Crosshair.state.ts = ts;
        Crosshair.state.origin = chart;
        Crosshair._scheduleSiblings(chart);
      }
    } else if (e.type === 'mouseout' || e.type === 'mouseleave') {
      if (Crosshair.state.ts !== null) {
        Crosshair.state.ts = null;
        Crosshair.state.origin = null;
        Crosshair._scheduleSiblings(chart);
      }
    }
  },

  _scheduleSiblings(originChart) {
    if (Crosshair._raf) return;
    Crosshair._raf = requestAnimationFrame(() => {
      Crosshair._raf = null;
      // originChart may have been destroyed by a rebuild between the event and
      // this frame — its canvas goes null, so guard before dereferencing.
      const page = originChart.canvas?.closest('.page');
      if (!page) return;
      for (const c of allCharts) {
        if (c === originChart) continue;
        if (c.canvas?.closest('.page') === page) c.draw();
      }
    });
  },

  afterDraw(chart) {
    const ts = Crosshair.state.ts;
    if (ts == null) return;
    const xs = chart.scales?.x;
    if (!xs) return;
    const px = xs.getPixelForValue(ts);
    if (px < xs.left || px > xs.right) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, chart.chartArea.top);
    ctx.lineTo(px, chart.chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};
/** Replace any still-loading chart cards with an error line — used when the
 *  Chart.js CDN fails (or SRI blocks it), the data load fails, or it hangs, so
 *  cards show a message instead of pulsing their skeleton forever. */
function showCardError(msg) {
  document.querySelectorAll('.chart-card.loading').forEach(card => {
    card.classList.remove('loading');
    // Hide the fixed-height box, not just the canvas, so the card shrinks to the message.
    const box = card.querySelector('.chart-box');
    if (box) box.style.display = 'none';
    if (!card.querySelector('.card-error')) {
      const p = document.createElement('p');
      p.className = 'card-error';
      p.textContent = msg;
      card.appendChild(p);
    }
  });
}

async function init() {
  // Activate the target page BEFORE charts are created so their containers have
  // real dimensions — Chart.js with maintainAspectRatio:false can't size inside
  // a display:none parent, and resize() later won't always recover.
  // Resume the last-viewed page when opening the bare URL (Overview by default).
  if (!location.hash) {
    try { const p = localStorage.getItem('lastPage'); if (p) location.hash = p; } catch {}
  }
  wireChartExpand();
  wirePageRouter();

  fetch('/api/version')
    .then(r => r.ok ? r.json() : null)
    .then(v => {
      if (v) document.getElementById('version').textContent = `v${v.date} · ${v.sha}`;
    })
    .catch(() => {});

  // Don't pulse skeletons forever if the data load stalls (e.g. a hung fetch).
  const stuckTimer = setTimeout(
    () => showCardError('Still loading… check your connection and refresh.'), 15000);
  await rebuildCharts(/*initial=*/true);
  clearTimeout(stuckTimer);
  wireRangePresets();
  setupAutoRefresh();
}

let _lastRefresh = Date.now();
let _refreshing = false;
// Canvases that already have a dblclick→resetZoom listener. Canvases persist
// across rebuilds, so without this we'd stack a new listener every refresh —
// and each stale closure would pin a now-destroyed Chart instance (a leak).
const _dblclickBound = new WeakSet();

async function rebuildCharts(initial = false) {
  // Guard against overlapping rebuilds — the 6h interval can coincide with a
  // visibilitychange, and two concurrent runs would each call new Chart() on a
  // canvas the other still holds → "Canvas already in use", corrupting state.
  // Released in populate() below (and on load failure), once the new charts
  // are live and tracked in allCharts.
  if (_refreshing) return;
  _refreshing = true;

  let data;
  try {
    data = await loadAllData();
  } catch (e) {
    console.error('Failed to load data:', e);
    if (initial) showCardError('Failed to load data.');
    _refreshing = false;
    return;
  }
  // Only a clean load counts as a refresh. loadAllData() never rejects on a
  // failed fetch (it substitutes that endpoint's last good response), so with
  // any endpoint down clear the stamp: the next visibilitychange then retries
  // instead of waiting out the 1–6 h refresh timers. (Cleared rather than left
  // alone — a 6h tick can fail minutes after a good refresh stamped it.)
  _lastRefresh = data.failed.length ? 0 : Date.now();
  if (!initial && !data.loaded) {
    // Nothing answered (offline / server down): there is nothing new to draw,
    // so keep the charts exactly as they are, zoom state included.
    _refreshing = false;
    return;
  }

  try {
  // Tear down existing charts only AFTER a successful load, so a failed refresh
  // leaves the current charts on screen instead of blanking them. Preserves DOM
  // state (scroll, active tab, range button, version chip) a full reload would
  // discard. Tradeoff: per-chart zoom/pan state resets.
  for (const c of allCharts) c.destroy();
  allCharts.length = 0;
  const pending = [];

  // Re-anchor the x-axis window to today: a tab that has been open for days
  // would otherwise keep the range it computed at page load.
  currentMin = rangeMin(currentRange);
  currentMax = localISO();
  updateRangeCaption();

  // Event annotations: DEXA scan dates auto-seed body charts; EVENTS array adds user events per scope.
  // (DEXA auto-injection removed — was noise; DEXA points already show as green diamonds on body-fat chart.)
  const bodyEvents = eventsForScope('body');
  const runningEvents = eventsForScope('running');
  const liftsEvents = eventsForScope('lifts');
  const bodyEventAnno = eventAnnotations(bodyEvents);
  const runningEventAnno = eventAnnotations(runningEvents);
  const liftsEventAnno = eventAnnotations(liftsEvents);

  // 1. Weight
  (() => {
    const opts = baseOptions({ showLegend: true, yLabel: 'lbs' });
    opts.plugins.annotation = {
      annotations: GOALS.weightLbs != null
        ? { goal: goalLineAnnotation(GOALS.weightLbs, `goal ${GOALS.weightLbs}`, COLORS.yellow) }
        : {},
    };
    mergeAnnotations(opts, bodyEventAnno);
    pending.push(createChart('weightChart', 'line', [
      {
        label: 'Daily Weight',
        data: data.weight.map(d => ({ x: d.date, y: d.weight })),
        ...lineDefaults(COLORS.blueFaded),
        borderWidth: 1,
      },
      {
        label: '7-day MA',
        data: data.weight.map(d => ({ x: d.date, y: d.ma7 })),
        ...lineDefaults(COLORS.blue),
        pointRadius: 0,
      },
      {
        label: '30-day MA',
        data: data.weight.map(d => ({ x: d.date, y: d.ma30 })),
        ...lineDefaults(COLORS.yellow),
        pointRadius: 0,
      },
    ], opts));
  })();

  // 2. Body Fat
  (() => {
    const opts = baseOptions({ showLegend: true, yLabel: '%' });
    // The goal is a DEXA number (see GOALS) — say so, since the Renpho and Navy
    // lines it crosses are on their own scales.
    opts.plugins.annotation = {
      annotations: GOALS.bodyFatPct != null
        ? { target: goalLineAnnotation(GOALS.bodyFatPct, `goal ${GOALS.bodyFatPct}% (DEXA scale)`, COLORS.yellow) }
        : {},
    };
    mergeAnnotations(opts, bodyEventAnno);
    pending.push(createChart('bodyFatChart', 'line', [
      {
        label: 'Renpho BF%',
        data: data.bodyFat.renpho.map(d => ({ x: d.date, y: d.renpho })),
        ...lineDefaults(COLORS.blue),
      },
      {
        label: 'Navy BF%',
        data: data.bodyFat.navy.map(d => ({ x: d.date, y: d.navy })),
        ...lineDefaults(COLORS.red),
      },
      {
        label: 'DEXA BF%',
        data: data.bodyFat.dexa.map(d => ({ x: d.date, y: d.dexa })),
        ...lineDefaults(COLORS.green),
        showLine: false,
        pointRadius: 6,
        pointHoverRadius: 9,
        pointStyle: 'rectRot',
      },
    ], opts));
  })();

  // 3. Measurements (stomach, waist, chest, hips, neck + waist-to-hip ratio on right axis)
  (() => {
    const opts = baseOptions({ showLegend: true, yLabel: 'inches' });
    opts.interaction = { mode: 'nearest', intersect: false };
    // W:H ratio is unitless (~0.8–0.95) — on a right axis so it doesn't flatten
    // against the inch-scale lines. Dual axis → x-only zoom (y-zoom ambiguous).
    opts.scales.y1 = {
      position: 'right',
      grid: { drawOnChartArea: false },
      ticks: { color: COLORS.cyan },
      title: { display: true, text: 'W:H ratio', color: COLORS.cyan },
    };
    opts.plugins.zoom.zoom.mode = 'x';
    opts.plugins.zoom.pan.mode = 'x';
    mergeAnnotations(opts, bodyEventAnno);
    mergeAnnotations(opts, {
      whrGoal: {
        type: 'line', yMin: 0.9, yMax: 0.9, yScaleID: 'y1',
        borderColor: COLORS.cyan, borderWidth: 1.5, borderDash: [6, 4],
        label: { display: true, content: 'W:H goal 0.90', position: 'start',
                 backgroundColor: 'transparent', color: COLORS.cyan, font: { size: 9 } },
      },
    });
    // WHR numerator = navel-level circumference (the `stomach` field — the
    // standard/WHO "waist" for waist-to-hip ratio), not the iliac-crest `waist`.
    const whr = data.bodyMeasurements
      .filter(d => d.stomach != null && d.hips)
      .map(d => ({ x: d.date, y: Math.round((d.stomach / d.hips) * 1000) / 1000 }));
    pending.push(createChart('measurementsChart', 'line', [
      {
        label: 'Stomach',
        data: data.bodyMeasurements.filter(d => d.stomach != null).map(d => ({ x: d.date, y: d.stomach })),
        ...lineDefaults(COLORS.purple),
      },
      {
        label: 'Waist',
        data: data.bodyMeasurements.filter(d => d.waist != null).map(d => ({ x: d.date, y: d.waist })),
        ...lineDefaults(COLORS.yellow),
      },
      {
        label: 'Chest',
        data: data.bodyMeasurements.filter(d => d.chest != null).map(d => ({ x: d.date, y: d.chest })),
        ...lineDefaults(COLORS.red),
      },
      {
        label: 'Hips',
        data: data.bodyMeasurements.filter(d => d.hips != null).map(d => ({ x: d.date, y: d.hips })),
        ...lineDefaults(COLORS.orange),
      },
      {
        label: 'Neck',
        data: data.bodyMeasurements.filter(d => d.neck != null).map(d => ({ x: d.date, y: d.neck })),
        ...lineDefaults(COLORS.green),
      },
      {
        label: 'W:H ratio',
        data: whr,
        ...lineDefaults(COLORS.cyan),
        yAxisID: 'y1',
        borderDash: [5, 3],
      },
    ], opts));
  })();

  // 3b. Limb Measurements (bicep, forearm, quad, calf)
  (() => {
    const opts = baseOptions({ showLegend: true, yLabel: 'inches' });
    opts.interaction = { mode: 'nearest', intersect: false };
    mergeAnnotations(opts, bodyEventAnno);
    pending.push(createChart('limbChart', 'line', [
      {
        label: 'Bicep',
        data: data.bodyMeasurements.filter(d => d.right_bicep != null).map(d => ({ x: d.date, y: d.right_bicep })),
        ...lineDefaults(COLORS.red),
      },
      {
        label: 'Forearm',
        data: data.bodyMeasurements.filter(d => d.right_forearm != null).map(d => ({ x: d.date, y: d.right_forearm })),
        ...lineDefaults(COLORS.blue),
      },
      {
        label: 'Quad',
        data: data.bodyMeasurements.filter(d => d.right_quad != null).map(d => ({ x: d.date, y: d.right_quad })),
        ...lineDefaults(COLORS.green),
      },
      {
        label: 'Calf',
        data: data.bodyMeasurements.filter(d => d.right_calf != null).map(d => ({ x: d.date, y: d.right_calf })),
        ...lineDefaults(COLORS.purple),
      },
    ], opts));
  })();

  // 4. Resting Heart Rate
  (() => {
    const opts = baseOptions({ showLegend: true, yLabel: 'bpm' });
    if (GOALS.rhrBpm != null) {
      opts.plugins.annotation = {
        annotations: { goal: goalLineAnnotation(GOALS.rhrBpm, `goal ${GOALS.rhrBpm}`, COLORS.yellow) },
      };
    }
    mergeAnnotations(opts, bodyEventAnno);
    pending.push(createChart('rhrChart', 'line', [
      {
        label: 'RHR',
        data: data.rhr.map(d => ({ x: d.date, y: d.rhr })),
        ...lineDefaults(COLORS.red),
      },
      {
        label: '30-day MA',
        data: computeMA(data.rhr, 'rhr', 30),
        ...lineDefaults(COLORS.yellow),
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.3,
      },
    ], opts));
  })();

  // 5. HRV
  (() => {
    const opts = baseOptions({ showLegend: true, yLabel: 'ms' });
    // Last 90 calendar days, not the last 90 readings (HRV has missing nights).
    const recentHRV = (data.hrv || []).filter(d => d.hrv != null && daysAgo(d.date) < 90).map(d => d.hrv);
    const hrvBaseline = recentHRV.length
      ? Math.round(recentHRV.reduce((a, b) => a + b, 0) / recentHRV.length)
      : null;
    opts.plugins.annotation = opts.plugins.annotation || { annotations: {} };
    if (hrvBaseline != null) {
      opts.plugins.annotation.annotations.baseline =
        goalLineAnnotation(hrvBaseline, `90d avg ${hrvBaseline}`, COLORS.cyan);
    }
    if (GOALS.hrvMs != null) {
      opts.plugins.annotation.annotations.goal =
        goalLineAnnotation(GOALS.hrvMs, `goal ${GOALS.hrvMs}`, COLORS.yellow);
    }
    mergeAnnotations(opts, bodyEventAnno);
    pending.push(createChart('hrvChart', 'line', [
      {
        label: 'HRV',
        data: data.hrv.map(d => ({ x: d.date, y: d.hrv })),
        ...lineDefaults(COLORS.green),
      },
      {
        label: '30-day MA',
        data: computeMA(data.hrv, 'hrv', 30),
        ...lineDefaults(COLORS.yellow),
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.3,
      },
    ], opts));
  })();

  // 6. Efficiency Factor + trendline
  const efPoints = data.runs.all.map(d => ({ x: d.date, y: d.ef }));
  (() => {
    const opts = baseOptions({ showLegend: true });
    mergeAnnotations(opts, runningEventAnno);
    pending.push(createChart('efChart', 'line', [
      { label: 'EF', data: efPoints, ...lineDefaults(COLORS.blue) },
      { ...trendline('ef', efPoints, COLORS.yellow), label: 'Trend' },
    ], opts));
  })();

  // 7. 5K Heart Rate (primary y, red) + Pace (secondary y, green) — color-coded axes
  (() => {
    const opts = baseOptions({ showLegend: true });
    opts.scales = {
      x: xScale('month'),
      y: {
        position: 'left',
        grid: { color: GRID_COLOR },
        ticks: { color: COLORS.red },
        title: { display: true, text: 'bpm', color: COLORS.red },
      },
      y1: {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: COLORS.green },
        title: { display: true, text: 'min/mi', color: COLORS.green },
      },
    };
    opts.plugins.tooltip.callbacks = {
      label: (ctx) => ctx.dataset.label === 'Pace (min/mi)'
        ? `Pace: ${fmtPace(ctx.parsed.y)}`
        : `${ctx.dataset.label}: ${ctx.parsed.y}`,
    };
    // Dual y-axes — y-zoom is ambiguous, restrict to x.
    opts.plugins.zoom.zoom.mode = 'x';
    opts.plugins.zoom.pan.mode = 'x';
    mergeAnnotations(opts, runningEventAnno);
    pending.push(createChart('fiveKChart', 'line', [
      {
        label: 'Avg HR',
        data: data.runs.fiveK.map(d => ({ x: d.date, y: d.avgHR })),
        ...lineDefaults(COLORS.red),
        yAxisID: 'y',
      },
      {
        label: 'Pace (min/mi)',
        data: data.runs.fiveK.map(d => ({ x: d.date, y: d.paceMinMi })),
        ...lineDefaults(COLORS.green),
        yAxisID: 'y1',
      },
    ], opts));
  })();

  // 8. Long Run Distance
  (() => {
    const opts = baseOptions({ yLabel: 'miles' });
    mergeAnnotations(opts, runningEventAnno);
    pending.push(createChart('longRunChart', 'line', [
      {
        label: 'Distance',
        data: data.runs.longRuns.map(d => ({ x: d.date, y: d.distMi })),
        ...lineDefaults(COLORS.purple),
      },
    ], opts));
  })();

  // 9. Weekly Mileage (bar + trendline)
  const mileagePoints = data.runs.weeklyMileage.map(d => ({ x: d.week, y: d.miles }));
  // Fit the trend to completed weeks only: the in-progress week is a partial
  // total and would drag the line down until Friday.
  const mileageTrendPoints = mileagePoints.filter(p => !isCurrentWeek(p.x));
  (() => {
    const opts = baseOptions({ showLegend: true, timeUnit: 'week', yLabel: 'miles' });
    mergeAnnotations(opts, runningEventAnno);
    pending.push(createChart('weeklyMileageChart', 'bar', [
      {
        label: 'Miles',
        data: mileagePoints,
        backgroundColor: COLORS.blueBar,
        borderColor: COLORS.blue,
        borderWidth: 1,
        borderRadius: 3,
      },
      { ...trendline('mileage', mileageTrendPoints, COLORS.green), label: 'Trend', type: 'line' },
    ], opts));
  })();

  // 10. VO2 Max
  const vo2Points = data.vo2max.map(d => ({ x: d.date, y: d.vo2max }));
  (() => {
    const opts = baseOptions({ showLegend: true });
    if (GOALS.vo2max != null) {
      opts.plugins.annotation = {
        annotations: { goal: goalLineAnnotation(GOALS.vo2max, `goal ${GOALS.vo2max}`, COLORS.yellow) },
      };
    }
    pending.push(createChart('vo2maxChart', 'line', [
      { label: 'VO2 Max', data: vo2Points, ...lineDefaults(COLORS.green) },
      { ...trendline('vo2', vo2Points, COLORS.yellow), label: 'Trend' },
    ], opts));
  })();

  // 10c. Weekly HR Zone Minutes (stacked bar — Z1 at bottom → Z5 on top)
  const ZONE_COLORS = ['#74c0fc', '#51cf66', '#ffd43b', '#ff922b', '#ff6b6b'];
  const zoneDatasets = ['z1', 'z2', 'z3', 'z4', 'z5'].map((k, i) => ({
    label: `Z${i + 1}`,
    data: data.zoneMinutes.map(d => ({ x: d.week, y: d[k] })),
    backgroundColor: ZONE_COLORS[i],
    borderColor: ZONE_COLORS[i],
    borderWidth: 0,
    stack: 'zones',
  }));
  pending.push(createChart('zoneMinutesChart', 'bar', zoneDatasets, (() => {
    const opts = baseOptions({ showLegend: true, timeUnit: 'week', yLabel: 'minutes' });
    opts.scales.x.stacked = true;
    opts.scales.y.stacked = true;
    return opts;
  })()));

  // 10b. HR Recovery (60s drop after hard intervals — higher = better fitness)
  const hrRecoveryPoints = data.hrRecovery.map(d => ({ x: d.date, y: d.recovery }));
  (() => {
    const opts = baseOptions({ showLegend: true, yLabel: 'bpm' });
    if (GOALS.hrRecovery60Bpm != null) {
      opts.plugins.annotation = {
        annotations: { goal: goalLineAnnotation(GOALS.hrRecovery60Bpm, `goal ${GOALS.hrRecovery60Bpm}`, COLORS.yellow) },
      };
    }
    pending.push(createChart('hrRecoveryChart', 'line', [
      { label: '60s drop', data: hrRecoveryPoints, ...lineDefaults(COLORS.red) },
      { ...trendline('hrRecovery', hrRecoveryPoints, COLORS.yellow), label: 'Trend' },
    ], opts));
  })();

  // 10d. Training Log — every run as a bubble (x=date, y=pace, size=distance, color=HR zone)
  (() => {
    const opts = baseOptions({ showLegend: false, yLabel: 'min/mi' });
    opts.interaction = { mode: 'nearest', intersect: true };
    opts.plugins.tooltip.callbacks = {
      label: (ctx) => {
        const p = ctx.raw;
        return `${p.x}: ${p.dist.toFixed(1)} mi · ${fmtPace(p.y)} · ${p.hr} bpm`;
      },
    };
    mergeAnnotations(opts, runningEventAnno);
    const HRMAX_BPM = 200;  // matches serve.py HR-zone bins
    const ZONE_C = ['#74c0fc', '#51cf66', '#ffd43b', '#ff922b', '#ff6b6b']; // Z1→Z5
    const zoneIdx = (hr) => {
      const pct = (hr || 0) / HRMAX_BPM;
      return pct < 0.6 ? 0 : pct < 0.7 ? 1 : pct < 0.8 ? 2 : pct < 0.9 ? 3 : 4;
    };
    const runs = data.runs.all.filter(r => r.distMi > 0 && r.paceMinMi > 0);
    const points = runs.map(r => ({
      x: r.date, y: r.paceMinMi, dist: r.distMi, hr: r.avgHR,
      r: Math.max(3, Math.min(20, 3 + Math.sqrt(r.distMi) * 3)),  // area ∝ distance
    }));
    pending.push(createChart('trainingLogChart', 'bubble', [
      {
        label: 'Runs',
        data: points,
        backgroundColor: runs.map(r => ZONE_C[zoneIdx(r.avgHR)]),
        borderColor: 'rgba(255,255,255,0.18)',
        borderWidth: 1,
      },
    ], opts));
  })();

  // 10e. Lactate Threshold — Garmin's detected LT heart rate (bpm, left axis) +
  //      LT pace (min/mi, right axis). Steps up over time as fitness improves.
  (() => {
    const lt = data.lactateThreshold || [];
    const opts = baseOptions({ showLegend: true });
    opts.scales = {
      x: xScale('month'),
      y: {
        position: 'left',
        grid: { color: GRID_COLOR },
        ticks: { color: COLORS.red },
        title: { display: true, text: 'bpm', color: COLORS.red },
      },
      y1: {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: COLORS.green },
        title: { display: true, text: 'min/mi', color: COLORS.green },
      },
    };
    opts.plugins.tooltip.callbacks = {
      label: (ctx) => ctx.dataset.label === 'LT Pace'
        ? `LT Pace: ${fmtPace(ctx.parsed.y)}`
        : `${ctx.dataset.label}: ${ctx.parsed.y}`,
    };
    // Dual y-axes — y-zoom is ambiguous, restrict to x.
    opts.plugins.zoom.zoom.mode = 'x';
    opts.plugins.zoom.pan.mode = 'x';
    pending.push(createChart('ltChart', 'line', [
      {
        label: 'LT Heart Rate',
        data: lt.map(d => ({ x: d.date, y: d.lthr })),
        ...lineDefaults(COLORS.red),
        yAxisID: 'y',
      },
      {
        label: 'LT Pace',
        data: lt.map(d => ({ x: d.date, y: d.pace })),
        ...lineDefaults(COLORS.green),
        yAxisID: 'y1',
      },
    ], opts));
  })();

  // 11. Weekly Training Volume
  (() => {
    const opts = baseOptions({ timeUnit: 'week', yLabel: 'sets' });
    mergeAnnotations(opts, liftsEventAnno);
    pending.push(createChart('volumeChart', 'bar', [
      {
        label: 'Sets',
        data: data.workoutVolume.map(d => ({ x: d.week, y: d.total_sets })),
        backgroundColor: COLORS.blueBar,
        borderColor: COLORS.blue,
        borderWidth: 1,
        borderRadius: 3,
      },
    ], opts));
  })();

  // 12-17. Combined exercise progression charts (roster: LIFT_CHARTS)
  const REPS_ONLY = ['pull ups', 'push ups', 'dips', 'v ups', 'calf raise bw', 'neck extension', 'neck flexion', 'front lever'];
  function exerciseY(exercise, { weight, reps, maxReps }) {
    if (REPS_ONLY.includes(exercise)) return maxReps ?? reps;
    // Dead hang logs seconds as reps. Gripper's "weight" is its level (1–2.5),
    // not lbs, so chart the reps closed at the top level.
    if (exercise === 'dead hang' || exercise === 'gripper') return reps;
    return weight;
  }
  function liftData(exercise, filterDate) {
    const points = data.liftProgression[exercise] || [];
    return points
      .filter(p => !filterDate || p.date >= filterDate)
      .map(p => ({ x: p.date, y: exerciseY(exercise, p), reps: p.reps, weight: p.weight }))
      .filter(p => p.y != null && p.y > 0);
  }
  /**
   * Build a Chart.js annotation pair (star + label) at the best point in a
   * lift series. Returns a flat object with two entries keyed by the
   * slugified exercise name, suitable for Object.assign-ing into a chart's
   * annotations dict.
   *
   * For weight lifts pass EVERY set (setsScatter(…).data), not the weekly line:
   * the line only carries each week's heaviest set, and the best e1RM can be a
   * lighter set that week (RDL DB 315×12 → 441 sat under a 365×5 → 426 top set).
   *
   * IMPORTANT: chartjs-plugin-annotation@3 does NOT honor a `label` sub-option
   * on `type: 'point'` — labels must be their own `type: 'label'` annotation.
   * That bug silently swallowed the "PR" text before this rewrite.
   *
   * `rankBy` picks which field decides "best": 'weight' (default) or 'y'.
   */
  function prAnnotation(dataPoints, label = 'PR', rankBy = 'weight') {
    // Rank the "best" set by estimated 1-rep max (Epley: weight·(1+reps/30)) so
    // reps count — 100×10 (e1RM 133) beats 100×9 (130), while a near-max single
    // still wins (200×1 → 207). Epley is only meaningful for low reps and the
    // source log has occasional rep typos (a stray 205×250), so the weight ranking
    // only considers plausible single sets (reps ≤ 20) — heavy singles are always
    // kept. Rep-only/bodyweight lifts rank by reps directly (rankBy='y').
    const REP_CAP = 20;
    const score = rankBy === 'weight'
      ? (p) => p.weight * (1 + (p.reps || 1) / 30)
      : (p) => p.y;
    const arr = (dataPoints || []).filter(p => p && p.y != null && (rankBy === 'weight'
      ? p.weight != null && (p.reps == null || p.reps <= REP_CAP)
      : p[rankBy] != null));
    if (arr.length === 0) return {};
    const top = arr.reduce((m, p) => score(p) > score(m) ? p : m);
    const id = label.replace(/\W+/g, '') || 'pr';
    const valueText = rankBy === 'weight' && top.weight != null
      ? `${label} ${Math.round(top.weight)}${top.reps ? '×' + top.reps : ''}`
      : label;
    // A PR in the first or the latest week puts the star on a plot edge, where a
    // centred label is clipped to "/ 225×14". Anchor the label inward (and drop
    // it below a star at the very top). Scriptable, so it follows zoom/pan.
    const EDGE_PX = 60;
    const starX = (chart) => chart.scales.x.getPixelForValue(chart.scales.x.parse(top.x));
    const labelAnchor = ({ chart }) => {
      if (!chart.scales?.x || !chart.chartArea) return 'center';
      const px = starX(chart);
      const { left, right } = chart.chartArea;
      return { x: px > right - EDGE_PX ? 'end' : px < left + EDGE_PX ? 'start' : 'center', y: 'center' };
    };
    // No label for a star that's outside the visible range (a stub of it used to poke in).
    const labelVisible = ({ chart }) => {
      if (!chart.scales?.x || !chart.chartArea) return true;
      const px = starX(chart);
      return px >= chart.chartArea.left && px <= chart.chartArea.right;
    };
    const labelLift = ({ chart }) => {
      const ys = chart.scales?.y;
      if (!ys || !chart.chartArea) return -18;
      return ys.getPixelForValue(top.y) < chart.chartArea.top + 30 ? 18 : -18;
    };
    return {
      [`${id}_pt`]: {
        type: 'point',
        xValue: top.x,
        yValue: top.y,
        radius: 8,
        backgroundColor: COLORS.yellow,
        borderColor: '#0f1117',
        borderWidth: 2,
        pointStyle: 'star',
      },
      [`${id}_lbl`]: {
        type: 'label',
        xValue: top.x,
        yValue: top.y,
        content: valueText,
        color: COLORS.yellow,
        backgroundColor: 'rgba(15,17,23,0.78)',
        borderColor: COLORS.yellow,
        borderWidth: 1,
        borderRadius: 4,
        padding: 4,
        font: { size: 10, weight: 'bold' },
        display: labelVisible,
        position: labelAnchor,
        yAdjust: labelLift,
      },
    };
  }
  /** Merge several annotation maps. Empty/undefined entries are skipped. */
  function compactAnnotations(map) {
    const out = {};
    for (const v of Object.values(map)) {
      if (v && typeof v === 'object') Object.assign(out, v);
    }
    return Object.keys(out).length ? out : undefined;
  }
  /** Scatter of every individual set, overlaid at the chart's same y mapping. */
  function setsScatter(exercise, color, filterDate) {
    const sets = data.workoutSets[exercise] || [];
    const points = sets
      .filter(s => !filterDate || s.week >= filterDate)
      .map(s => ({ x: s.week, y: exerciseY(exercise, { weight: s.weight, reps: s.reps, maxReps: s.reps }), reps: s.reps, weight: s.weight }))
      .filter(p => p.y != null && p.y > 0);
    return {
      label: `_${exercise}Sets`,
      data: points,
      type: 'scatter',
      backgroundColor: color,
      borderColor: 'transparent',
      pointRadius: repsPointRadius,
      pointHoverRadius: 0,
      showLine: false,
    };
  }
  const legendFilterTrend = (item) => !item.text.startsWith('_');

  /** Point radius scaled by reps — bigger dot = more reps */
  function repsPointRadius(ctx) {
    const reps = ctx.raw && ctx.raw.reps;
    if (!reps || typeof reps !== 'number') return 2;
    return Math.max(2, Math.min(8, reps / 3));
  }
  /**
   * Build a point-radius callback scaled by `weight` within [minW, maxW].
   * Returns a closure: ctx -> px. Lightest weight -> 2px, heaviest -> 12px.
   * `boost` is added on top (e.g. +3 for hover state).
   */
  function weightPointRadius(minW, maxW, boost = 0) {
    const span = Math.max(1, maxW - minW);
    return (ctx) => {
      const w = ctx.raw && ctx.raw.weight;
      if (typeof w !== 'number') return 2 + boost;
      const r = 2 + ((w - minW) / span) * 10;
      return Math.max(2, Math.min(12, r)) + boost;
    };
  }
  function liftDefaults(color) {
    return {
      ...lineDefaults(color),
      pointRadius: repsPointRadius,
      pointHoverRadius: 8,
    };
  }
  function liftOpts(yLabel, annotations) {
    const opts = baseOptions({ showLegend: true, timeUnit: 'month', yLabel });
    opts.interaction = { mode: 'nearest', intersect: false };
    opts.plugins.legend.labels.filter = legendFilterTrend;
    opts.plugins.tooltip.filter = (item) => !item.dataset.label?.startsWith('_');
    opts.plugins.tooltip.callbacks = {
      afterLabel: (ctx) => {
        const reps = ctx.raw?.reps;
        return reps ? `Reps: ${reps}` : '';
      },
    };
    if (annotations) opts.plugins.annotation = { annotations };
    mergeAnnotations(opts, liftsEventAnno);
    return opts;
  }

  const FADED = {
    red: 'rgba(255,107,107,0.3)',
    blue: 'rgba(74,158,255,0.3)',
    green: 'rgba(81,207,102,0.3)',
    yellow: 'rgba(255,212,59,0.3)',
    purple: 'rgba(204,93,232,0.3)',
    orange: 'rgba(255,146,43,0.3)',
    cyan: 'rgba(34,211,238,0.3)',
    pink: 'rgba(255,107,203,0.3)',
  };

  // 12–15. Weight-progression charts, one per LIFT_CHARTS entry (Upper Body
  // Machines, Upper Body DB, Lower Body — Legs, — Hip/Core, BB/DB): every set
  // as a faint scatter underneath, then each lift's weekly top-weight line +
  // trendline, and a PR star.
  for (const [canvasId, roster] of Object.entries(LIFT_CHARTS)) {
    const series = roster.map(([exercise, label, prLabel, color, since]) => {
      const points = liftData(exercise, since);
      const scatter = setsScatter(exercise, FADED[color], since);
      return {
        scatter,
        line: { label, data: points, ...liftDefaults(COLORS[color]) },
        trend: trendline(exercise, points, FADED[color]),
        // Rank the PR over every set; the weekly top sets are only a fallback
        // for when /api/workout-sets came back empty.
        pr: prAnnotation(scatter.data.length ? scatter.data : points, prLabel),
      };
    });
    pending.push(createChart(canvasId, 'line', [
      ...series.map(s => s.scatter),
      ...series.flatMap(s => [s.line, s.trend]),
    ], liftOpts('lbs', compactAnnotations(series.map(s => s.pr)))));
  }

  // 16. Bodyweight (Pull-ups, V-ups, Push-ups, Calf Raise, Gripper, Front Lever + Dead Hang seconds on right axis)
  const pullData = liftData('pull ups');
  // Bodyweight 'dips' is always logged weighted (0 rows under 'dips' — they live
  // on the Upper Body Machines chart); v-ups (36 sessions) previously had no chart.
  const vupData = liftData('v ups');
  const pushData = liftData('push ups');
  const calfBWData = liftData('calf raise bw');
  const hangData = liftData('dead hang');
  // Not bodyweight moves, but both are rep-counted and belong on a reps axis
  // rather than a lbs one (gripper "weight" is its level; see exerciseY).
  const gripData = liftData('gripper');
  const leverData = liftData('front lever');
  pending.push(createChart('bodyweightChart', 'line', [
    { ...setsScatter('pull ups', FADED.green), yAxisID: 'y' },
    { ...setsScatter('v ups', FADED.yellow), yAxisID: 'y' },
    { ...setsScatter('push ups', FADED.red), yAxisID: 'y' },
    { ...setsScatter('calf raise bw', FADED.purple), yAxisID: 'y' },
    { ...setsScatter('gripper', FADED.orange), yAxisID: 'y' },
    { ...setsScatter('front lever', FADED.cyan), yAxisID: 'y' },
    { ...setsScatter('dead hang', FADED.blue), yAxisID: 'y1' },
    { label: 'Pull-ups', data: pullData, ...lineDefaults(COLORS.green), yAxisID: 'y' },
    { ...trendline('pull', pullData, FADED.green), yAxisID: 'y' },
    { label: 'V-ups', data: vupData, ...lineDefaults(COLORS.yellow), yAxisID: 'y' },
    { ...trendline('vup', vupData, FADED.yellow), yAxisID: 'y' },
    { label: 'Push-ups', data: pushData, ...lineDefaults(COLORS.red), yAxisID: 'y' },
    { ...trendline('push', pushData, FADED.red), yAxisID: 'y' },
    { label: 'Calf Raise', data: calfBWData, ...lineDefaults(COLORS.purple), yAxisID: 'y' },
    { ...trendline('calfBW', calfBWData, FADED.purple), yAxisID: 'y' },
    // No gripper trendline: reps reset every time the gripper level goes up,
    // so a fitted line would read progress as decline.
    { label: 'Gripper', data: gripData, ...lineDefaults(COLORS.orange), yAxisID: 'y' },
    { label: 'Front Lever', data: leverData, ...lineDefaults(COLORS.cyan), yAxisID: 'y' },
    { ...trendline('lever', leverData, FADED.cyan), yAxisID: 'y' },
    { label: 'Dead Hang (s)', data: hangData, ...lineDefaults(COLORS.blue), yAxisID: 'y1' },
    { ...trendline('hang', hangData, FADED.blue), yAxisID: 'y1' },
  ], (() => {
    const opts = baseOptions({ showLegend: true, timeUnit: 'month' });
    opts.interaction = { mode: 'nearest', intersect: false };
    opts.plugins.legend.labels.filter = legendFilterTrend;
    opts.plugins.tooltip.callbacks = {
      // Gripper reps only mean something next to the level they were closed at.
      afterLabel: (ctx) => ctx.dataset.label === 'Gripper' && ctx.raw?.weight ? `Level: ${ctx.raw.weight}` : '',
    };
    // Dual y-axes — y-zoom is ambiguous, restrict to x.
    opts.plugins.zoom.zoom.mode = 'x';
    opts.plugins.zoom.pan.mode = 'x';
    opts.scales = {
      x: xScale('month'),
      y: { position: 'left', grid: { color: GRID_COLOR }, ticks: { color: TICK_COLOR }, title: { display: true, text: 'reps', color: TICK_COLOR } },
      // Dead-hang seconds is the only y1 series — color it blue to match the line.
      y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: COLORS.blue }, title: { display: true, text: 'seconds', color: COLORS.blue } },
    };
    return opts;
  })()));

  // 17. Neck (Extension + Flexion) — dot size scales with weight (heavier = bigger)
  const neckExtData = liftData('neck extension');
  const neckFlexData = liftData('neck flexion');
  const neckExtSets = setsScatter('neck extension', FADED.red);
  const neckFlexSets = setsScatter('neck flexion', FADED.blue);
  // Shared weight scale across both exercises so dot sizes are comparable
  const neckWeights = [
    ...neckExtData.map(p => p.weight),
    ...neckFlexData.map(p => p.weight),
    ...neckExtSets.data.map(p => p.weight),
    ...neckFlexSets.data.map(p => p.weight),
  ].filter(w => typeof w === 'number');
  const neckMinW = neckWeights.length ? Math.min(...neckWeights) : 0;
  const neckMaxW = neckWeights.length ? Math.max(...neckWeights) : 1;
  const neckRadius = weightPointRadius(neckMinW, neckMaxW);
  const neckHoverRadius = weightPointRadius(neckMinW, neckMaxW, 3);
  const neckLineDefaults = (color) => ({
    ...lineDefaults(color),
    pointRadius: neckRadius,
    pointHoverRadius: neckHoverRadius,
  });
  // Neck chart uses reps (y) for the y-axis, so rank PRs by reps not weight.
  const neckAnno = compactAnnotations({
    neckExtPR: prAnnotation(neckExtData, 'Ext PR', 'y'),
    neckFlexPR: prAnnotation(neckFlexData, 'Flex PR', 'y'),
  });
  const neckOpts = liftOpts('reps', neckAnno);
  neckOpts.plugins.tooltip.callbacks = {
    afterLabel: (ctx) => {
      const w = ctx.raw?.weight;
      const reps = ctx.raw?.reps;
      const lines = [];
      if (w != null) lines.push(`Weight: ${w} lbs`);
      if (reps != null) lines.push(`Reps: ${reps}`);
      return lines;
    },
  };
  pending.push(createChart('neckChart', 'line', [
    { ...neckExtSets, pointRadius: neckRadius, pointHoverRadius: neckHoverRadius },
    { ...neckFlexSets, pointRadius: neckRadius, pointHoverRadius: neckHoverRadius },
    { label: 'Neck Extension', data: neckExtData, ...neckLineDefaults(COLORS.red) },
    trendline('neckExt', neckExtData, FADED.red),
    { label: 'Neck Flexion', data: neckFlexData, ...neckLineDefaults(COLORS.blue) },
    trendline('neckFlex', neckFlexData, FADED.blue),
  ], neckOpts));

  // 18. Sleep — stage hours stacked (deep + REM + light ≈ total sleep)
  (() => {
    const opts = baseOptions({ showLegend: true, timeUnit: 'week', yLabel: 'hours' });
    opts.scales.x.stacked = true;
    opts.scales.y.stacked = true;
    mergeAnnotations(opts, { goal: goalLineAnnotation(7, 'goal 7h', COLORS.cyan) });
    const stage = (key, color, label) => ({
      label,
      data: data.sleep.map(d => ({ x: d.date, y: d[key] })),
      backgroundColor: color, borderColor: color, borderWidth: 0, stack: 'sleep',
    });
    pending.push(createChart('sleepChart', 'bar', [
      stage('deepH', COLORS.blue, 'Deep'),
      stage('remH', COLORS.purple, 'REM'),
      stage('lightH', COLORS.cyan, 'Light'),
    ], opts));
  })();

  // 19. Sleep Score (0–100) + 30-day MA
  (() => {
    const opts = baseOptions({ showLegend: true, timeUnit: 'month', yLabel: 'score' });
    opts.scales.y.min = 0;
    opts.scales.y.max = 100;
    const scored = data.sleep.filter(d => d.score != null);
    pending.push(createChart('sleepScoreChart', 'line', [
      { label: 'Sleep Score', data: scored.map(d => ({ x: d.date, y: d.score })), ...lineDefaults(COLORS.purple) },
      { label: '30-day MA', data: computeMA(scored, 'score', 30), ...lineDefaults(COLORS.yellow), pointRadius: 0 },
    ], opts));
  })();

  // 20. Daily Steps (bar) + adaptive goal (line)
  (() => {
    const opts = baseOptions({ showLegend: true, timeUnit: 'week', yLabel: 'steps' });
    pending.push(createChart('stepsChart', 'bar', [
      {
        label: 'Steps',
        data: data.steps.map(d => ({ x: d.date, y: d.steps })),
        backgroundColor: COLORS.blueBar, borderColor: COLORS.blue, borderWidth: 1, borderRadius: 3,
      },
      {
        label: 'Goal', type: 'line',
        data: data.steps.map(d => ({ x: d.date, y: d.step_goal })),
        ...lineDefaults(COLORS.yellow), pointRadius: 0, borderDash: [6, 3],
      },
    ], opts));
  })();

  // 21. Stress (daily avg) + 30-day MA
  (() => {
    const opts = baseOptions({ showLegend: true, yLabel: 'stress' });
    opts.scales.y.min = 0;
    opts.scales.y.max = 100;
    pending.push(createChart('stressChart', 'line', [
      { label: 'Stress', data: data.stress.map(d => ({ x: d.date, y: d.stress })), ...lineDefaults(COLORS.orange) },
      { label: '30-day MA', data: computeMA(data.stress, 'stress', 30), ...lineDefaults(COLORS.yellow), pointRadius: 0 },
    ], opts));
  })();

  // 22. Body Battery — daily low→high range as a floating bar
  (() => {
    const opts = baseOptions({ showLegend: false, timeUnit: 'week', yLabel: 'energy' });
    opts.scales.y.min = 0;
    opts.scales.y.max = 100;
    opts.plugins.tooltip.callbacks = {
      label: (ctx) => `${ctx.raw.y[0]}–${ctx.raw.y[1]} (low–high)`,
    };
    pending.push(createChart('bodyBatteryChart', 'bar', [
      {
        label: 'Body Battery',
        data: data.bodyBattery.map(d => ({ x: d.date, y: [d.low, d.high] })),
        backgroundColor: FADED.green, borderColor: COLORS.green, borderWidth: 1, borderRadius: 2,
      },
    ], opts));
  })();

  // Populate all charts simultaneously so animations start in sync
  const populate = () => {
    try {
      for (const entry of pending) {
        if (!entry) continue;
        entry.chart.data.datasets = entry.datasets;
        entry.chart.options.animation = initial ? ANIMATION : false;
        entry.chart.update();
        entry.chart.canvas.closest('.chart-card')?.classList.remove('loading');
        allCharts.push(entry.chart);
        // Double-click resets zoom. Bind once per canvas (canvases outlive the
        // charts across rebuilds) and look up the live chart at click time, so
        // we neither stack listeners nor capture a destroyed instance.
        const canvas = entry.chart.canvas;
        if (!_dblclickBound.has(canvas)) {
          _dblclickBound.add(canvas);
          canvas.addEventListener('dblclick', () => Chart.getChart(canvas)?.resetZoom());
        }
      }
      applyChartMetadata(data);
      renderOverview(data);
    } finally {
      _refreshing = false;
    }
  };
  // The first paint waits one frame so the empty chart frames are on screen
  // before the data animates in. Refreshes don't animate, so they populate
  // right here: rAF never fires in a hidden tab, and a refresh that began in
  // one used to sit on 28 destroyed-and-empty charts with _refreshing held —
  // every later refresh then no-op'd. (Same reason a hidden first load
  // populates immediately.)
  if (initial && !document.hidden) requestAnimationFrame(populate);
  else populate();
  } catch (e) {
    // A synchronous throw during the ~750 lines of chart construction would
    // otherwise leave _refreshing stuck true (the release lives in populate
    // above), permanently blanking the page and no-op'ing every later refresh.
    console.error('Chart build failed:', e);
    _refreshing = false;
    if (initial) showCardError('Failed to render charts.');
  }
}

/** Most recent row with a real value for `key`. A sync gap can leave a trailing
 *  row whose value is null — reading `.at(-1)` then rendered "HRV null ms". */
function latestRow(rows, key) {
  return rows?.findLast(r => r?.[key] != null);
}

/** "X to goal" given direction. lowerIsBetter: goal sits below current (weight,
 *  BF, RHR); otherwise above (HRV, VO2, HR-recovery). */
function goalGap(latest, goal, { unit = '', decimals = 1, lowerIsBetter = false } = {}) {
  if (goal == null || latest == null) return '';
  const gap = lowerIsBetter ? latest - goal : goal - latest;
  if (gap <= 0) return '✓ at goal';
  return `${gap.toFixed(decimals)}${unit ? ' ' + unit : ''} to goal`;
}

/** Body-fat goal gap, measured from the latest DEXA scan and labelled with its
 *  date: "DEXA 15.8% (May 13) · 3.8 % to goal". The goal is on the DEXA scale
 *  (see GOALS), so the Renpho reading can't be compared with it — with no scan
 *  there is no gap to show. */
function dexaGoalNote(data) {
  const dx = latestRow(data.bodyFat?.dexa, 'dexa');
  if (!dx) return '';
  const gap = goalGap(dx.dexa, GOALS.bodyFatPct, { unit: '%', lowerIsBetter: true });
  return `DEXA ${dx.dexa}% (${fmtDay(dx.date)})${gap ? ' · ' + gap : ''}`;
}

/** Inject latest-value + last-updated chip into chart card headers. Every chart
 *  gets one, so a series that has stopped updating is flagged on its own card. */
function applyChartMetadata(data) {
  const arrow = (delta) => delta > 0 ? '▲' : delta < 0 ? '▼' : '→';
  const signed = (v, d = 1) => `${arrow(v)}${Math.abs(v).toFixed(d)}`;
  const weekly = { weekly: true };

  const w = latestRow(data.weight, 'weight');
  if (w) {
    const vs30 = w.ma30 != null ? ` · ${signed(w.weight - w.ma30)} vs 30d` : '';
    setChartMeta('weightChart', `${w.weight.toFixed(1)} lb${vs30}`, w.date,
      goalGap(w.weight, GOALS.weightLbs, { unit: 'lb', lowerIsBetter: true }));
  }

  const bf = latestRow(data.bodyFat?.renpho, 'renpho');
  if (bf) setChartMeta('bodyFatChart', `Renpho ${bf.renpho}%`, bf.date, dexaGoalNote(data));

  // Tape measurements: chip on the latest row that has any of the chart's series.
  const lastWithAny = (keys) => data.bodyMeasurements?.findLast(m => keys.some(k => m[k] != null));
  const torso = lastWithAny(['stomach', 'waist', 'chest', 'hips', 'neck']);
  if (torso) setChartMeta('measurementsChart', torso.stomach != null ? `${torso.stomach} in stomach` : '', torso.date);
  const limb = lastWithAny(['right_bicep', 'right_forearm', 'right_quad', 'right_calf']);
  if (limb) setChartMeta('limbChart', limb.right_bicep != null ? `${limb.right_bicep} in bicep` : '', limb.date);

  const rhr = latestRow(data.rhr, 'rhr');
  if (rhr) setChartMeta('rhrChart', `${rhr.rhr} bpm`, rhr.date,
    goalGap(rhr.rhr, GOALS.rhrBpm, { unit: 'bpm', decimals: 0, lowerIsBetter: true }));

  const hrv = latestRow(data.hrv, 'hrv');
  if (hrv) setChartMeta('hrvChart', `${hrv.hrv} ms`, hrv.date,
    goalGap(hrv.hrv, GOALS.hrvMs, { unit: 'ms', decimals: 0 }));

  const vo2 = latestRow(data.vo2max, 'vo2max');
  if (vo2) setChartMeta('vo2maxChart', `${vo2.vo2max}`, vo2.date,
    goalGap(vo2.vo2max, GOALS.vo2max, { decimals: 1 }));

  const lastRun = data.runs?.all?.at(-1);
  if (lastRun) {
    setChartMeta('efChart', `${lastRun.distMi.toFixed(1)}mi · ${lastRun.avgHR}bpm`, lastRun.date);
    setChartMeta('trainingLogChart', `${lastRun.distMi.toFixed(1)} mi · ${fmtPace(lastRun.paceMinMi)}`, lastRun.date);
  }

  const fiveKLast = data.runs?.fiveK?.at(-1);
  if (fiveKLast) setChartMeta('fiveKChart', `${fiveKLast.avgHR} bpm · ${fmtPace(fiveKLast.paceMinMi)}`, fiveKLast.date);

  const longLast = data.runs?.longRuns?.at(-1);
  if (longLast) setChartMeta('longRunChart', `${longLast.distMi.toFixed(1)} mi`, longLast.date);

  // Week-keyed rows: the chip reads "this wk" only when the latest row IS this
  // week; an older row is named by the week it actually covers.
  const weekTag = (week) => isCurrentWeek(week) ? '' : ` · wk of ${fmtDay(week)}`;

  const mileage = data.runs?.weeklyMileage?.at(-1);
  if (mileage) setChartMeta('weeklyMileageChart', `${mileage.miles.toFixed(1)} mi${weekTag(mileage.week)}`, mileage.week, '', weekly);

  const zones = data.zoneMinutes?.at(-1);
  if (zones) {
    const total = ['z1', 'z2', 'z3', 'z4', 'z5'].reduce((sum, k) => sum + (zones[k] || 0), 0);
    setChartMeta('zoneMinutesChart', `${Math.round(total)} min${weekTag(zones.week)}`, zones.week, '', weekly);
  }

  const recLast = latestRow(data.hrRecovery, 'recovery');
  if (recLast) setChartMeta('hrRecoveryChart', `${recLast.recovery} bpm drop`, recLast.date,
    goalGap(recLast.recovery, GOALS.hrRecovery60Bpm, { unit: 'bpm', decimals: 0 }));

  const ltLast = latestRow(data.lactateThreshold, 'lthr');
  if (ltLast) setChartMeta('ltChart',
    `${ltLast.lthr} bpm${ltLast.pace != null ? ' · ' + fmtPace(ltLast.pace) : ''}`, ltLast.date);

  // training_days is deliberately not shown — see renderOverview.
  const volLast = latestRow(data.workoutVolume, 'total_sets');
  if (volLast) setChartMeta('volumeChart', `${volLast.total_sets} sets${weekTag(volLast.week)}`, volLast.week, '', weekly);

  // Lift charts: dated by the most recently logged lift on the card, with how
  // many of its lifts are still being trained (logged within the red-flag
  // window) — retired lifts stay on these charts as history.
  for (const [canvasId, exercises] of Object.entries({
    ...Object.fromEntries(Object.entries(LIFT_CHARTS).map(([id, roster]) => [id, roster.map(r => r[0])])),
    ...LIFT_CHART_EXTRA,
  })) {
    const lastWeeks = exercises.map(ex => data.liftProgression?.[ex]?.at(-1)?.date).filter(Boolean);
    if (!lastWeeks.length) continue;
    const newest = lastWeeks.reduce((a, b) => (a > b ? a : b));
    const active = lastWeeks.filter(wk => daysAgo(wk) - WEEK_SPAN <= STALE_RED_DAYS).length;
    setChartMeta(canvasId, `${active} of ${exercises.length} lifts active`, newest, '', weekly);
  }

  const sleepDur = latestRow(data.sleep, 'totalH');
  if (sleepDur) setChartMeta('sleepChart', `${sleepDur.totalH}h`, sleepDur.date);
  const sleepScore = latestRow(data.sleep, 'score');
  if (sleepScore) setChartMeta('sleepScoreChart', `${sleepScore.score}`, sleepScore.date);
  const stepsLast = latestRow(data.steps, 'steps');
  if (stepsLast) setChartMeta('stepsChart', `${stepsLast.steps.toLocaleString()} steps`, stepsLast.date);
  const stressLast = latestRow(data.stress, 'stress');
  if (stressLast) setChartMeta('stressChart', `${stressLast.stress} avg`, stressLast.date);
  const bbLast = data.bodyBattery?.findLast(d => d.low != null && d.high != null);
  if (bbLast) setChartMeta('bodyBatteryChart', `${bbLast.low}–${bbLast.high}`, bbLast.date);
}

/** Render the Overview page: at-a-glance KPI cards (latest value + goal gap)
 *  so you don't have to scan every chart to know where you stand today. */
function renderOverview(data) {
  const grid = document.getElementById('overviewGrid');
  if (!grid) return;
  const cards = [];
  const add = (label, value, sub) => cards.push(
    `<div class="kpi"><div class="kpi-label">${label}</div>` +
    `<div class="kpi-value">${value}</div>` +
    (sub ? `<div class="kpi-sub">${sub}</div>` : '') + '</div>');

  // latestRow() throughout: a card is only rendered from a row that has a value.
  const w = latestRow(data.weight, 'weight');
  if (w) add('Weight', `${w.weight.toFixed(1)} lb`, goalGap(w.weight, GOALS.weightLbs, { unit: 'lb', lowerIsBetter: true }));
  // Headline is the daily Renpho reading (falling back to the scan itself);
  // the goal gap underneath is DEXA-only — see dexaGoalNote.
  const bf = latestRow(data.bodyFat?.renpho, 'renpho');
  const dexa = latestRow(data.bodyFat?.dexa, 'dexa');
  if (bf || dexa) add('Body Fat', `${bf ? bf.renpho : dexa.dexa}%`, dexaGoalNote(data));
  const rhr = latestRow(data.rhr, 'rhr');
  if (rhr) add('Resting HR', `${rhr.rhr} bpm`, goalGap(rhr.rhr, GOALS.rhrBpm, { unit: 'bpm', decimals: 0, lowerIsBetter: true }));
  const hrv = latestRow(data.hrv, 'hrv');
  if (hrv) add('HRV', `${hrv.hrv} ms`, goalGap(hrv.hrv, GOALS.hrvMs, { unit: 'ms', decimals: 0 }));
  const vo2 = latestRow(data.vo2max, 'vo2max');
  if (vo2) add('VO2 Max', `${vo2.vo2max}`, goalGap(vo2.vo2max, GOALS.vo2max, { decimals: 1 }));
  const lt = latestRow(data.lactateThreshold, 'lthr');
  if (lt) add('Lactate Threshold', `${lt.lthr} bpm`, lt.pace != null ? `${fmtPace(lt.pace)} pace` : '');
  const run = data.runs?.all?.at(-1);
  if (run) add('Last Run', `${run.distMi.toFixed(1)} mi`, `${fmtPace(run.paceMinMi)} · ${relativeAgo(run.date)}`);
  // Labelled "This Week" only when the latest row is this week; otherwise by
  // the week it actually is. No training-day count: workout_weeks.training_days
  // only ever holds 0/5/6/7 (it read "7 training days" on day 5 of a week) and
  // nothing per-day reaches the client to derive it from — the sets/lift
  // endpoints are week-level. Put it back once workout_sync.py writes real values.
  const vol = latestRow(data.workoutVolume, 'total_sets');
  if (vol) {
    const current = isCurrentWeek(vol.week);
    add(current ? 'This Week' : `Week of ${fmtDay(vol.week)}`, `${vol.total_sets} sets`,
      current ? `wk of ${fmtDay(vol.week)}` : relativeWeek(vol.week));
  }
  // Sleep rows are keyed by wake-up date, so only today's row is "last night".
  const sl = latestRow(data.sleep, 'score');
  if (sl) {
    const nights = daysAgo(sl.date);
    const when = nights === 0 ? 'last night' : nights === 1 ? '2 nights ago' : fmtDay(sl.date);
    add('Sleep', `${sl.score}`, `${sl.totalH != null ? sl.totalH + 'h · ' : ''}${when}`);
  }
  const stp = latestRow(data.steps, 'steps');
  if (stp) add('Steps', stp.steps.toLocaleString(), stp.step_goal != null ? `goal ${stp.step_goal.toLocaleString()}` : '');

  grid.innerHTML = cards.join('') || '<p class="card-error">No data yet.</p>';
}

function setupAutoRefresh() {
  // In-place chart refresh instead of `location.reload()` — preserves scroll
  // position, active page tab, the range button you clicked, and the version
  // chip. Refresh fires when the tab is revisited after >1h, or every 6h.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - _lastRefresh > 3600000) {
      rebuildCharts();
    }
  });
  // The 6h tick is for a tab left open and visible. A hidden tab skips it —
  // nobody is looking, and the visibilitychange above refreshes on return.
  setInterval(() => { if (!document.hidden) rebuildCharts(); }, 21600000);
}

const PAGES = ['overview', 'body', 'sleep', 'daily', 'running', 'lifts'];
let _expandedCanvasId = null;
let _closingExpanded = false;  // a history.back() from closeExpanded() is in flight

function wirePageRouter() {
  window.addEventListener('hashchange', applyRoute);
  // Clear the close-in-flight latch on any traversal, even one that lands on
  // the same hash (no hashchange) — otherwise Esc/✕ would stay dead.
  window.addEventListener('popstate', () => { _closingExpanded = false; });
  applyRoute();
}

/** Show one of the three grid pages and sync nav highlight + a11y state. */
function activatePage(target) {
  const t = PAGES.includes(target) ? target : 'overview';
  try { localStorage.setItem('lastPage', t); } catch {}
  for (const sec of document.querySelectorAll('.page')) {
    sec.classList.toggle('active', sec.id === `page-${t}`);
  }
  for (const a of document.querySelectorAll('#pageNav a')) {
    const on = a.getAttribute('href') === `#${t}`;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  // Chart.js charts that were hidden at init rendered at 0×0 — resize on activate.
  for (const chart of allCharts) {
    if (chart.canvas.closest('.page')?.id === `page-${t}`) chart.resize();
  }
}

/** Route off #hash: `#chart/<canvasId>` expands one chart full-page (deep-linkable,
 *  back-button closes it); anything else is a normal page route. */
function applyRoute() {
  _closingExpanded = false;
  const m = location.hash.slice(1).match(/^chart\/(.+)$/);
  const canvas = m && document.getElementById(m[1]);
  if (canvas && canvas.closest('.chart-card')) {
    activatePage(canvas.closest('.page')?.id.replace('page-', ''));
    expandChart(m[1]);
  } else {
    collapseChart();
    activatePage(location.hash.slice(1));
  }
}

/** Blow one chart up to a full-page view. Reuses the existing chart instance —
 *  the card just becomes position:fixed and the canvas CSS height grows, so we
 *  resize() to let Chart.js redraw at the new size. Zoom/pan still work. */
function expandChart(canvasId) {
  if (_expandedCanvasId === canvasId) return;
  collapseChart();
  const canvas = document.getElementById(canvasId);
  const card = canvas?.closest('.chart-card');
  if (!card) return;
  card.classList.add('expanded');
  document.body.classList.add('has-expanded-chart');
  _expandedCanvasId = canvasId;
  const chart = Chart.getChart(canvas);
  if (chart) requestAnimationFrame(() => chart.resize());
  card.querySelector('.expand-close')?.focus();
}

function collapseChart() {
  if (!_expandedCanvasId) return;
  const canvas = document.getElementById(_expandedCanvasId);
  const card = canvas?.closest('.chart-card');
  card?.classList.remove('expanded');
  document.body.classList.remove('has-expanded-chart');
  const chart = canvas && Chart.getChart(canvas);
  _expandedCanvasId = null;
  if (chart) requestAnimationFrame(() => chart.resize());
}

/** Leave the expanded view (Esc / ✕) without adding to history. Assigning
 *  location.hash here pushed a third entry (page → chart → page), so Back
 *  reopened the chart that was just closed. */
function closeExpanded() {
  // history.back() is async — a held Esc or a double click must not pop twice.
  if (_closingExpanded) return;
  if (history.state?.expanded) {
    // Opened with ⤢: the expanded view is our own entry on top of the page's — pop it.
    _closingExpanded = true;
    history.back();
    return;
  }
  // Deep-linked #chart/…: nothing of ours underneath, so swap this entry for
  // the chart's page instead of popping out of the dashboard.
  const canvas = _expandedCanvasId && document.getElementById(_expandedCanvasId);
  const page = canvas?.closest('.page');
  location.replace(`#${page ? page.id.replace('page-', '') : ''}`);
}

/** Inject an expand (⤢) and close (✕) control into each chart card, once.
 *  A dedicated control rather than click-the-chart: a single canvas click would
 *  collide with the double-click-to-reset-zoom (dblclick fires click first). */
function wireChartExpand() {
  for (const card of document.querySelectorAll('.chart-card')) {
    const canvas = card.querySelector('canvas');
    if (!canvas || !canvas.id || card.querySelector('.expand-btn')) continue;
    const title = card.querySelector('h2')?.textContent || 'chart';
    // Give the chart canvas an accessible name (WCAG 1.1.1) — Chart.js renders
    // to a bare <canvas> with no text alternative otherwise.
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${title} chart`);
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'expand-btn';
    expand.title = 'Expand';
    expand.setAttribute('aria-label', `Expand ${title}`);
    expand.textContent = '⤢';
    // pushState rather than location.hash so the entry carries a marker that
    // closeExpanded() can recognise as ours to pop (pushState fires no
    // hashchange, hence the explicit applyRoute).
    expand.addEventListener('click', () => {
      history.pushState({ expanded: true }, '', `#chart/${canvas.id}`);
      applyRoute();
    });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'expand-close';
    close.title = 'Close (Esc)';
    close.setAttribute('aria-label', `Close expanded ${title}`);
    close.textContent = '✕';
    close.addEventListener('click', closeExpanded);
    card.append(expand, close);
  }
  if (!wireChartExpand._escBound) {
    wireChartExpand._escBound = true;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _expandedCanvasId) closeExpanded();
    });
  }
}

function wireRangePresets() {
  const container = document.getElementById('rangePresets');
  if (!container) return;
  // Sync button highlight with the (possibly localStorage-restored) currentRange
  for (const b of container.querySelectorAll('button')) {
    const on = b.dataset.range === currentRange;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  updateRangeCaption();
  container.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    currentRange = btn.dataset.range;
    currentMin = rangeMin(currentRange);
    currentMax = localISO();
    try { localStorage.setItem('range', currentRange); } catch {}
    for (const b of container.querySelectorAll('button')) {
      const on = b === btn;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    for (const chart of allCharts) {
      // resetZoom reverts scale options to construction values — reset first, then apply new min
      chart.resetZoom('none');
      if (currentMin == null) delete chart.options.scales.x.min;
      else chart.options.scales.x.min = currentMin;
      chart.options.scales.x.max = currentMax;
      chart.update('none');
    }
    updateRangeCaption();
  });
}

if (typeof Chart === 'undefined') {
  // Chart.js failed to load (CDN unreachable or SRI mismatch) — show an error
  // instead of leaving every card pulsing its skeleton forever.
  showCardError('Charts failed to load — check your connection and refresh.');
} else {
  Chart.register(Crosshair);
  // Annotations (goal lines, PR stars, events) are part of the chart frame —
  // draw them in place instead of animating. With animation on, a card resize
  // during the initial data animation (skeleton removal) got overwritten by the
  // still-running tween, leaving lines at the pre-resize pixel (goal 190 drew at ~193).
  Chart.defaults.plugins.annotation.animations = false;
  init();
}
