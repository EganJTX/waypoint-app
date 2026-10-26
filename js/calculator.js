// Pure projection engine — no DOM, no I/O. Ported and corrected from the
// Vertex42-based sheet per the Technical & Data Brief.
//
// Correction from the original sheet: the old Present Value pulled only 3 of
// 10 vehicles (hardcoded tax-deferred accounts) into the compounding base.
// Here the starting balance for projection is always SUM(Retirement Cash
// Value) across ALL vehicles — no hardcoded account list.

// How each vehicle is treated comes from the types table (js/vehicle-types.js),
// not from category names scattered through this file.
const VehicleTypes = require('./vehicle-types');
// Real US market years the simulation draws from (js/historical-returns.js).
const HistoricalReturns = require('./historical-returns');

// Not part of the projection: no balance, or a type that never counts (a
// protection-only policy such as term life, whose premium is a cost, not savings).
function isProtectionVehicle(vehicle) {
  return !vehicle.retirementCashValue || vehicle.retirementCashValue <= 0 ||
    VehicleTypes.growthOf(vehicle) === 'none';
}

// Market vehicles (growth: 'market') compound at the variable rates regardless
// of whether they have contributions. The rates apply to the balance.
function isInterestBearingVehicle(vehicle) {
  return VehicleTypes.growthOf(vehicle) === 'market';
}

// Contribution-only vehicles (growth: 'contributions') accumulate linearly via
// their contributions, not compounding at the rates.
function isNonInterestVehicle(vehicle) {
  return vehicle.retirementCashValue > 0 &&
    VehicleTypes.growthOf(vehicle) === 'contributions';
}

// Normalizes a vehicle's contribution to an annual figure regardless of
// stored period, so projection math has one common unit.
function annualContribution(vehicle) {
  if (!vehicle.contribution || !vehicle.period) return 0;
  if (vehicle.period === 'Monthly') return vehicle.contribution * 12;
  if (vehicle.period === 'Annually') return vehicle.contribution;
  return 0; // Ad-hoc: no presumed recurring cadence
}

// Deterministic pseudo-random helper so a given (vehicleId, year) pair always
// draws the same rate within a single server run — avoids the projection
// jittering between repeated reads of the same request.
function seededRate(seedStr, min, max) {
  let hash = 0;
  for (let i = 0; i < seedStr.length; i++) {
    hash = (hash * 31 + seedStr.charCodeAt(i)) >>> 0;
  }
  const unit = (hash % 10000) / 10000;
  return min + unit * (max - min);
}

// Projects one vehicle forward `years` years. Returns the projected balance
// at the end of that horizon; does not mutate the vehicle.
function projectVehicle(vehicle, years, rates) {
  const startBalance = vehicle.retirementCashValue || 0;

  if (isProtectionVehicle(vehicle)) {
    return 0; // excluded from the projection total entirely
  }

  if (isInterestBearingVehicle(vehicle)) {
    // Investment accounts: compound at variable rates. Contributions (if any)
    // are added each year and also compound. Ad-hoc accounts (no contribution)
    // still grow via compounding at the market rates.
    let balance = startBalance;
    const contrib = annualContribution(vehicle);
    for (let y = 0; y < years; y++) {
      const rate = seededRate(`${vehicle.id}:${y}`, rates.min, rates.max);
      balance = balance * (1 + rate) + contrib;
    }
    return balance;
  }

  if (isNonInterestVehicle(vehicle)) {
    // Insurance and Checking/Savings: linear accumulation only, no compounding.
    // Contributions add to the balance in a linear fashion.
    // If no contributions, balance stays stable.
    return startBalance + annualContribution(vehicle) * years;
  }

  // Fallback: unknown categories are carried forward flat
  return startBalance;
}

function projectVehicleAtRate(vehicle, years, flatRate) {
  const startBalance = vehicle.retirementCashValue || 0;
  if (isProtectionVehicle(vehicle)) return 0;

  if (isInterestBearingVehicle(vehicle)) {
    let balance = startBalance;
    const contrib = annualContribution(vehicle);
    for (let y = 0; y < years; y++) {
      balance = balance * (1 + flatRate) + contrib;
    }
    return balance;
  }
  if (isNonInterestVehicle(vehicle)) {
    return startBalance + annualContribution(vehicle) * years;
  }
  return startBalance;
}

// Projects the full portfolio `years` years forward. Returns totals plus
// per-vehicle detail, and a secondary "upside" total at rates.upside.
function projectPortfolio(vehicles, years, rates) {
  const detail = vehicles.map(v => ({
    id: v.id,
    vehicle: v.vehicle,
    company: v.company,
    category: v.category,
    excluded: isProtectionVehicle(v),
    startBalance: v.retirementCashValue || 0,
    projectedBalance: projectVehicle(v, years, rates),
    upsideBalance: projectVehicleAtRate(v, years, rates.upside),
  }));

  const startingBase = vehicles.reduce((sum, v) => sum + (v.retirementCashValue || 0), 0);
  const totalProjected = detail.reduce((sum, d) => sum + (d.excluded ? 0 : d.projectedBalance), 0);
  const totalUpside = detail.reduce((sum, d) => sum + (d.excluded ? 0 : d.upsideBalance), 0);
  const totalBenefit = vehicles.reduce((sum, v) => sum + (v.benefit || 0), 0);
  const protectionCost = vehicles
    .filter(isProtectionVehicle)
    .reduce((sum, v) => sum + annualContribution(v), 0);

  return {
    startingBase,
    totalProjected,
    totalUpside,
    totalBenefit,
    protectionCost,
    detail,
  };
}

