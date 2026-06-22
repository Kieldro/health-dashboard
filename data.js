async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to fetch ${path}: ${res.status}`);
  return res.json();
}

export async function loadAllData() {
  const endpoints = [
    '/api/weight', '/api/bodyfat', '/api/dexa', '/api/measurements',
    '/api/rhr', '/api/hrv', '/api/activities', '/api/vo2max',
    '/api/workout-volume', '/api/lift-progression', '/api/workout-sets',
    '/api/hr-recovery', '/api/zone-minutes',
    '/api/sleep', '/api/steps', '/api/stress', '/api/body-battery',
    '/api/lactate-threshold',
  ];
  const results = await Promise.allSettled(endpoints.map(fetchJSON));
  const [weight, bodyfat, dexa, measurements, rhr, hrv, activities, vo2max, workoutVolume, liftProgression, workoutSets, hrRecovery, zoneMinutes, sleep, steps, stress, bodyBattery, lactateThreshold] = results.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.warn(`Failed to load ${endpoints[i]}:`, r.reason);
    return [];
  });

  return {
    weight: processWeight(weight),
    bodyFat: processBodyFat(bodyfat, measurements, dexa),
    bodyMeasurements: processMeasurements(measurements),
    rhr,
    hrv,
    runs: processRuns(activities),
    vo2max,
    workoutVolume,
    liftProgression: processLiftProgression(liftProgression),
    workoutSets: processWorkoutSets(workoutSets),
    hrRecovery,
    zoneMinutes,
    sleep: processSleep(sleep),
    steps,
    stress,
    bodyBattery,
    lactateThreshold,  // [{date, lthr, pace, ftp}] — chart-ready from serve.py
  };
}

// --- Sleep ---
function processSleep(rows) {
  // Convert SQLite TIME minutes → hours (1 decimal) for the stage-stacked chart.
  const toH = (min) => (min == null ? null : Math.round(min / 6) / 10);
  return rows.map(r => ({
    date: r.date,
    totalH: toH(r.total),
    deepH: toH(r.deep),
    lightH: toH(r.light),
    remH: toH(r.rem),
    awakeH: toH(r.awake),
    score: r.score,
    spo2: r.spo2,
  }));
}

// --- Weight ---
function processWeight(rows) {
  // Calendar-day-based moving averages (not entry-based)
  const calendarMA = (i, days) => {
    // rows[i].date is "YYYY-MM-DD" parsed as UTC midnight, so step the cutoff
    // back with UTC accessors. Local getDate/setDate civil-shift across a DST
    // boundary and widen the window by a day (getWeeklyMileage avoids the same
    // trap with getUTCDay). Null weights are skipped so one bad row can't drag
    // the average toward zero.
    const cutoff = new Date(rows[i].date);
    cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const window = [];
    for (let j = i; j >= 0; j--) {
      if (rows[j].date < cutoffStr) break;
      if (rows[j].weight != null) window.push(rows[j].weight);
    }
    return window.length
      ? Math.round((window.reduce((a, b) => a + b, 0) / window.length) * 10) / 10
      : null;
  };
  return rows.map((d, i) => ({ ...d, ma7: calendarMA(i, 7), ma30: calendarMA(i, 30) }));
}

// --- Body Fat ---
function processBodyFat(bodyfat, measurements, dexa) {
  // Navy BF% from measurements (neck + stomach = abdomen at navel, height = 72 inches)
  const HEIGHT_IN = 72;
  const navy = measurements
    .filter(m => m.neck && m.stomach)
    .map(m => {
      const bf = 86.010 * Math.log10(m.stomach - m.neck) - 70.041 * Math.log10(HEIGHT_IN) + 36.76;
      return { date: m.date, navy: Math.round(bf * 10) / 10 };
    });

  return {
    renpho: bodyfat.map(d => ({ date: d.date, renpho: d.bodyfat })),
    navy,
    dexa: dexa.map(d => ({ date: d.date, dexa: d.bodyfat })),
  };
}

// --- Body Measurements ---
function processMeasurements(measurements) {
  return measurements.filter(m => m.stomach || m.waist || m.neck || m.chest || m.hips || m.right_bicep || m.right_forearm || m.right_quad || m.right_calf);
}

// --- Running ---
function processRuns(activities) {
  const runs = activities
    .filter(a => {
      if (!(a.distance > 0 && a.duration > 0 && a.avg_hr > 0)) return false;
      // Exclude walks logged in running_activities (it has no sport column).
      // A run sustains avg HR ≥ 110 and pace ≤ 18 min/mi; verified against
      // history that nothing faster than 12 min/mi has HR < 110, so this cuts
      // zero real runs while dropping 20–35 min/mi strolls (see CLAUDE.md).
      const paceMinMi = (a.duration / 60) / (a.distance / 1609.344);
      return a.avg_hr >= 110 && paceMinMi <= 18;
    })
    .map(a => {
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
    // r.date is "YYYY-MM-DD" (UTC midnight) and weekKey is derived via
    // toISOString() (UTC), so bucket with UTC accessors (local ones civil-shift
    // the instant back a day in western timezones). Weeks run Saturday→Friday:
    // step back to the most recent Saturday.
    const d = new Date(r.date);
    const back = (d.getUTCDay() + 1) % 7;  // getUTCDay: Sun=0…Sat=6 → days since Saturday
    const weekStart = new Date(d);
    weekStart.setUTCDate(d.getUTCDate() - back);
    const weekKey = weekStart.toISOString().split('T')[0];
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

// --- Per-Set Workout Data ---
function processWorkoutSets(rows) {
  const byExercise = {};
  for (const r of rows) {
    if (!byExercise[r.exercise]) byExercise[r.exercise] = [];
    byExercise[r.exercise].push({ week: r.week, weight: r.weight, reps: r.reps });
  }
  return byExercise;
}
