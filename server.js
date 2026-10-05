const express = require('express');
const fs = require('fs');
const path = require('path');
const calculator = require('./js/calculator');
const VehicleTypes = require('./js/vehicle-types');

const app = express();

// The parent macro server assigns this via env var when it spawns this
// process. Falls back to 3003 for running waypoint-app standalone
// (node server.js) during development — see plan notes: 3001/3002 are
// already claimed by job-tracker/trim-app in the parent's DYNAMIC_APPS list.
const PORT = process.env.PORT || 3003;
const SLUG = 'waypoint-app';

app.use(express.json({ limit: '10mb' }));

const CONFIG_PATH = path.join(__dirname, 'config.json');
const DATA_PATH = path.join(__dirname, 'data.json');

// ── Bootstrap real (gitignored) config from the committed example template ──
// Only runs when config.json doesn't exist yet (a fresh clone) — never
// touches or overwrites a real config.json that's already there.
if (!fs.existsSync(CONFIG_PATH) && fs.existsSync(path.join(__dirname, 'config.example.json'))) {
  fs.copyFileSync(path.join(__dirname, 'config.example.json'), CONFIG_PATH);
  console.log('config.json not found — created from config.example.json');
}

const EMPTY_DATA = { vehicles: [], snapshots: [], assessments: [], currentProjection: null };

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readData() {
  const data = readJson(DATA_PATH, EMPTY_DATA);
  if (!Array.isArray(data.vehicles)) data.vehicles = [];
  if (!Array.isArray(data.snapshots)) data.snapshots = [];
  if (!Array.isArray(data.assessments)) data.assessments = [];
  return data;
}

// ── Config persistence ────────────────────────────────────────────────────
app.get(`/${SLUG}/api/config`, (req, res) => {
  res.json(readJson(CONFIG_PATH, null));
});