// Given a destination number, solves for the age/year at which the
// projected balance first crosses it (bidirectional to the age->balance
// direction handled by projectPortfolio). Walks year by year using the
// same engine so both directions stay consistent.
function solveForYears(vehicles, destinationNumber, rates, maxYears = 60) {
  for (let years = 0; years <= maxYears; years++) {
    const { totalProjected } = projectPortfolio(vehicles, years, rates);
    if (totalProjected >= destinationNumber) {
      return years;
    }
  }
  return null; // does not cross within maxYears at these rates
}

// Optional 4%-rule helper — a secondary tool, never authoritative. Returns
// a suggested destination number plus the "why" reasoning to display next
// to it, same treatment as per-vehicle intention notes.
function computeDestinationNumberHelper(desiredAnnualIncome, socialSecurityEstimate) {
  const netIncomeNeeded = Math.max(0, (desiredAnnualIncome || 0) - (socialSecurityEstimate || 0));
  const suggested = netIncomeNeeded / 0.04;
  return {
    suggested,
    why: `Based on a desired annual income of $${(desiredAnnualIncome || 0).toLocaleString()} minus an estimated $${(socialSecurityEstimate || 0).toLocaleString()} from Social Security/pension, the remaining $${netIncomeNeeded.toLocaleString()}/yr divided by a 4% withdrawal rate suggests a starting-point destination number.`,
  };
}

// Converts a nominal future-dollar figure to its today's-buying-power
// equivalent given years and an assumed inflation rate.
function toTodaysDollars(nominal, years, inflationRate) {
  return nominal / Math.pow(1 + inflationRate, years);
}

// ── Monte Carlo ──────────────────────────────────────────────────────────
// Runs `trialCount` independent trials, each walking the portfolio forward
// year by year once (not re-deriving from year 0 each time — O(trials x
// years x vehicles), not O(trials x years^2 x vehicles)).
//
// Where the yearly returns come from: by default each trial replays real US
// market history (1928-2025, a 60/40 mix) in 5-year blocks picked at random,
// so a trial can contain a 1930s crash or a 1970s stall, and good and bad
// years cluster the way they do in life. Every market vehicle in a trial sees
// the same market year. With rates.mode 'custom' the user supplies their own
// expected return and yearly volatility instead, and each year is drawn from
// a bell-shaped (log-normal) spread around that.
//
// Trials are seeded on the trial number — deterministic, not Math.random() —
// so the same underlying vehicle data always reproduces the exact same trials
// and the exact same percentile bands. This is what makes the
// persisted-projection model work: recomputing later with unchanged data
// yields bit-identical results, so "stale until the next check-in" is a
// meaningful, honest state rather than an arbitrary one. A longer horizon
// extends the same trials rather than reshuffling them.
//
// Interest-bearing vehicles (Investment category) carry real trial-to-trial
// variance. Non-interest vehicles (Insurance, Checking/Savings) are linear
// regardless of trial. Every vehicle goes through its own type-appropriate
// rule each trial so totals stay consistent with projectPortfolio's
// single-path logic.

// Years of history drawn together (see js/historical-returns.js).
const BLOCK_YEARS = HistoricalReturns.BLOCK_YEARS;

// How many simulated futures each projection runs. At this count the median
// settles to within about 1% of what many more runs would give.
const TRIAL_COUNT = 1000;

// Small seeded random generator (mulberry32): same seed, same sequence.
function seededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One trial's yearly market returns: random 5-year blocks of history laid end
// to end until `years` is covered.
function historicalPath(trial, years) {
  const series = HistoricalReturns.BLENDED;
  const rand = seededRandom(Math.imul(trial + 1, 0x9E3779B1));
  const path = [];
  while (path.length < years) {
    const start = Math.floor(rand() * (series.length - BLOCK_YEARS + 1));
    for (let i = 0; i < BLOCK_YEARS && path.length < years; i++) {
      path.push(series[start + i]);
    }
  }
  return path;
}

function usesCustomRates(rates) {
  return HistoricalReturns.isCustomMode(rates);
}

