// Shared helpers for coach analyses — reading/writing coachAnalyses.json
// and building the profile section of the prompt.
// Kept separate from coach-analyze.js so storage rules (rolling window, upsert by date)
// are in one place and easy to reason about independent of the Claude call.

const fs = require('fs');

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

// Insert or replace the entry for today, then trim to the retained window
function upsertAnalysis(analysesPath, entry) {
  const existing = readAnalyses(analysesPath);
  const today = new Date().toISOString().slice(0, 10);
  const withoutToday = existing.filter(e => e.generatedAt.slice(0, 10) !== today);
  const merged = sortByDate([...withoutToday, entry]);
  const trimmed = merged.slice(-MAX_RETAINED_ANALYSES);
  fs.writeFileSync(analysesPath, JSON.stringify(trimmed, null, 2), 'utf8');
  return trimmed;
}

// The last N assessed analyses in date order (verdict + recommendations only,
// never fullReport, so the prompt doesn't grow unbounded)
function recentAnalysesFor(analysesPath, n = ANALYSES_FED_INTO_PROMPT) {
  const sorted = sortByDate(readAnalyses(analysesPath));
  return sorted
    .slice(-n)
    .map(e => ({
      generatedAt: e.generatedAt,
      verdict: e.verdict,
      recommendations: e.recommendations
    }));
}

// Renders the coach profile (config.json) as prompt text,
// omitting any field that isn't set
function renderCoachProfile(config) {
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

  if (config.inflationRate) {
    lines.push(`Assumed inflation rate: ${(config.inflationRate * 100).toFixed(1)}%`);
  }

  if (config.projectionRates) {
    const r = config.projectionRates;
    lines.push(`Market rate assumptions: ${(r.min * 100).toFixed(0)}% to ${(r.max * 100).toFixed(0)}% annually`);
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
  renderCoachProfile
};
