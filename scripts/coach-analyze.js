// Agentic retirement coach — spawns Claude via CLI to analyze projection + user concerns
// Returns structured recommendations for the coach panel
// Pattern borrowed from trim-app's coach-analyze.js, adapted for financial context

const fs = require('fs');
const { spawn } = require('child_process');
const { upsertAnalysis, recentAnalysesFor, renderCoachProfile } = require('./coach-shared');

const CLAUDE_BIN = process.env.CLAUDE_CLI_PATH || 'claude';
const COACH_TIMEOUT_MS = Number(process.env.COACH_TIMEOUT_MS) || 240000;

const COACH_PERSONA = `
You are a personal retirement coach helping someone reach their financial goal. Your voice: clear, conversational, pragmatic. A sounding board and partner who understands household cash flow and account hierarchy.

How to reason:
- Focus on the actual projection data (solved age, trajectory, p20/median/p80 outcomes).
- Take concerns seriously and address them directly with numbers, not dismissing them.
- If prior recommendations exist, reference what actually happened this week: "Last time we suggested X. Did you move forward with it?"
- Avoid "overfunding" language. Retirement needs grow with inflation and healthcare. Focus on sequencing: which dollars go where, and why.
- Recommend 1-2 key actions max. Quality over quantity. Only include a recommendation if it's genuinely important, not filler. The full report will carry the depth—let the summary be punchy.
- **Market context**: Use current market conditions to inform *timing* and *opportunity*, never to override strategy. Compare to historical ranges (not recency bias). Example: "VIX elevated — historically this is when entry points have worked" vs "Markets down, move to cash."
- Frame recommendations around opportunities and optimal sequencing, not raiding checking/savings unnecessarily.
- Keep recommendations grounded. Acknowledge advisor priorities (e.g., 401k match first, then a tax-deferred account).
- Respect household risk tolerance. When spouses aren't aligned on a move, acknowledge it and find lower-risk alternatives.

Account hierarchy you understand:
- Checking: For living expenses and emergency access. Never recommend moving checking balances.
- Savings: Secondary liquid buffer. Don't recommend draining this fully.
- Investments (401k, IRAs, taxable): Long-term growth vehicles. Only suggest moving money here after checking and savings are adequately funded.

About the projection numbers: they come from a simplified model. Only Investment accounts (401k, IRA, brokerage) are grown at the assumed market range. Insurance cash value and Checking/Savings accounts are carried forward with their contributions only, so the projection likely understates their real growth (interest on savings, guaranteed and dividend crediting on whole life). Use your own knowledge of how each kind of vehicle really behaves. Do not say those accounts earn market returns, and when it matters to the advice, say plainly that the projection is conservative for them instead of inventing a specific rate. Projected balances are as of the target retirement age. Never attach them to an earlier milestone (for example a child's college start date). If you need a balance at an earlier date, estimate it from the starting balance plus contributions to that date and say it is an estimate.

The two kinds of insurance:
- Protection-only policies (term life) are the family's safety net if something happens to the insured. They hold no cash value, and the premium is the cost of that net, not retirement savings. Never suggest increasing, redirecting, or finding more money for a protection policy, and never count one as a retirement asset. They are listed separately in the data as context only, so you can acknowledge the safety net exists.
- Cash value policies (whole life, paid-up life) carry both a death benefit and a cash balance that grows over time. Their contributions are fair to discuss. The policy may cap how much cash value or funding it allows, and that cap is unknown here, so do not assume it can absorb unlimited extra contributions.

Writing style:
- Never use an em dash. Restructure the sentence into two sentences, a comma, or parentheses instead. Example: instead of "You're ahead — the goal is met," write "You're ahead. The goal is met."
- Never use semicolons. Write two sentences instead.
- Lead with plain language, keep technical terms as optional secondary context. Instead of "the p20 (downside case)" write "the downside case (from running 250 simulations)" or just "the downside case." Use plain terms: "downside case" not "p20", "middle outcome" not "median", "simulations" not "Monte Carlo". Technical jargon is optional context, never the primary framing.
- Always pair account names with their type: "your Fidelity 401k investment account" not just "your Fidelity 401k".
- Soften recommendations: "consider redirecting," "once your buffer covers 3-6 months," "gradually move." This is partnership, not orders.

Output format — respond with ONLY a JSON object, no prose outside the JSON, in exactly this shape:
{
  "verdict": "<one or two sentences — headline assessment of their retirement readiness>",
  "recommendations": [
    {
      "title": "<short, conversational title>",
      "description": "<one sentence with specific action or insight>",
      "reasoning": "<2-3 sentences explaining why this matters>"
    },
    {
      "title": "<second recommendation (only if it's genuinely essential, not filler)>",
      "description": "<specific action>",
      "reasoning": "<why>"
    }
  ],
  "fullReport": "Structure this with multiple markdown headers (##) to break into 3-4 clear sections. Use headers like: ## Your Situation, ## Addressing [Concern 1], ## Addressing [Concern 2], ## Next Steps. Each section should be 2-3 paragraphs. The full report is where nuance and depth live—the summary above is punchy, the report breathes."
}
`.trim();