// One trial's yearly returns for a user's own assumptions. Each year is a
// log-normal draw with the given average (expectedReturn) and typical swing
// (volatility), so a year can be bad but never loses more than 100%.
function customPath(trial, years, expectedReturn, volatility) {
  const rand = seededRandom(Math.imul(trial + 1, 0x9E3779B1));
  const growth = 1 + expectedReturn;
  const sigma2 = Math.log(1 + (volatility * volatility) / (growth * growth));
  const mu = Math.log(growth) - sigma2 / 2;
  const sigma = Math.sqrt(sigma2);
  const path = [];
  for (let y = 0; y < years; y++) {
    // Box-Muller: two uniform draws become one standard-normal draw.
    const z = Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
    path.push(Math.exp(mu + sigma * z) - 1);
  }
  return path;
}

// A single steady yearly rate for the per-vehicle breakdown, which only needs
// the vehicles' relative shape (the totals are scaled to the simulated median).
function steadyRate(rates) {
  if (usesCustomRates(rates)) return rates.expectedReturn;
  return HistoricalReturns.stats().expectedReturn;
}

// How the simulation was set up, for anything that has to explain it (the
// coach). Returns plain facts, not prose.
function describeBasis(rates) {
  if (usesCustomRates(rates)) {
    return {
      mode: 'custom',
      trials: TRIAL_COUNT,
      expectedReturn: rates.expectedReturn,
      volatility: rates.volatility,
    };
  }
  const h = HistoricalReturns.stats();
  return {
    mode: 'history',
    trials: TRIAL_COUNT,
    firstYear: h.firstYear,
    lastYear: h.lastYear,
    blockYears: BLOCK_YEARS,
    stockWeight: HistoricalReturns.STOCK_WEIGHT,
    expectedReturn: h.expectedReturn,
    volatility: h.volatility,
    worstYear: h.worstYear,
    bestYear: h.bestYear,
  };
}

//
// Alongside the balances it records what the market did in the first
// `statsYears` years of every trial (the years up to retirement), so the
// projection can show where its numbers come from: the average rate drawn,
// the compounded rate of the middle future, and how often a year lost money.
function runMonteCarlo(vehicles, horizonYears, rates, trialCount = TRIAL_COUNT, sampleCount = 25, statsYears = horizonYears) {
  const included = vehicles.filter(v => !isProtectionVehicle(v));
  const trials = []; // trials[t] = [balanceAtYear0, balanceAtYear1, ...]

  const custom = usesCustomRates(rates);
  const statYears = Math.min(Math.max(statsYears || horizonYears, 1), horizonYears);
  let rateSum = 0, rateCount = 0, lossYears = 0, worst = Infinity, best = -Infinity;
  const compounded = []; // each trial's compounded yearly market rate

  for (let t = 0; t < trialCount; t++) {
    const marketPath = custom
      ? customPath(t, horizonYears, rates.expectedReturn, rates.volatility)
      : historicalPath(t, horizonYears);
    let logGrowth = 0;
    for (let y = 0; y < statYears; y++) {
      const r = marketPath[y];
      rateSum += r; rateCount++;
      if (r < 0) lossYears++;
      if (r < worst) worst = r;
      if (r > best) best = r;
      logGrowth += Math.log(1 + r);
    }
    compounded.push(Math.exp(logGrowth / statYears) - 1);

    const balances = included.map(v => v.retirementCashValue || 0);
    const yearly = [balances.reduce((s, b) => s + b, 0)];

    for (let y = 0; y < horizonYears; y++) {
      included.forEach((v, i) => {
        if (isInterestBearingVehicle(v)) {
          balances[i] = balances[i] * (1 + marketPath[y]) + annualContribution(v);
        } else if (isNonInterestVehicle(v)) {
          balances[i] += annualContribution(v);
        }
        // other vehicles: flat, no change
      });
      yearly.push(balances.reduce((s, b) => s + b, 0));
    }
    trials.push(yearly);
  }

  const p20 = [], median = [], p80 = [];
  for (let y = 0; y <= horizonYears; y++) {
    const valuesAtYear = trials.map(trial => trial[y]).sort((a, b) => a - b);
    p20.push(percentile(valuesAtYear, 0.20));
    median.push(percentile(valuesAtYear, 0.50));
    p80.push(percentile(valuesAtYear, 0.80));
  }

  return {
    p20,
    median,
    p80,
    sampledPaths: trials.slice(0, sampleCount),
    marketStats: {
      years: statYears,
      averageRate: rateSum / rateCount,
      compoundMedianRate: percentile(compounded.sort((a, b) => a - b), 0.50),
      lossShare: lossYears / rateCount,
      worstYear: worst,
      bestYear: best,
    },
  };
}

// Linear-interpolated percentile of an already-sorted array.
function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const idx = p * (sortedValues.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const frac = idx - lo;
  return sortedValues[lo] * (1 - frac) + sortedValues[hi] * frac;
}

module.exports = {
  isProtectionVehicle,
  annualContribution,
  projectVehicle,
  projectPortfolio,
  solveForYears,
  computeDestinationNumberHelper,
  toTodaysDollars,
  runMonteCarlo,
  steadyRate,
  describeBasis,
  basisKey: HistoricalReturns.basisKey,
  DEFAULT_INFLATION: HistoricalReturns.DEFAULT_INFLATION,
  TRIAL_COUNT,
};
