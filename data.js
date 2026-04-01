async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.json();
}

export async function loadAllData() {
  const [weight, bodyfat, measurements, rhr, hrv, activities, vo2max, workoutVolume, liftProgression] = await Promise.all([
    fetchJSON('/api/weight'),
    fetchJSON('/api/bodyfat'),
    fetchJSON('/api/measurements'),
    fetchJSON('/api/rhr'),
    fetchJSON('/api/hrv'),
    fetchJSON('/api/activities'),
    fetchJSON('/api/vo2max'),
    fetchJSON('/api/workout-volume'),
    fetchJSON('/api/lift-progression'),
  ]);

  return {
    weight: processWeight(weight),
    bodyFat: processBodyFat(bodyfat, measurements),
    bodyMeasurements: processMeasurements(measurements),
    rhr,
    hrv,
    runs: processRuns(activities),
    vo2max,
    workoutVolume,
    liftProgression: processLiftProgression(liftProgression),
  };
}

// --- Weight ---
function processWeight(rows) {
  // 7-day moving average
  const ma7 = movingAverage(rows.map(d => d.weight), 7);
  return rows.map((d, i) => ({ ...d, ma7: ma7[i] }));
}

// --- Body Fat ---
function processBodyFat(bodyfat, measurements) {
  // Navy BF% from measurements (neck + waist, height = 72 inches for 6'0")
  const HEIGHT_IN = 72;
  const navy = measurements
    .filter(m => m.neck && m.waist)
    .map(m => {
      const bf = 86.010 * Math.log10(m.waist - m.neck) - 70.041 * Math.log10(HEIGHT_IN) + 36.76;
      return { date: m.date, navy: Math.round(bf * 10) / 10 };
    });

  return {
    renpho: bodyfat.map(d => ({ date: d.date, renpho: d.bodyfat })),
    navy,
  };
}

// --- Body Measurements ---
function processMeasurements(measurements) {
  return measurements.filter(m => m.stomach || m.waist || m.neck);
}

// --- Running ---
function processRuns(activities) {
  const runs = activities.map(a => {
    const distMi = a.distance / 1609.344;
    const durationMin = a.duration / 60;
    const paceMinMi = durationMin / distMi;
    const speedMph = distMi / (durationMin / 60);
    const ef = speedMph / a.avg_hr;
    return {
      date: a.date,
      distMi: Math.round(distMi * 100) / 100,
      durationMin: Math.round(durationMin * 10) / 10,
      paceMinMi: Math.round(paceMinMi * 100) / 100,
      avgHR: a.avg_hr,
      maxHR: a.max_hr,
      speedMph,
      ef: Math.round(ef * 10000) / 10000,
    };
  });

  return {
    all: runs,
    fiveK: runs.filter(r => r.distMi >= 2.8 && r.distMi <= 3.5 && r.paceMinMi >= 8 && r.paceMinMi <= 12),
    longRuns: runs.filter(r => r.distMi >= 5),
    weeklyMileage: getWeeklyMileage(runs),
  };
}

function getWeeklyMileage(runs) {
  const byWeek = new Map();
  for (const r of runs) {
    const d = new Date(r.date);
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

// --- Lift Progression ---
function processLiftProgression(rows) {
  const byExercise = {};
  for (const r of rows) {
    if (!byExercise[r.exercise]) byExercise[r.exercise] = [];
    byExercise[r.exercise].push({
      date: r.week,
      weight: r.top_weight,
      reps: r.top_reps,
      maxReps: r.max_reps,
    });
  }
  return byExercise;
}

// --- Utilities ---
function movingAverage(values, window) {
  return values.map((_, i) => {
    const start = Math.max(0, i - window + 1);
    const slice = values.slice(start, i + 1);
    return Math.round((slice.reduce((a, b) => a + b, 0) / slice.length) * 10) / 10;
  });
}
