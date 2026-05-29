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
  weightLbs: 202,        // Jul 6 2026, end of 6-week meso (long-term: 200 by Feb 2027)
  bodyFatPct: 13,        // Jul 6 2026, DEXA-verified (Renpho reads +1.1% high)
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

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
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

const SAVED_RANGE = (typeof localStorage !== 'undefined' && localStorage.getItem('range')) || 'YTD';
let currentRange = ['1M','3M','6M','YTD','1Y','All'].includes(SAVED_RANGE) ? SAVED_RANGE : 'YTD';
let currentMin = rangeMin(currentRange);
const allCharts = [];

function relativeAgo(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days < 0) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days/7)}w ago`;
  return `${Math.floor(days/30)}mo ago`;
}

function setChartMeta(canvasId, latest, lastDate, goalNote) {
  const canvas = document.getElementById(canvasId);
  const card = canvas?.closest('.chart-card');
  if (!card) return;
  let meta = card.querySelector('.chart-meta');
  if (!meta) {
    meta = document.createElement('div');
    meta.className = 'chart-meta';
    card.querySelector('h2')?.after(meta);
  }
  const ago = relativeAgo(lastDate);
  // Staleness: flag metrics that haven't updated within their expected cadence
  // (catches a silently-broken sync — e.g. hr-recovery that's weeks behind).
  const days = lastDate ? Math.floor((Date.now() - new Date(lastDate).getTime()) / 86400000) : -1;
  const stale = days > 21 ? ' stale-red' : days > 7 ? ' stale-amber' : '';
  meta.innerHTML =
    (latest ? `<span class="chart-latest">${latest}</span>` : '') +
    (goalNote ? `<span class="chart-goal">${goalNote}</span>` : '') +
    (ago ? `<span class="chart-updated${stale}" title="updated ${ago}">${ago}</span>` : '');
}

function updateRangeCaption() {
  const el = document.getElementById('rangeCaption');
  if (!el) return;
  const today = new Date().toISOString().split('T')[0];
  el.textContent = currentMin
    ? `Showing ${currentMin} → ${today} (${currentRange})`
    : `Showing all data (${currentRange})`;
}

function fmtPace(minPerMi) {
  if (minPerMi == null) return '';
  let m = Math.floor(minPerMi);
  let s = Math.round((minPerMi - m) * 60);
  if (s === 60) { m += 1; s = 0; }
  return `${m}:${String(s).padStart(2, '0')}/mi`;
}

/** Shared x-scale so every chart reads `currentMin` from one place. */
function xScale(timeUnit = 'month') {
  return {
    type: 'time',
    time: { unit: timeUnit },
    min: currentMin,
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

/** Compute N-point moving average for a dataset */
function computeMA(data, key, window) {
  return data.map((d, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = data.slice(start, i + 1);
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
      const page = originChart.canvas.closest('.page');
      if (!page) return;
      for (const c of allCharts) {
        if (c === originChart) continue;
        if (c.canvas.closest('.page') === page) c.draw();
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
    const canvas = card.querySelector('canvas');
    if (canvas) canvas.style.display = 'none';
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
  // Released in the populate frame below (and on load failure), once the new
  // charts are live and tracked in allCharts.
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
  _lastRefresh = Date.now();

  // Tear down existing charts only AFTER a successful load, so a failed refresh
  // leaves the current charts on screen instead of blanking them. Preserves DOM
  // state (scroll, active tab, range button, version chip) a full reload would
  // discard. Tradeoff: per-chart zoom/pan state resets.
  for (const c of allCharts) c.destroy();
  allCharts.length = 0;
  const pending = [];

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
    opts.plugins.annotation = {
      annotations: GOALS.bodyFatPct != null
        ? { target: goalLineAnnotation(GOALS.bodyFatPct, `target ${GOALS.bodyFatPct}%`, COLORS.yellow) }
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
    const whr = data.bodyMeasurements
      .filter(d => d.waist != null && d.hips)
      .map(d => ({ x: d.date, y: Math.round((d.waist / d.hips) * 1000) / 1000 }));
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
    const recentHRV = (data.hrv || []).slice(-90).map(d => d.hrv).filter(v => v != null);
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
      { ...trendline('mileage', mileagePoints, COLORS.green), label: 'Trend', type: 'line' },
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

  // 12-14. Combined exercise progression charts
  // Machine exercises: filter to 2026+ (new gym)
  const GYM_START = '2026-01-01';
  const REPS_ONLY = ['pull ups', 'push ups', 'dips', 'v ups', 'calf raise bw', 'neck extension', 'neck flexion'];
  function exerciseY(exercise, { weight, reps, maxReps }) {
    if (REPS_ONLY.includes(exercise)) return maxReps ?? reps;
    if (exercise === 'dead hang') return reps;
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
   * Build a Chart.js annotation pair (star + label) at the heaviest-weight
   * point in a lift series. Returns a flat object with two entries keyed by
   * the slugified exercise name, suitable for Object.assign-ing into a
   * chart's annotations dict.
   *
   * IMPORTANT: chartjs-plugin-annotation@3 does NOT honor a `label` sub-option
   * on `type: 'point'` — labels must be their own `type: 'label'` annotation.
   * That bug silently swallowed the "PR" text before this rewrite.
   *
   * `rankBy` picks which field decides "best": 'weight' (default) or 'y'.
   */
  function prAnnotation(dataPoints, label = 'PR', rankBy = 'weight') {
    const arr = (dataPoints || []).filter(p => p && p[rankBy] != null && p.y != null);
    if (arr.length === 0) return {};
    const top = arr.reduce((m, p) => p[rankBy] > m[rankBy] ? p : m);
    const id = label.replace(/\W+/g, '') || 'pr';
    const valueText = rankBy === 'weight' && top.weight != null
      ? `${label} ${Math.round(top.weight)}`
      : label;
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
        yAdjust: -18,
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

  // 12. Upper Body Machines (Chest Press + Incline Press + Row Machine + Cable Row + Dips Machine + Dips Weighted)
  const chestData = liftData('chest press', GYM_START);
  const inclineData = liftData('incline press', GYM_START);
  const rowData = liftData('row machine', GYM_START);
  const cableRowData = liftData('cable row', GYM_START);
  const dipsMachineData = liftData('dips machine', GYM_START);
  const dipsWeightedData = liftData('dips weighted', GYM_START);
  const upperMachineAnno = compactAnnotations({
    chestPR: prAnnotation(chestData, 'Chest'),
    inclinePR: prAnnotation(inclineData, 'Incline'),
    rowPR: prAnnotation(rowData, 'Row'),
    cableRowPR: prAnnotation(cableRowData, 'Cable Row'),
    dipsMachinePR: prAnnotation(dipsMachineData, 'Dips M'),
    dipsWeightedPR: prAnnotation(dipsWeightedData, 'Dips W'),
  });
  pending.push(createChart('upperMachineChart', 'line', [
    setsScatter('chest press', FADED.red, GYM_START),
    setsScatter('incline press', FADED.green, GYM_START),
    setsScatter('row machine', FADED.blue, GYM_START),
    setsScatter('cable row', FADED.yellow, GYM_START),
    setsScatter('dips machine', FADED.orange, GYM_START),
    setsScatter('dips weighted', FADED.purple, GYM_START),
    { label: 'Chest Press', data: chestData, ...liftDefaults(COLORS.red) },
    trendline('chest', chestData, FADED.red),
    { label: 'Incline Press', data: inclineData, ...liftDefaults(COLORS.green) },
    trendline('incline', inclineData, FADED.green),
    { label: 'Row Machine', data: rowData, ...liftDefaults(COLORS.blue) },
    trendline('row', rowData, FADED.blue),
    { label: 'Cable Row', data: cableRowData, ...liftDefaults(COLORS.yellow) },
    trendline('cableRow', cableRowData, FADED.yellow),
    { label: 'Dips (machine)', data: dipsMachineData, ...liftDefaults(COLORS.orange) },
    trendline('dipsMachine', dipsMachineData, FADED.orange),
    { label: 'Dips (weighted)', data: dipsWeightedData, ...liftDefaults(COLORS.purple) },
    trendline('dipsWeighted', dipsWeightedData, FADED.purple),
  ], liftOpts('lbs', upperMachineAnno)));

  // 13. Upper Body DB (Lat Raise, Hammer Curls, Kelso Shrugs)
  const latData = liftData('lateral raise');
  const curlData = liftData('hammer curl');
  const shrugData = liftData('kelso shrugs');
  const upperDBAnno = compactAnnotations({
    latPR: prAnnotation(latData, 'Lat Raise'),
    curlPR: prAnnotation(curlData, 'Hammer'),
    shrugPR: prAnnotation(shrugData, 'Shrug'),
  });
  pending.push(createChart('upperDBChart', 'line', [
    setsScatter('lateral raise', FADED.green),
    setsScatter('hammer curl', FADED.yellow),
    setsScatter('kelso shrugs', FADED.blue),
    { label: 'Lat Raise', data: latData, ...liftDefaults(COLORS.green) },
    trendline('lat', latData, FADED.green),
    { label: 'Hammer Curls', data: curlData, ...liftDefaults(COLORS.yellow) },
    trendline('curl', curlData, FADED.yellow),
    { label: 'Kelso Shrugs', data: shrugData, ...liftDefaults(COLORS.blue) },
    trendline('shrug', shrugData, FADED.blue),
  ], liftOpts('lbs', upperDBAnno)));

  // 14a. Lower Body — Legs (Leg Press, Leg Curl, Leg Extension, Calf Raise)
  const legData = liftData('leg press', GYM_START);
  const legCurlData = liftData('leg curl', GYM_START);
  const legExtData = liftData('leg extension', GYM_START);
  const calfData = liftData('calf raise seated');
  const lowerLegsAnno = compactAnnotations({
    legPR: prAnnotation(legData, 'Leg Press'),
    legCurlPR: prAnnotation(legCurlData, 'Leg Curl'),
    legExtPR: prAnnotation(legExtData, 'Leg Ext'),
    calfPR: prAnnotation(calfData, 'Calf'),
  });
  pending.push(createChart('lowerLegsChart', 'line', [
    setsScatter('leg press', FADED.purple, GYM_START),
    setsScatter('leg curl', FADED.blue, GYM_START),
    setsScatter('leg extension', FADED.pink, GYM_START),
    setsScatter('calf raise seated', FADED.yellow),
    { label: 'Leg Press', data: legData, ...liftDefaults(COLORS.purple) },
    trendline('leg', legData, FADED.purple),
    { label: 'Leg Curl (unilateral)', data: legCurlData, ...liftDefaults(COLORS.blue) },
    trendline('legCurl', legCurlData, FADED.blue),
    { label: 'Leg Extension', data: legExtData, ...liftDefaults(COLORS.pink) },
    trendline('legExt', legExtData, FADED.pink),
    { label: 'Calf Raise (seated)', data: calfData, ...liftDefaults(COLORS.yellow) },
    trendline('calf', calfData, FADED.yellow),
  ], liftOpts('lbs', lowerLegsAnno)));

  // 14b. Lower Body — Hip / Core (Abductors, Adductors, Side Bend, Ab Machine)
  const abdData = liftData('abductors', GYM_START);
  const addData = liftData('adductors', GYM_START);
  const sideData = liftData('side bend');
  const abMachineData = liftData('ab machine');
  const lowerHipCoreAnno = compactAnnotations({
    abdPR: prAnnotation(abdData, 'Abd'),
    addPR: prAnnotation(addData, 'Add'),
    sidePR: prAnnotation(sideData, 'Side'),
    abMachinePR: prAnnotation(abMachineData, 'Ab Mach'),
  });
  pending.push(createChart('lowerHipCoreChart', 'line', [
    setsScatter('abductors', FADED.orange, GYM_START),
    setsScatter('adductors', FADED.red, GYM_START),
    setsScatter('side bend', FADED.green),
    setsScatter('ab machine', FADED.cyan),
    { label: 'Abductors', data: abdData, ...liftDefaults(COLORS.orange) },
    trendline('abd', abdData, FADED.orange),
    { label: 'Adductors', data: addData, ...liftDefaults(COLORS.red) },
    trendline('add', addData, FADED.red),
    { label: 'Side Bend', data: sideData, ...liftDefaults(COLORS.green) },
    trendline('side', sideData, FADED.green),
    { label: 'Ab Machine', data: abMachineData, ...liftDefaults(COLORS.cyan) },
    trendline('abMachine', abMachineData, FADED.cyan),
  ], liftOpts('lbs', lowerHipCoreAnno)));

  // 15. Lower Body BB/DB (RDL Barbell + RDL Dumbbell)
  const rdlBBData = liftData('rdl barbell');
  const rdlDBData = liftData('rdl dumbbell');
  const lowerBBDBAnno = compactAnnotations({
    rdlBBPR: prAnnotation(rdlBBData, 'RDL BB'),
    rdlDBPR: prAnnotation(rdlDBData, 'RDL DB'),
  });
  pending.push(createChart('lowerBBDBChart', 'line', [
    setsScatter('rdl barbell', FADED.red),
    setsScatter('rdl dumbbell', FADED.yellow),
    { label: 'RDL Barbell', data: rdlBBData, ...liftDefaults(COLORS.red) },
    trendline('rdlBB', rdlBBData, FADED.red),
    { label: 'RDL Dumbbell', data: rdlDBData, ...liftDefaults(COLORS.yellow) },
    trendline('rdlDB', rdlDBData, FADED.yellow),
  ], liftOpts('lbs', lowerBBDBAnno)));

  // 16. Bodyweight (Pull-ups, Dips, Push-ups + Dead Hang seconds on right axis)
  const pullData = liftData('pull ups');
  const dipsData = liftData('dips');
  const pushData = liftData('push ups');
  const calfBWData = liftData('calf raise bw');
  const hangData = liftData('dead hang');
  pending.push(createChart('bodyweightChart', 'line', [
    { ...setsScatter('pull ups', FADED.green), yAxisID: 'y' },
    { ...setsScatter('dips', FADED.yellow), yAxisID: 'y' },
    { ...setsScatter('push ups', FADED.red), yAxisID: 'y' },
    { ...setsScatter('calf raise bw', FADED.purple), yAxisID: 'y' },
    { ...setsScatter('dead hang', FADED.blue), yAxisID: 'y1' },
    { label: 'Pull-ups', data: pullData, ...lineDefaults(COLORS.green), yAxisID: 'y' },
    { ...trendline('pull', pullData, FADED.green), yAxisID: 'y' },
    { label: 'Dips', data: dipsData, ...lineDefaults(COLORS.yellow), yAxisID: 'y' },
    { ...trendline('dips', dipsData, FADED.yellow), yAxisID: 'y' },
    { label: 'Push-ups', data: pushData, ...lineDefaults(COLORS.red), yAxisID: 'y' },
    { ...trendline('push', pushData, FADED.red), yAxisID: 'y' },
    { label: 'Calf Raise', data: calfBWData, ...lineDefaults(COLORS.purple), yAxisID: 'y' },
    { ...trendline('calfBW', calfBWData, FADED.purple), yAxisID: 'y' },
    { label: 'Dead Hang (s)', data: hangData, ...lineDefaults(COLORS.blue), yAxisID: 'y1' },
    { ...trendline('hang', hangData, FADED.blue), yAxisID: 'y1' },
  ], (() => {
    const opts = baseOptions({ showLegend: true, timeUnit: 'month' });
    opts.interaction = { mode: 'nearest', intersect: false };
    opts.plugins.legend.labels.filter = legendFilterTrend;
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

  // Populate all charts simultaneously so animations start in sync
  requestAnimationFrame(() => {
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
  });
}

/** Inject latest-value + last-updated chip into chart card headers. */
function applyChartMetadata(data) {
  const arrow = (delta) => delta > 0 ? '▲' : delta < 0 ? '▼' : '→';
  const signed = (v, d = 1) => `${arrow(v)}${Math.abs(v).toFixed(d)}`;
  // "X to goal" given direction. lowerIsBetter: goal sits below current (weight,
  // BF, RHR); otherwise above (HRV, VO2, HR-recovery).
  const goalTag = (latest, goal, { unit = '', decimals = 1, lowerIsBetter = false } = {}) => {
    if (goal == null || latest == null) return '';
    const gap = lowerIsBetter ? latest - goal : goal - latest;
    if (gap <= 0) return '✓ at goal';
    return `${gap.toFixed(decimals)}${unit ? ' ' + unit : ''} to goal`;
  };

  const w = data.weight?.at(-1);
  if (w) {
    const vs30 = w.ma30 != null ? ` · ${signed(w.weight - w.ma30)} vs 30d` : '';
    setChartMeta('weightChart', `${w.weight.toFixed(1)} lb${vs30}`, w.date,
      goalTag(w.weight, GOALS.weightLbs, { unit: 'lb', lowerIsBetter: true }));
  }

  const bf = data.bodyFat?.renpho?.at(-1);
  if (bf) setChartMeta('bodyFatChart', `${bf.renpho}%`, bf.date,
    goalTag(bf.renpho, GOALS.bodyFatPct, { unit: '%', lowerIsBetter: true }));

  const rhr = data.rhr?.at(-1);
  if (rhr) setChartMeta('rhrChart', `${rhr.rhr} bpm`, rhr.date,
    goalTag(rhr.rhr, GOALS.rhrBpm, { unit: 'bpm', decimals: 0, lowerIsBetter: true }));

  const hrv = data.hrv?.at(-1);
  if (hrv) setChartMeta('hrvChart', `${hrv.hrv} ms`, hrv.date,
    goalTag(hrv.hrv, GOALS.hrvMs, { unit: 'ms', decimals: 0 }));

  const vo2 = data.vo2max?.at(-1);
  if (vo2) setChartMeta('vo2maxChart', `${vo2.vo2max}`, vo2.date,
    goalTag(vo2.vo2max, GOALS.vo2max, { decimals: 1 }));

  const lastRun = data.runs?.all?.at(-1);
  if (lastRun) setChartMeta('efChart', `${lastRun.distMi.toFixed(1)}mi · ${lastRun.avgHR}bpm`, lastRun.date);

  const longLast = data.runs?.longRuns?.at(-1);
  if (longLast) setChartMeta('longRunChart', `${longLast.distMi.toFixed(1)} mi`, longLast.date);

  const weekly = data.runs?.weeklyMileage?.at(-1);
  if (weekly) setChartMeta('weeklyMileageChart', `${weekly.miles.toFixed(1)} mi this wk`, weekly.week);

  const recoveryRows = data.hrRecovery || [];
  const recLast = recoveryRows.at(-1);
  if (recLast) setChartMeta('hrRecoveryChart', `${recLast.recovery} bpm drop`, recLast.date,
    goalTag(recLast.recovery, GOALS.hrRecovery60Bpm, { unit: 'bpm', decimals: 0 }));

  const volLast = data.workoutVolume?.at(-1);
  if (volLast) setChartMeta('volumeChart', `${volLast.total_sets} sets · ${volLast.training_days} days`, volLast.week);
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
  const gap = (latest, goal, lower, unit, dec = 1) => {
    if (latest == null || goal == null) return '';
    const g = lower ? latest - goal : goal - latest;
    return g <= 0 ? '✓ at goal' : `${g.toFixed(dec)}${unit ? ' ' + unit : ''} to goal`;
  };

  const w = data.weight?.at(-1);
  if (w) add('Weight', `${w.weight.toFixed(1)} lb`, gap(w.weight, GOALS.weightLbs, true, 'lb'));
  const bf = data.bodyFat?.renpho?.at(-1);
  if (bf) add('Body Fat', `${bf.renpho}%`, gap(bf.renpho, GOALS.bodyFatPct, true, '%'));
  const rhr = data.rhr?.at(-1);
  if (rhr) add('Resting HR', `${rhr.rhr} bpm`, gap(rhr.rhr, GOALS.rhrBpm, true, 'bpm', 0));
  const hrv = data.hrv?.at(-1);
  if (hrv) add('HRV', `${hrv.hrv} ms`, gap(hrv.hrv, GOALS.hrvMs, false, 'ms', 0));
  const vo2 = data.vo2max?.at(-1);
  if (vo2) add('VO2 Max', `${vo2.vo2max}`, gap(vo2.vo2max, GOALS.vo2max, false, '', 1));
  const run = data.runs?.all?.at(-1);
  if (run) add('Last Run', `${run.distMi.toFixed(1)} mi`, `${fmtPace(run.paceMinMi)} · ${relativeAgo(run.date)}`);
  const vol = data.workoutVolume?.at(-1);
  if (vol) add('This Week', `${vol.total_sets} sets`, `${vol.training_days} training days`);

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
  setInterval(() => { rebuildCharts(); }, 21600000);
}

const PAGES = ['overview', 'body', 'running', 'lifts'];
let _expandedCanvasId = null;

function wirePageRouter() {
  window.addEventListener('hashchange', applyRoute);
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

/** Leave the expanded view by routing back to the chart's own page. */
function closeExpanded() {
  const canvas = _expandedCanvasId && document.getElementById(_expandedCanvasId);
  const page = canvas?.closest('.page');
  location.hash = page ? page.id.replace('page-', '') : '';
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
    expand.addEventListener('click', () => { location.hash = `chart/${canvas.id}`; });
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
  init();
}