function buildCoachPrompt({ profileText, projectionSummary, userConcerns, recentAnalyses, advisorNotes, portfolioBreakdown, marketContext }) {
  const parts = [COACH_PERSONA, ''];

  parts.push(`Assessing retirement readiness based on current projection and market context.`);

  if (profileText) {
    parts.push('', 'PERSON PROFILE & GOALS', profileText);
  }

  if (advisorNotes && advisorNotes.trim()) {
    parts.push('', 'ADVISOR STRATEGY (from their professional notes)', advisorNotes.trim());
  }

  if (marketContext) {
    parts.push('', 'MARKET CONTEXT (for timing and opportunity assessment)',
      `As of ${marketContext.asOfDate}: ${marketContext.yearProgress || 'Year progress unknown'}. ${marketContext.note || ''}`);
  }

  if (recentAnalyses && recentAnalyses.length) {
    parts.push('', 'RECENT COACHING HISTORY (most recent last — check what actually happened)');
    recentAnalyses.forEach(a => {
      parts.push(`\nAnalysis from ${a.generatedAt.slice(0, 10)}:`);
      parts.push(`  Verdict: ${a.verdict}`);
      parts.push(`  Top recommendation: ${a.recommendations[0]?.title || 'N/A'}`);
    });
  } else {
    parts.push('', 'RECENT COACHING HISTORY: none yet — this is the first analysis.');
  }

  if (projectionSummary) {
    parts.push('', "TODAY'S PROJECTION & FINANCIAL POSITION", projectionSummary);
  }

  if (portfolioBreakdown && portfolioBreakdown.trim()) {
    parts.push('', 'PORTFOLIO BREAKDOWN', portfolioBreakdown);
  }

  if (userConcerns && userConcerns.trim()) {
    parts.push('', "PERSON'S OWN CONCERNS / WHAT'S ON THEIR MIND", userConcerns.trim());
  }

  return parts.join('\n');
}

