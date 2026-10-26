// Shared helpers for coach analyses — reading/writing coachAnalyses.json
// and building the profile section of the prompt.
// Kept separate from coach-analyze.js so storage rules (rolling window, upsert by date)
// are in one place and easy to reason about independent of the Claude call.

const fs = require('fs');
const calculator = require('../js/calculator');

const MAX_RETAINED_ANALYSES = 12; // how many assessed analyses to keep for browsing
const ANALYSES_FED_INTO_PROMPT = 3; // how many of those get fed back into a new analysis

function readAnalyses(analysesPath) {
  if (!fs.existsSync(analysesPath)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(analysesPath, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

// Sorted ascending by generatedAt — "latest" is always the last element
function sortByDate(entries) {
  return [...entries].sort((a, b) => {
    const dateA = new Date(a.generatedAt).getTime();
    const dateB = new Date(b.generatedAt).getTime();
    return dateA - dateB;
  });
}

// Insert or replace the entry for today (on the same basis), then trim to the
// retained window. An analysis made today on a different basis is kept: it is
// a different read of a different set of numbers, not a redo.
function upsertAnalysis(analysesPath, entry) {
  const existing = readAnalyses(analysesPath);
  const today = new Date().toISOString().slice(0, 10);
  const withoutToday = existing.filter(
    e => e.generatedAt.slice(0, 10) !== today || e.basisKey !== entry.basisKey
  );
  const merged = sortByDate([...withoutToday, entry]);
  const trimmed = merged.slice(-MAX_RETAINED_ANALYSES);
  fs.writeFileSync(analysesPath, JSON.stringify(trimmed, null, 2), 'utf8');
  return trimmed;
}

// The last N analyses in date order (verdict + recommendations only, never
// fullReport, so the prompt doesn't grow unbounded).
//
// Only analyses written on the same basis as today's projection are returned,
// and only for US history. Their dollar figures and reasoning are comparable
// then. With the user's own assumptions each read stands alone, and analyses
// written before bases were recorded (no basisKey) never qualify.
function recentAnalysesFor(analysesPath, basis, n = ANALYSES_FED_INTO_PROMPT) {
  if (!basis || basis.mode !== 'history') return [];
  const sorted = sortByDate(readAnalyses(analysesPath));
  return sorted
    .filter(e => e.basisKey === basis.key)
    .slice(-n)
    .map(e => ({
      generatedAt: e.generatedAt,
      verdict: e.verdict,
      recommendations: e.recommendations
    }));
}

// Renders the coach profile (config.json) as prompt text,
// omitting any field that isn't set
// Plain-language account of how the projection numbers were produced, so the
// coach can calibrate how it talks about them. Built from the same facts the
// simulation ran on (calculator.describeBasis), never typed twice.
function renderSimulationBasis(b) {
  const pct = x => `${(x * 100).toFixed(1)}%`;
  const trials = b.trials.toLocaleString();
  const lines = [`How the projection was produced: the app ran ${trials} simulated futures for the market accounts.`];
  if (b.mode === 'custom') {
    lines.push(
      `The user chose their own assumptions: an average of ${pct(b.expectedReturn)} a year, with a typical year landing about ${pct(b.volatility)} away from that. Each simulated future draws random years around those numbers. They are the user's choice, not market history, so do not present them as historically grounded.`
    );
  } else {
    lines.push(
      `Each one replays real US market years from ${b.firstYear} to ${b.lastYear} (a ${Math.round(b.stockWeight * 100)}/${Math.round((1 - b.stockWeight) * 100)} mix of stocks and bonds) in ${b.blockYears}-year stretches, so the Depression, the 1970s, the 2000s and 2008 all appear, in a different order each time. Across those years the mix averaged ${pct(b.expectedReturn)} a year, and a single year ranged from ${pct(b.worstYear)} to ${pct(b.bestYear)}.`
    );
  }
  lines.push(
    `The middle outcome is the middle of the ${trials} results. The downside case is the 20th percentile, so 8 in 10 results landed above it, and the upside case is the 80th percentile. The range between them is realistic, not a worst case. Only the market accounts vary. Everything else grows by contributions alone. Balances are in future dollars unless stated as today's dollars.`
  );
  return lines.join(' ');
}

function renderCoachProfile(config, projection) {
  if (!config) return '';
  const lines = [];

  const household = config.household && config.household[0];
  if (household && household.name) {
    lines.push(`Name: ${household.name}`);
  }

  const helper = config.destinationNumberHelper || {};
  if (helper.desiredAnnualIncome) {
    lines.push(`Desired annual income: $${helper.desiredAnnualIncome.toLocaleString()}`);
  }
  if (helper.socialSecurityEstimate) {
    lines.push(`Estimated Social Security: $${helper.socialSecurityEstimate.toLocaleString()}/year`);
  }

  if (config.targetRetirementAge) {
    lines.push(`Target retirement age: ${config.targetRetirementAge}`);
  }

  if (config.destinationNumber) {
    lines.push(`Retirement portfolio goal: $${config.destinationNumber.toLocaleString()}`);
  }

  // Describe what the projection numbers were actually built on (stamped on
  // the projection when it was computed), not whatever the settings say now.
  const basis = (projection && projection.basis) || calculator.describeBasis(config.projectionRates);
  const inflation = projection && projection.inflationRate != null ? projection.inflationRate : config.inflationRate;
  if (inflation) {
    lines.push(`Assumed inflation rate: ${(inflation * 100).toFixed(1)}% (used only to restate future dollars in today's purchasing power)`);
  }

  lines.push('', renderSimulationBasis(basis));
  if (projection && projection.basisKey && projection.basisKey !== calculator.basisKey(config.projectionRates, config.inflationRate)) {
    lines.push('Note: the user has changed their market assumptions since this projection was computed, so the numbers below reflect the earlier assumptions.');
  }

  return lines.join('\n');
}

module.exports = {
  MAX_RETAINED_ANALYSES,
  ANALYSES_FED_INTO_PROMPT,
  readAnalyses,
  sortByDate,
  upsertAnalysis,
  recentAnalysesFor,
  renderCoachProfile,
  renderSimulationBasis
};
