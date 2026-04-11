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
const YEAR_START = `${new Date().getFullYear()}-01-01`;

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
      zoom: {
        zoom: {
          wheel: { enabled: true },
          pinch: { enabled: true },
          mode: 'x',
        },
        pan: {
          enabled: true,
          mode: 'x',
        },
      },
    },
    scales: {
      x: {
        type: 'time',
        time: { unit: timeUnit },
        min: YEAR_START,
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

async function init() {
  let data;
  try {
    data = await loadAllData();
  } catch (e) {
    console.error('Failed to load data:', e);
    document.querySelectorAll('.chart-card.loading').forEach(card => {
      card.classList.remove('loading');
      card.querySelector('canvas').style.display = 'none';
      card.insertAdjacentHTML('beforeend', '<p style="color:#ff6b6b;text-align:center;margin-top:2rem">Failed to load data</p>');
    });
    return;
  }
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

  // 3. Measurements (stomach, waist & neck)
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
      label: 'Neck',
      data: data.bodyMeasurements.filter(d => d.neck != null).map(d => ({ x: d.date, y: d.neck })),
      ...lineDefaults(COLORS.green),
    },
  ], baseOptions({ showLegend: true, yLabel: 'inches' })));

  // 3b. Limb Measurements (bicep, forearm, quad, calf)
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
        min: YEAR_START,
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

  // 10. VO2 Max
  const vo2Points = data.vo2max.map(d => ({ x: d.date, y: d.vo2max }));
  const vo2Trend = linearTrendline(vo2Points);
  pending.push(createChart('vo2maxChart', 'line', [
    {
      label: 'VO2 Max',
      data: vo2Points,
      ...lineDefaults(COLORS.green),
    },
    {
      label: 'Trend',
      data: vo2Trend,
      ...lineDefaults(COLORS.yellow),
      pointRadius: 0,
      borderDash: [6, 3],
      tension: 0,
    },
  ], baseOptions({ showLegend: true })));

  // 11. Weekly Training Volume
  pending.push(createChart('volumeChart', 'bar', [
    {
      label: 'Sets',
      data: data.workoutVolume.map(d => ({ x: d.week, y: d.total_sets })),
      backgroundColor: COLORS.blueBar,
      borderColor: COLORS.blue,
      borderWidth: 1,
      borderRadius: 3,
    },
  ], baseOptions({ timeUnit: 'week', yLabel: 'sets' })));

  // 12-14. Combined exercise progression charts
  // Machine exercises: filter to 2026+ (new gym)
  const GYM_START = '2026-01-01';
  function liftData(exercise, filterDate) {
    const points = data.liftProgression[exercise] || [];
    const isRepsOnly = ['pull ups', 'push ups', 'dips', 'v ups', 'calf raise bw'].includes(exercise);
    const isSeconds = exercise === 'dead hang';
    return points
      .filter(p => !filterDate || p.date >= filterDate)
      .map(p => ({
        x: p.date,
        y: isRepsOnly ? p.maxReps : isSeconds ? p.reps : p.weight,
        reps: p.reps,
      })).filter(p => p.y != null && p.y > 0);
  }
  const legendFilterTrend = (item) => !item.text.startsWith('_');

  /** Point radius scaled by reps — bigger dot = more reps */
  function repsPointRadius(ctx) {
    const reps = ctx.raw && ctx.raw.reps;
    if (!reps || typeof reps !== 'number') return 2;
    return Math.max(2, Math.min(8, reps / 3));
  }
  function liftDefaults(color) {
    return {
      ...lineDefaults(color),
      pointRadius: repsPointRadius,
      pointHoverRadius: 8,
    };
  }
  function liftOpts(yLabel) {
    const opts = baseOptions({ showLegend: true, timeUnit: 'month', yLabel });
    opts.plugins.legend.labels.filter = legendFilterTrend;
    opts.plugins.tooltip = {
      callbacks: {
        afterLabel: (ctx) => {
          const reps = ctx.raw?.reps;
          return reps ? `Reps: ${reps}` : '';
        },
      },
    };
    return opts;
  }

  // 12. Upper Body Machines (Chest Press + Row Machine)
  const chestData = liftData('chest press', GYM_START);
  const rowData = liftData('row machine', GYM_START);
  pending.push(createChart('upperMachineChart', 'line', [
    { label: 'Chest Press', data: chestData, ...liftDefaults(COLORS.red) },
    { label: '_chestTrend', data: linearTrendline(chestData), ...lineDefaults('rgba(255,107,107,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
    { label: 'Row Machine', data: rowData, ...liftDefaults(COLORS.blue) },
    { label: '_rowTrend', data: linearTrendline(rowData), ...lineDefaults('rgba(74,158,255,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
  ], liftOpts('lbs')));

  // 13. Upper Body DB (Lat Raise, Hammer Curls, Kelso Shrugs)
  const latData = liftData('lateral raise');
  const curlData = liftData('hammer curl');
  const shrugData = liftData('kelso shrugs');
  pending.push(createChart('upperDBChart', 'line', [
    { label: 'Lat Raise', data: latData, ...liftDefaults(COLORS.green) },
    { label: '_latTrend', data: linearTrendline(latData), ...lineDefaults('rgba(81,207,102,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
    { label: 'Hammer Curls', data: curlData, ...liftDefaults(COLORS.yellow) },
    { label: '_curlTrend', data: linearTrendline(curlData), ...lineDefaults('rgba(255,212,59,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
    { label: 'Kelso Shrugs', data: shrugData, ...liftDefaults(COLORS.blue) },
    { label: '_shrugTrend', data: linearTrendline(shrugData), ...lineDefaults('rgba(74,158,255,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
  ], liftOpts('lbs')));

  // 14. Lower Body Machines (Leg Press, Side Bend, Calf Raise)
  const legData = liftData('leg press', GYM_START);
  const sideData = liftData('side bend');
  const calfData = liftData('calf raise seated');
  pending.push(createChart('lowerMachineChart', 'line', [
    { label: 'Leg Press', data: legData, ...liftDefaults(COLORS.purple) },
    { label: '_legTrend', data: linearTrendline(legData), ...lineDefaults('rgba(204,93,232,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
    { label: 'Side Bend', data: sideData, ...liftDefaults(COLORS.green) },
    { label: '_sideTrend', data: linearTrendline(sideData), ...lineDefaults('rgba(81,207,102,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
    { label: 'Calf Raise (seated)', data: calfData, ...liftDefaults(COLORS.yellow) },
    { label: '_calfTrend', data: linearTrendline(calfData), ...lineDefaults('rgba(255,212,59,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
  ], liftOpts('lbs')));

  // 15. Lower Body BB/DB (RDL Barbell + RDL Dumbbell)
  const rdlBBData = liftData('rdl barbell');
  const rdlDBData = liftData('rdl dumbbell');
  pending.push(createChart('lowerBBDBChart', 'line', [
    { label: 'RDL Barbell', data: rdlBBData, ...liftDefaults(COLORS.red) },
    { label: '_rdlBBTrend', data: linearTrendline(rdlBBData), ...lineDefaults('rgba(255,107,107,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
    { label: 'RDL Dumbbell', data: rdlDBData, ...liftDefaults(COLORS.yellow) },
    { label: '_rdlDBTrend', data: linearTrendline(rdlDBData), ...lineDefaults('rgba(255,212,59,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
  ], liftOpts('lbs')));

  // 16. Bodyweight (Pull-ups, Dips, Push-ups + Dead Hang seconds on right axis)
  const pullData = liftData('pull ups');
  const dipsData = liftData('dips');
  const pushData = liftData('push ups');
  const calfBWData = liftData('calf raise bw');
  const hangData = liftData('dead hang');
  pending.push(createChart('bodyweightChart', 'line', [
    { label: 'Pull-ups', data: pullData, ...lineDefaults(COLORS.green), yAxisID: 'y' },
    { label: '_pullTrend', data: linearTrendline(pullData), ...lineDefaults('rgba(81,207,102,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0, yAxisID: 'y' },
    { label: 'Dips', data: dipsData, ...lineDefaults(COLORS.yellow), yAxisID: 'y' },
    { label: '_dipsTrend', data: linearTrendline(dipsData), ...lineDefaults('rgba(255,212,59,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0, yAxisID: 'y' },
    { label: 'Push-ups', data: pushData, ...lineDefaults(COLORS.red), yAxisID: 'y' },
    { label: '_pushTrend', data: linearTrendline(pushData), ...lineDefaults('rgba(255,107,107,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0, yAxisID: 'y' },
    { label: 'Calf Raise', data: calfBWData, ...lineDefaults(COLORS.purple), yAxisID: 'y' },
    { label: '_calfBWTrend', data: linearTrendline(calfBWData), ...lineDefaults('rgba(204,93,232,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0, yAxisID: 'y' },
    { label: 'Dead Hang (s)', data: hangData, ...lineDefaults(COLORS.blue), yAxisID: 'y1' },
    { label: '_hangTrend', data: linearTrendline(hangData), ...lineDefaults('rgba(74,158,255,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0, yAxisID: 'y1' },
  ], {
    ...baseOptions({ showLegend: true, timeUnit: 'month' }),
    plugins: {
      legend: {
        display: true,
        labels: { color: TICK_COLOR, boxWidth: 12, filter: legendFilterTrend },
      },
      zoom: {
        zoom: {
          wheel: { enabled: true },
          pinch: { enabled: true },
          mode: 'x',
        },
        pan: {
          enabled: true,
          mode: 'x',
        },
      },
    },
    scales: {
      x: { type: 'time', time: { unit: 'month' }, min: YEAR_START, grid: { color: GRID_COLOR }, ticks: { color: TICK_COLOR } },
      y: { position: 'left', grid: { color: GRID_COLOR }, ticks: { color: TICK_COLOR }, title: { display: true, text: 'reps', color: TICK_COLOR } },
      y1: { position: 'right', grid: { drawOnChartArea: false }, ticks: { color: TICK_COLOR }, title: { display: true, text: 'seconds', color: TICK_COLOR } },
    },
  }));

  // 17. Neck (Extension + Flexion)
  const neckExtData = liftData('neck extension');
  const neckFlexData = liftData('neck flexion');
  pending.push(createChart('neckChart', 'line', [
    { label: 'Neck Extension', data: neckExtData, ...liftDefaults(COLORS.red) },
    { label: '_neckExtTrend', data: linearTrendline(neckExtData), ...lineDefaults('rgba(255,107,107,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
    { label: 'Neck Flexion', data: neckFlexData, ...liftDefaults(COLORS.blue) },
    { label: '_neckFlexTrend', data: linearTrendline(neckFlexData), ...lineDefaults('rgba(74,158,255,0.3)'), pointRadius: 0, borderDash: [6, 3], tension: 0 },
  ], liftOpts('lbs')));

  // Populate all charts simultaneously so animations start in sync
  requestAnimationFrame(() => {
    for (const entry of pending) {
      if (!entry) continue;
      entry.chart.data.datasets = entry.datasets;
      entry.chart.options.animation = ANIMATION;
      entry.chart.update();
      entry.chart.canvas.closest('.chart-card')?.classList.remove('loading');
      // Double-click to reset zoom
      entry.chart.canvas.addEventListener('dblclick', () => entry.chart.resetZoom());
    }
  });
}

init();
