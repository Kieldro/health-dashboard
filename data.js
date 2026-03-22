const DATA_BASE = '/data';

async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.json();
}

export async function loadAllData() {
  const [unified, renpho, measurements, activities] = await Promise.all([
    fetchJSON(`${DATA_BASE}/unified_daily.json`),
    fetchJSON(`${DATA_BASE}/renpho_raw.json`),
    fetchJSON(`${DATA_BASE}/measurements.json`),
    fetchJSON(`${DATA_BASE}/activities.json`),
  ]);

  return {
    weight: processWeight(unified, renpho),
    bodyFat: processBodyFat(renpho, measurements),
    bodyMeasurements: processMeasurements(measurements),
    rhr: processRHR(unified),
    hrv: processHRV(unified),
    runs: processRuns(activities),
  };
}

// --- Weight ---
function processWeight(unified, renpho) {
  // Merge renpho weights (kg->lbs) and unified scale weights by date
  const byDate = new Map();

  for (const r of renpho) {
    const date = r.localCreatedAt.split(' ')[0];
    const lbs = r.weight * 2.20462;
    // Keep latest per day
    if (!byDate.has(date) || byDate.get(date).ts < r.timeStamp) {
      byDate.set(date, { lbs, ts: r.timeStamp });
    }
  }

  for (const d of unified) {
    if (d.scale?.weight_lbs) {
      const date = d.date;
      if (!byDate.has(date)) {
        byDate.set(date, { lbs: d.scale.weight_lbs, ts: 0 });
      }
    }
  }

  const sorted = [...byDate.entries()]
    .map(([date, v]) => ({ date, weight: Math.round(v.lbs * 10) / 10 }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 7-day moving average
  const ma7 = movingAverage(sorted.map(d => d.weight), 7);

  return sorted.map((d, i) => ({ ...d, ma7: ma7[i] }));
}

// --- Body Fat ---
function processBodyFat(renpho, measurements) {
  // Renpho BF%
  const renphoByDate = new Map();
  for (const r of renpho) {
    if (!r.bodyfat || r.bodyfat === 0) continue;
    const date = r.localCreatedAt.split(' ')[0];
    if (!renphoByDate.has(date) || renphoByDate.get(date).ts < r.timeStamp) {
      renphoByDate.set(date, { bf: r.bodyfat, ts: r.timeStamp });
    }
  }
  const renphoBF = [...renphoByDate.entries()]
    .map(([date, v]) => ({ date, renpho: v.bf }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Navy BF% from measurements (needs neck, waist, height=72 inches for 6'0")
  const HEIGHT_IN = 72;
  const navyBF = measurements
    .filter(m => m.neck && m.waist)
    .map(m => {
      // Navy formula for men: 86.010 * log10(waist - neck) - 70.041 * log10(height) + 36.76
      const bf = 86.010 * Math.log10(m.waist - m.neck) - 70.041 * Math.log10(HEIGHT_IN) + 36.76;
      return { date: m.date, navy: Math.round(bf * 10) / 10 };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  return { renpho: renphoBF, navy: navyBF };
}

// --- Body Measurements ---
function processMeasurements(measurements) {
  return measurements
    .filter(m => m.stomach || m.waist)
    .map(m => ({
      date: m.date,
      stomach: m.stomach || null,
      waist: m.waist || null,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// --- Resting Heart Rate ---
function processRHR(unified) {
  return unified
    .filter(d => d.garmin?.rhr)
    .map(d => ({ date: d.date, rhr: d.garmin.rhr }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// --- HRV ---
function processHRV(unified) {
  return unified
    .filter(d => d.sleep?.hrv_overnight_avg)
    .map(d => ({ date: d.date, hrv: d.sleep.hrv_overnight_avg }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// --- Running ---
function processRuns(activities) {
  const runs = activities
    .filter(a => a.activityType?.typeKey === 'running' && a.distance && a.duration && a.averageHR)
    .map(a => {
      const distMi = a.distance / 1609.344;
      const durationMin = a.duration / 60;
      const paceMinMi = durationMin / distMi;
      const speedMph = distMi / (durationMin / 60);
      const ef = speedMph / a.averageHR; // efficiency factor
      return {
        date: a.startTimeLocal.split(' ')[0],
        distMi: Math.round(distMi * 100) / 100,
        durationMin: Math.round(durationMin * 10) / 10,
        paceMinMi: Math.round(paceMinMi * 100) / 100,
        avgHR: a.averageHR,
        maxHR: a.maxHR,
        speedMph,
        ef: Math.round(ef * 10000) / 10000,
        name: a.activityName || '',
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    all: runs,
    fiveK: get5KRuns(runs),
    longRuns: getLongRuns(runs),
    weeklyMileage: getWeeklyMileage(runs),
  };
}

function get5KRuns(runs) {
  // ~3.1 mi, ~10 min/mi pace
  return runs.filter(r => r.distMi >= 2.8 && r.distMi <= 3.5 && r.paceMinMi >= 8 && r.paceMinMi <= 12);
}

function getLongRuns(runs) {
  // Runs >= 5 miles
  return runs.filter(r => r.distMi >= 5);
}

function getWeeklyMileage(runs) {
  const byWeek = new Map();
  for (const r of runs) {
    const d = new Date(r.date);
    // Get Monday of that week
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d);
    monday.setDate(diff);
    const weekKey = monday.toISOString().split('T')[0];
    byWeek.set(weekKey, (byWeek.get(weekKey) || 0) + r.distMi);
  }
  return [...byWeek.entries()]
    .map(([week, miles]) => ({ week, miles: Math.round(miles * 10) / 10 }))
    .sort((a, b) => a.week.localeCompare(b.week));
}

// --- Utilities ---
function movingAverage(values, window) {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    return Math.round((slice.reduce((a, b) => a + b, 0) / slice.length) * 10) / 10;
  });
}
