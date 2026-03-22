import { loadAllData } from './data.js';

const COLORS = {
  blue: '#4a9eff',
  red: '#ff6b6b',
  green: '#51cf66',
  yellow: '#ffd43b',
  purple: '#cc5de8',
  blueFaded: 'rgba(74,158,255,0.3)',
  blueBar: 'rgba(74,158,255,0.7)',
};

const GRID_COLOR = 'rgba(255,255,255,0.06)';
const TICK_COLOR = '#8b8fa3';

const ANIMATION = { duration: 1000, easing: 'easeOutQuart' };

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
    },
    scales: {
      x: {
        type: 'time',
        time: { unit: timeUnit },
        grid: { color: GRID_COLOR },
        ticks: { color: TICK_COLOR },
      },
      y: {
        grid: { color: GRID_COLOR },
        ticks: { color: TICK_COLOR },
        ...(yLabel ? { title: { display: true, text: yLabel, color: TICK_COLOR } } : {}),
      },
    },
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
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
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
  const emptyDatasets = datasets.map(ds => ({ ...ds, data: [] }));
  const chart = new Chart(ctx, {
    type,
    data: { datasets: emptyDatasets },
    options: { ...options, animation: false },
  });
  return { chart, datasets };
}

async function init() {
  const data = await loadAllData();
  const pending = [];

  // 1. Weight
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
  ], baseOptions({ showLegend: true, yLabel: 'lbs' })));

  // 2. Body Fat
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
  ], baseOptions({ showLegend: true, yLabel: '%' })));

  // 3. Measurements (stomach & waist)
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
  ], baseOptions({ showLegend: true, yLabel: 'inches' })));

  // 4. Resting Heart Rate
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
  ], baseOptions({ showLegend: true, yLabel: 'bpm' })));

  // 5. HRV
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
  ], baseOptions({ showLegend: true, yLabel: 'ms' })));

  // 6. Efficiency Factor + trendline
  const efPoints = data.runs.all.map(d => ({ x: d.date, y: d.ef }));
  const efTrend = linearTrendline(efPoints);
  pending.push(createChart('efChart', 'line', [
    {
      label: 'EF',
      data: efPoints,
      ...lineDefaults(COLORS.blue),
    },
    {
      label: 'Trend',
      data: efTrend,
      ...lineDefaults(COLORS.yellow),
      pointRadius: 0,
      borderDash: [6, 3],
      tension: 0,
    },
  ], baseOptions({ showLegend: true })));

  // 7. 5K Heart Rate (primary y) + Pace (secondary y)
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
  ], {
    ...baseOptions({ showLegend: true }),
    scales: {
      x: {
        type: 'time',
        time: { unit: 'month' },
        grid: { color: GRID_COLOR },
        ticks: { color: TICK_COLOR },
      },
      y: {
        position: 'left',
        grid: { color: GRID_COLOR },
        ticks: { color: TICK_COLOR },
        title: { display: true, text: 'bpm', color: TICK_COLOR },
      },
      y1: {
        position: 'right',
        grid: { drawOnChartArea: false },
        ticks: { color: TICK_COLOR },
        title: { display: true, text: 'min/mi', color: TICK_COLOR },
      },
    },
  }));

  // 8. Long Run Distance
  pending.push(createChart('longRunChart', 'line', [
    {
      label: 'Distance',
      data: data.runs.longRuns.map(d => ({ x: d.date, y: d.distMi })),
      ...lineDefaults(COLORS.purple),
    },
  ], baseOptions({ yLabel: 'miles' })));

  // 9. Weekly Mileage (bar + trendline)
  const mileagePoints = data.runs.weeklyMileage.map(d => ({ x: d.week, y: d.miles }));
  const mileageTrend = linearTrendline(mileagePoints);
  pending.push(createChart('weeklyMileageChart', 'bar', [
    {
      label: 'Miles',
      data: mileagePoints,
      backgroundColor: COLORS.blueBar,
      borderColor: COLORS.blue,
      borderWidth: 1,
      borderRadius: 3,
    },
    {
      type: 'line',
      label: 'Trend',
      data: mileageTrend,
      ...lineDefaults(COLORS.green),
      pointRadius: 0,
      borderDash: [6, 3],
      tension: 0,
    },
  ], baseOptions({ showLegend: true, timeUnit: 'week', yLabel: 'miles' })));

  // Populate all charts simultaneously so animations start in sync
  requestAnimationFrame(() => {
    for (const { chart, datasets } of pending) {
      chart.data.datasets = datasets;
      chart.options.animation = ANIMATION;
      chart.update();
      chart.canvas.closest('.chart-card')?.classList.remove('loading');
    }
  });
}

init();
