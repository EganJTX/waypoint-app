// Pure projection engine — no DOM, no I/O. Ported and corrected from the
// Vertex42-based sheet per the Technical & Data Brief.
//
// Correction from the original sheet: the old Present Value pulled only 3 of
// 10 vehicles (hardcoded tax-deferred accounts) into the compounding base.
// Here the starting balance for projection is always SUM(Retirement Cash
// Value) across ALL vehicles — no hardcoded account list.

function isProtectionVehicle(vehicle) {
  return !vehicle.retirementCashValue || vehicle.retirementCashValue <= 0;
}

// Interest-bearing vehicles (Investment category) compound at the variable rates
// regardless of whether they have contributions. The rates apply to the balance.
function isInterestBearingVehicle(vehicle) {
  return vehicle.category === 'Investment';
}

// Non-interest vehicles (Insurance, Checking/Savings) grow only via contributions,
// linear accumulation, not compounding at the rates.
function isNonInterestVehicle(vehicle) {
  return vehicle.retirementCashValue > 0 &&
    (vehicle.category === 'Insurance' || vehicle.category === 'Checking/Savings');
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
// Trials are seeded on (vehicleId, trial, year) — deterministic, not
// Math.random() — so the same underlying vehicle data always reproduces
// the exact same 250 trials and the exact same percentile bands. This is
// what makes the persisted-projection model work: recomputing later with
// unchanged data yields bit-identical results, so "stale until the next
// check-in" is a meaningful, honest state rather than an arbitrary one.
//
// Interest-bearing vehicles (Investment category) carry real trial-to-trial
// variance at the variable rates. Non-interest vehicles (Insurance,
// Checking/Savings) are linear regardless of trial. Every vehicle goes
// through its own type-appropriate rule each trial so totals stay consistent
// with projectPortfolio's single-path logic.
function runMonteCarlo(vehicles, horizonYears, rates, trialCount = 250, sampleCount = 25) {
  const included = vehicles.filter(v => !isProtectionVehicle(v));
  const trials = []; // trials[t] = [balanceAtYear0, balanceAtYear1, ...]

  for (let t = 0; t < trialCount; t++) {
    const balances = included.map(v => v.retirementCashValue || 0);
    const yearly = [balances.reduce((s, b) => s + b, 0)];

    for (let y = 0; y < horizonYears; y++) {
      included.forEach((v, i) => {
        if (isInterestBearingVehicle(v)) {
          const rate = seededRate(`${v.id}:${t}:${y}`, rates.min, rates.max);
          balances[i] = balances[i] * (1 + rate) + annualContribution(v);
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
};