app.post(`/${SLUG}/api/config`, (req, res) => {
  // Guards against silently wiping the whole file — an empty/malformed
  // body (e.g. a client bug, a dropped request) parses to {} rather than
  // failing, and writing that straight through would erase real config.
  const body = req.body;
  const looksValid = body && typeof body === 'object' &&
    'household' in body && 'destinationNumber' in body && 'targetRetirementAge' in body;
  if (!looksValid) {
    return res.status(400).json({ error: 'Refusing to write an incomplete config body' });
  }
  try {
    writeJson(CONFIG_PATH, body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to write config' });
  }
});

// ── Data persistence (vehicles + snapshots + assessments + the persisted
// current-projection cache, one document) ──────────────────────────────────
// Note: saving vehicles/config here does NOT recompute currentProjection —
// see the projection section below for why that's deliberate.
app.get(`/${SLUG}/api/data`, (req, res) => {
  res.json(readData());
});

app.post(`/${SLUG}/api/data`, (req, res) => {
  try {
    const incoming = req.body || {};
    const existing = readJson(DATA_PATH, EMPTY_DATA);
    writeJson(DATA_PATH, {
      vehicles: Array.isArray(incoming.vehicles) ? incoming.vehicles : [],
      snapshots: Array.isArray(incoming.snapshots) ? incoming.snapshots : [],
      assessments: Array.isArray(incoming.assessments) ? incoming.assessments : [],
      // Preserve whatever was last computed — a plain vehicle/data save
      // should never silently wipe the persisted projection.
      currentProjection: existing.currentProjection || null,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to write data' });
  }
});

// ── Projection — computed at specific moments, persisted, not recomputed
// on every read ─────────────────────────────────────────────────────────────
//
// This is a deliberate exception to "derived values are computed on read,
// never stored": a live recompute-on-every-request design has no memory,
// so it can never answer "what did we predict last time?" — which is
// exactly what the assessment log needs for real prediction-vs-outcome
// comparison later. Instead, the projection (deterministic path + Monte
// Carlo bands) is computed once at a specific, meaningful moment — a
// check-in — and persisted until the next one. Trial seeding is
// deterministic (vehicleId, trial, year), not Math.random(), so recomputing
// with unchanged data always reproduces the exact same numbers: nothing
// here is a moving target except in response to a real change.
function ageFromDob(dob) {
  if (!dob) return null;
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const monthDiff = now.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

function computeProjection(config, data) {
  const primary = config.household && config.household[0];
  const currentAge = primary ? ageFromDob(primary.dateOfBirth) : null;
  const targetRetirementAge = config.targetRetirementAge || 0;
  const yearsToRetirement = currentAge != null
    ? Math.max(0, targetRetirementAge - currentAge)
    : 0;

  const rates = config.projectionRates || { min: 0.04, max: 0.10, upside: 0.08 };

  const inflationRate = config.inflationRate != null ? config.inflationRate : 0.025;

  // Run Monte Carlo for a wide horizon first to find the crossing using median (not old projectPortfolio)
  const initialHorizon = currentAge != null ? Math.min(100 - currentAge, 60) : 60;
  const monteCarloForSolving = calculator.runMonteCarlo(data.vehicles, initialHorizon, rates, 250, 25);

  // Find when median crosses the destination number
  let solvedYears = null;
  const destination = config.destinationNumber || 0;
  if (destination > 0) {
    for (let y = 0; y <= initialHorizon; y++) {
      if (monteCarloForSolving.median[y] >= destination) {
        solvedYears = y;
        break;
      }
    }
  }
  const solvedAge = (solvedYears != null && currentAge != null) ? currentAge + solvedYears : null;

  // Horizon: show at least as far as the later of "desired age" or "the age
  // the projection actually crosses the target," plus a flat 5-year pad so
  // the crossing point isn't jammed against the chart's right edge. Floored
  // at a 10-year span, capped at age 100 — a chart cutting off before a real
  // crossing point would hide the one fact that matters most.
  let horizonYears;
  if (currentAge != null) {
    const solverFallbackAge = currentAge + 60;
    const laterAge = Math.max(targetRetirementAge, solvedAge != null ? solvedAge : solverFallbackAge);
    horizonYears = Math.max(laterAge + 5 - currentAge, 10);
    horizonYears = Math.min(horizonYears, 100 - currentAge);
  } else {
    horizonYears = 30;
  }

  const currentYear = new Date().getFullYear();
  // If we need more years than our initial horizon, run again with the full horizon
  const monteCarlo = horizonYears > initialHorizon
    ? calculator.runMonteCarlo(data.vehicles, horizonYears, rates, 250, 25)
    : monteCarloForSolving;

  const series = [];
  for (let y = 0; y <= horizonYears; y++) {
    series.push({
      year: currentYear + y,
      age: currentAge != null ? currentAge + y : null,
      value: monteCarlo.median[y],
    });
  }


  const medianAtRetirement = monteCarlo.median[yearsToRetirement];
  const todaysDollars = calculator.toTodaysDollars(medianAtRetirement, yearsToRetirement, inflationRate);


  // Use detail from the vehicles directly
  const detailWithMedian = data.vehicles.map(v => {
    const startBalance = v.retirementCashValue || 0;
    // No cash value means not part of the projection. A protection-only
    // policy (term life) has a premium but no balance, and must never be
    // counted as an account. One rule, shared with the simulation.
    const isExcluded = calculator.isProtectionVehicle(v);

    // How this vehicle grows comes from the types table (js/vehicle-types.js).
    const vehicleType = VehicleTypes.typeOf(v);
    let projectedBalance = startBalance;
    if (vehicleType.growth === 'market') {
      let balance = startBalance;
      const contrib = v.contribution && (v.period === 'Monthly' ? v.contribution * 12 : v.period === 'Annually' ? v.contribution : 0) || 0;
      for (let y = 0; y < yearsToRetirement; y++) {
        const rate = calculator.seededRate ? calculator.seededRate(`${v.id}:${y}`, rates.min, rates.max) : (rates.min + rates.max) / 2;
        balance = balance * (1 + rate) + contrib;
      }
      projectedBalance = balance;
    } else if (vehicleType.growth === 'contributions') {
      const contrib = v.contribution && (v.period === 'Monthly' ? v.contribution * 12 : v.period === 'Annually' ? v.contribution : 0) || 0;
      projectedBalance = startBalance + contrib * yearsToRetirement;
    }

    return {
      id: v.id,
      vehicle: v.vehicle,
      company: v.company,
      // The parent group, so the donut and the scaling below group as before.
      category: VehicleTypes.groupOf(v),
      type: vehicleType.id,
      typeLabel: vehicleType.label,
      moneyRole: vehicleType.moneyRole,
      excluded: isExcluded,
      startBalance,
      projectedBalance,
      upsideBalance: startBalance,
      // Context for the coach, which lists protection-only policies separately.
      benefit: v.benefit || 0,
      annualContribution: calculator.annualContribution(v),
    };
  });

  // Calculate totals of stable and deterministic (Insurance) categories
  const stableCategories = new Set(['Other']); // Only 'Other' is truly stable/flat
  const stableTotal = detailWithMedian
    .filter(v => !v.excluded && stableCategories.has(v.category))
    .reduce((sum, v) => sum + v.startBalance, 0);

  const insuranceTotal = detailWithMedian
    .filter(v => !v.excluded && v.category === 'Insurance')
    .reduce((sum, v) => sum + v.projectedBalance, 0);

  const checkingSavingsTotal = detailWithMedian
    .filter(v => !v.excluded && v.category === 'Checking/Savings')
    .reduce((sum, v) => sum + v.projectedBalance, 0);

  // Investment is the only variable category; scale it to fit the median
  const investmentDeterministic = detailWithMedian
    .filter(v => !v.excluded && v.category === 'Investment')
    .reduce((sum, v) => sum + v.projectedBalance, 0);

  const targetInvestmentTotal = medianAtRetirement - stableTotal - insuranceTotal - checkingSavingsTotal;
  const investmentScale = investmentDeterministic > 0 ? targetInvestmentTotal / investmentDeterministic : 1;

  const scaledDetail = detailWithMedian.map(v => {
    if (v.excluded) return v;
    if (stableCategories.has(v.category)) {
      return { ...v, projectedBalance: v.startBalance };
    }
    if (v.category === 'Insurance') {
      return v; // Insurance is deterministic, not scaled
    }
    if (v.category === 'Investment') {
      return { ...v, projectedBalance: v.projectedBalance * investmentScale };
    }
    return v;
  });

  const totalAnnualContribution = data.vehicles.reduce(
    (sum, v) => sum + calculator.annualContribution(v), 0
  );

  let destinationHelper = null;
  if (config.destinationNumberHelper && config.destinationNumberHelper.useHelper) {
    destinationHelper = calculator.computeDestinationNumberHelper(
      config.destinationNumberHelper.desiredAnnualIncome,
      config.destinationNumberHelper.socialSecurityEstimate
    );
  }

  // Calculate detail for all three percentiles (p20, median, p80)
  const p20AtRetirement = monteCarlo.p20[yearsToRetirement] || 0;
  const p80AtRetirement = monteCarlo.p80[yearsToRetirement] || 0;

  const createDetailForPercentile = (percentileTotal) => {
    // Deterministic amounts that don't scale: Other (flat) + Insurance (linear) + Checking/Savings (linear)
    const stableTotal = detailWithMedian
      .filter(v => !v.excluded && v.category === 'Other')
      .reduce((sum, v) => sum + v.startBalance, 0);

    const insuranceTotal = detailWithMedian
      .filter(v => !v.excluded && v.category === 'Insurance')
      .reduce((sum, v) => sum + v.projectedBalance, 0);

    const checkingSavingsTotal = detailWithMedian
      .filter(v => !v.excluded && v.category === 'Checking/Savings')
      .reduce((sum, v) => sum + v.projectedBalance, 0);

    const targetInvestmentTotal = percentileTotal - stableTotal - insuranceTotal - checkingSavingsTotal;
    const investmentDeterministic = detailWithMedian
      .filter(v => !v.excluded && v.category === 'Investment')
      .reduce((sum, v) => sum + v.projectedBalance, 0);

    const investmentScale = investmentDeterministic > 0 ? targetInvestmentTotal / investmentDeterministic : 1;

    return detailWithMedian.map(v => {
      if (v.excluded) return v;
      if (v.category === 'Other') {
        return { ...v, projectedBalance: v.startBalance };
      }
      if (v.category === 'Insurance') {
        return v; // Deterministic, not scaled
      }
      if (v.category === 'Investment') {
        return { ...v, projectedBalance: v.projectedBalance * investmentScale };
      }
      return v;
    });
  };

  const startingBase = data.vehicles.reduce((sum, v) => sum + (v.retirementCashValue || 0), 0);
  const totalBenefit = data.vehicles.reduce((sum, v) => sum + (v.benefit || 0), 0);
  const protectionCost = data.vehicles
    .filter(calculator.isProtectionVehicle)
    .reduce((sum, v) => {
      const contrib = v.contribution && (v.period === 'Monthly' ? v.contribution * 12 : v.period === 'Annually' ? v.contribution : 0) || 0;
      return sum + contrib;
    }, 0);

  return {
    computedAt: new Date().toISOString(),
    currentAge,
    yearsToRetirement,
    targetRetirementAge,
    destinationNumber: config.destinationNumber || 0,
    startingBase,
    totalProjected: series[yearsToRetirement].value,
    totalUpside: series[yearsToRetirement].value,
    totalBenefit,
    protectionCost,
    gap: series[yearsToRetirement].value - (config.destinationNumber || 0),
    todaysDollars,
    solvedAge,
    detail: scaledDetail,
    detail_p20: p20AtRetirement > 0 ? createDetailForPercentile(p20AtRetirement) : scaledDetail,
    detail_p80: p80AtRetirement > 0 ? createDetailForPercentile(p80AtRetirement) : scaledDetail,
    destinationHelper,
    series,
    monteCarlo,
    totalAnnualContribution,
  };
}

function recomputeAndPersistProjection() {
  const config = readJson(CONFIG_PATH, null);
  const data = readData();
  if (!config) return null;
  const projection = computeProjection(config, data);
  data.currentProjection = projection;
  writeJson(DATA_PATH, data);
  return projection;
}

// Reads the persisted projection. Bootstraps it once, lazily, if it has
// never been computed yet (a fresh install, or data.json predating this
// field) — after that, only a check-in recomputes it.
app.get(`/${SLUG}/api/projection`, (req, res) => {
  const data = readData();
  if (data.currentProjection) {
    return res.json(data.currentProjection);
  }
  const projection = recomputeAndPersistProjection();
  if (!projection) return res.status(500).json({ error: 'No config found' });
  res.json(projection);
});

// Explicitly triggers a fresh recompute — called by the client at check-in
// time (the one moment this app treats as "the facts changed enough to
// re-derive the plan"), never on plain reads.
app.post(`/${SLUG}/api/projection/recompute`, (req, res) => {
  const projection = recomputeAndPersistProjection();
  if (!projection) return res.status(500).json({ error: 'No config found' });
  res.json(projection);
});

// ── Coach analysis — agentic weekly insights ─────────────────────────────────
// Collects user concerns + current projection, spawns Claude for recommendations
const { runCoachAnalysis } = require('./scripts/coach-analyze');
const { readAnalyses } = require('./scripts/coach-shared');
const COACH_ANALYSES_PATH = path.join(__dirname, 'coachAnalyses.json');

app.get(`/${SLUG}/api/coach-analyses`, (req, res) => {
  res.json(readAnalyses(COACH_ANALYSES_PATH));
});

app.post(`/${SLUG}/api/projection/coach-analyze`, async (req, res) => {
  try {
    const { userConcerns } = req.body || {};
    const config = readJson(CONFIG_PATH, null);
    const data = readData();
    const projection = data.currentProjection;

    if (!config || !projection) {
      return res.status(400).json({ error: 'No config or projection found — run a check-in first' });
    }

    const result = await runCoachAnalysis({
      configPath: CONFIG_PATH,
      analysesPath: COACH_ANALYSES_PATH,
      projectionData: projection,
      userConcerns: userConcerns || ''
    });

    if (!result.ok) return res.status(result.status || 500).json(result);
    res.json(result);
  } catch (err) {
    console.error('Coach analysis error:', err);
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

// ── Static assets ───────────────────────────────────────────────────────────
app.use(`/${SLUG}`, express.static(__dirname));

// Verify Claude CLI is available on startup
const { execSync } = require('child_process');
try {
  execSync('claude --version', { stdio: 'pipe' });
  console.log('[startup] ✓ Claude CLI is available');
} catch (e) {
  console.error('[startup] ✗ Claude CLI not found! Make sure "claude" command is in your PATH.');
  console.error('[startup] Run: npm install -g @anthropic-ai/claude-code');
  console.error('[startup] Or authenticate: claude');
}

const server = app.listen(PORT, () => {
  console.log(`Waypoint running at http://localhost:${PORT}/${SLUG}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[waypoint-app] port ${PORT} is already in use.`);
  } else {
    console.error('[waypoint-app] failed to start:', err);
  }
});