function runCoachAnalysis({
  configPath,
  analysesPath,
  projectionData,
  userConcerns,
  now = new Date(),
  retryCount = 0,
  maxRetries = 2
}) {
  return new Promise((resolve) => {
    if (!projectionData) {
      return resolve({ ok: false, status: 400, error: 'Missing projectionData' });
    }

    let config = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) { /* no config yet — profile stays empty */ }

    const profileText = renderCoachProfile(config);
    const advisorNotes = config.coachNotes || '';
    const recentAnalyses = recentAnalysesFor(analysesPath);

    // Build projection summary from the data
    const projectionSummary = buildProjectionSummary(projectionData);
    const portfolioBreakdown = buildPortfolioBreakdown(projectionData);

    // Fetch market context (synchronous version for now)
    const marketContext = {
      asOfDate: now.toISOString().split('T')[0],
      yearProgress: `${Math.round((now.getMonth() + (now.getDate() / 28)) / 12 * 100)}% through ${now.getFullYear()}`,
      note: "Coach should use market context to inform timing opportunities, not to override strategy. Focus on historically validated patterns, not recency bias."
    };

    const prompt = buildCoachPrompt({
      profileText,
      projectionSummary,
      userConcerns: userConcerns || '',
      recentAnalyses,
      advisorNotes,
      portfolioBreakdown,
      marketContext
    });

    // Same Windows shell:true / --tools "" handling as trim-app's coach-analyze.js
    console.log(`[coach-analyze] Spawning Claude CLI: ${CLAUDE_BIN}`);
    const child = spawn(CLAUDE_BIN, ['-p', '--output-format', 'json', '--tools', '""'], {
      cwd: __dirname,
      shell: true
    });

    let stdout = '', stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ ok: false, status: 504, error: `Coach analysis timed out after ${COACH_TIMEOUT_MS / 1000}s` });
    }, COACH_TIMEOUT_MS);

    child.stdout.on('data', d => {
      stdout += d;
      console.log('[coach-analyze] stdout chunk:', d.toString().slice(0, 100));
    });
    child.stderr.on('data', d => {
      stderr += d;
      console.log('[coach-analyze] stderr chunk:', d.toString().slice(0, 100));
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error('[coach-analyze] Failed to spawn Claude CLI:', err);
      const msg = err.code === 'ENOENT'
        ? `Claude CLI not found at "${CLAUDE_BIN}". Make sure Claude Code is installed and the "claude" command is in your PATH.`
        : `Failed to launch Claude Code: ${err.message}`;
      resolve({ ok: false, status: 500, error: msg });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.log(`[coach-analyze] Claude CLI exited with code ${code}`);

      if (code !== 0) {
        let cliMessage = null;
        try {
          const parsed = JSON.parse(stdout);
          if (parsed && parsed.is_error && typeof parsed.result === 'string') cliMessage = parsed.result;
        } catch (e) { /* stdout wasn't JSON */ }

        if (cliMessage && /oauth|authenticat/i.test(cliMessage)) {
          return resolve({
            ok: false,
            status: 500,
            error: `Claude Code CLI is not authenticated (${cliMessage}). Run "claude" in a terminal and complete login, then retry.`
          });
        }

        return resolve({
          ok: false,
          status: 500,
          error: `Claude Code exited with code ${code}: ${cliMessage || stderr.slice(0, 500) || 'no stderr output'}`
        });
      }

      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch (e) {
        return resolve({ ok: false, status: 502, error: 'Could not parse Claude Code output as JSON', raw: stdout.slice(0, 1000) });
      }

      const resultText = envelope.result || '';
      let parsed;
      try {
        const match = resultText.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : resultText);
      } catch (e) {
        return resolve({ ok: false, status: 502, error: 'Could not parse coach response JSON', raw: resultText.slice(0, 1000) });
      }

      if (!parsed || typeof parsed.verdict !== 'string' || !Array.isArray(parsed.recommendations)) {
        return resolve({ ok: false, status: 502, error: 'Coach response missing verdict/recommendations', raw: resultText.slice(0, 1000) });
      }

      // Validate punctuation and jargon rules
      const validateText = (text) => {
        const violations = [];
        if (text.includes('—')) violations.push('em dash');
        if (text.includes(';')) violations.push('semicolon');
        if (/\bp20\b|\bp80\b|\bmedian\b(?!\s+projection)/.test(text) && !text.includes('downside') && !text.includes('percentile')) violations.push('unexplained jargon');
        return violations;
      };

      const allText = [
        parsed.verdict,
        ...parsed.recommendations.map(r => r.title + ' ' + r.description + ' ' + r.reasoning),
        parsed.fullReport
      ].join(' ');

      const violations = validateText(allText);
      if (violations.length > 0) {
        console.error(`[coach-analyze] VALIDATION FAILED (attempt ${retryCount + 1}/${maxRetries + 1}): ${violations.join(', ')}`);
        if (retryCount < maxRetries) {
          console.log(`[coach-analyze] Retrying analysis automatically...`);
          return runCoachAnalysis({
            configPath,
            analysesPath,
            projectionData,
            userConcerns,
            now,
            retryCount: retryCount + 1,
            maxRetries
          }).then(resolve);
        }
        return resolve({
          ok: false,
          status: 502,
          error: `Coach analysis failed validation after ${maxRetries + 1} attempts. Please try again.`
        });
      }

      const entry = {
        verdict: parsed.verdict.trim(),
        recommendations: (parsed.recommendations || []).slice(0, 3).map(r => ({
          title: String(r.title || '').trim(),
          description: String(r.description || '').trim(),
          reasoning: String(r.reasoning || '').trim()
        })),
        fullReport: String(parsed.fullReport || '').trim(),
        generatedAt: now.toISOString()
      };

      try {
        upsertAnalysis(analysesPath, entry);
      } catch (e) {
        return resolve({ ok: false, status: 500, error: `Analysis succeeded but failed to write analyses.json: ${e.message}` });
      }

      resolve({ ok: true, entry });
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function buildProjectionSummary(projection) {
  const lines = [];
  lines.push(`Current age: ${projection.currentAge}`);
  lines.push(`Target retirement age: ${projection.targetRetirementAge}`);
  lines.push(`Projected solved age (goal met): ${projection.solvedAge || 'Beyond projection window'}`);
  lines.push(`Current savings: $${Math.round(projection.startingBase).toLocaleString()}`);
  lines.push(`Projected balance at ${projection.targetRetirementAge}: $${Math.round(projection.totalProjected).toLocaleString()}`);
  lines.push(`Destination number (goal): $${Math.round(projection.destinationNumber).toLocaleString()}`);
  if (projection.monteCarlo) {
    const median = projection.monteCarlo.median && projection.monteCarlo.median[projection.yearsToRetirement];
    const p20 = projection.monteCarlo.p20 && projection.monteCarlo.p20[projection.yearsToRetirement];
    if (median) lines.push(`Median projection at retirement: $${Math.round(median).toLocaleString()}`);
    if (p20) lines.push(`Downside (p20) at retirement: $${Math.round(p20).toLocaleString()}`);
  }
  return lines.join('\n');
}

function buildPortfolioBreakdown(projection) {
  if (!projection.detail || !Array.isArray(projection.detail)) return '';
  const lines = [];
  const protection = [];
  projection.detail.forEach(v => {
    if (v.excluded) {
      // Insurance with no cash value: the family safety net, shown as context only.
      if (v.category === 'Insurance') {
        const parts = [];
        if (v.benefit) parts.push(`$${Math.round(v.benefit).toLocaleString()} benefit`);
        if (v.annualContribution) parts.push(`$${Math.round(v.annualContribution).toLocaleString()}/yr premium`);
        protection.push(`${v.vehicle} (${v.company})${parts.length ? ': ' + parts.join(', ') : ''}`);
      }
      return;
    }
    lines.push(`${v.vehicle} (${v.company}, ${v.category || 'Uncategorized'}): $${Math.round(v.startBalance).toLocaleString()} → $${Math.round(v.projectedBalance).toLocaleString()}`);
  });
  if (protection.length) {
    lines.push('', 'PROTECTION ONLY (family safety net, not retirement savings, context only):', ...protection);
  }
  return lines.join('\n');
}

if (require.main === module) {
  const [configPath, analysesPath] = process.argv.slice(2);
  if (!configPath || !analysesPath) {
    console.error('Usage: node scripts/coach-analyze.js <config.json> <coachAnalyses.json>');
    process.exit(1);
  }

  // Test with mock projection data
  const mockProjection = {
    currentAge: 42,
    targetRetirementAge: 65,
    solvedAge: 68,
    startingBase: 220563,
    totalProjected: 1418780,
    destinationNumber: 1650000,
    yearsToRetirement: 23,
    detail: []
  };

  runCoachAnalysis({
    configPath,
    analysesPath,
    projectionData: mockProjection,
    userConcerns: 'My spouse is concerned about liquidity if we move savings to investments.'
  }).then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.ok ? 0 : 1);
  });
}

module.exports = { runCoachAnalysis, buildCoachPrompt, COACH_PERSONA };
