(function () {
  'use strict';

  const API = {
    config: '/waypoint-app/api/config',
    data: '/waypoint-app/api/data',
    projection: '/waypoint-app/api/projection',
    projectionRecompute: '/waypoint-app/api/projection/recompute',
  };

  const BLUE_PALETTE = ['#8FB6D9', '#B7C6D5', '#6B8AA5', '#6B7C8C', '#546575', '#3F4E5C', '#2F3A44'];

  let state = { config: null, data: null, projection: null };

  // ── fetch helpers ──────────────────────────────────────────────────────
  async function getJSON(url) {
    const res = await fetch(url);
    return res.json();
  }
  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // ── formatting ─────────────────────────────────────────────────────────
  function fmtCurrency(n) {
    if (n == null || isNaN(n)) return '$--';
    return '$' + Math.round(n).toLocaleString('en-US');
  }
  function fmtCurrencyShort(n) {
    const abs = Math.abs(n);
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + Math.round(n);
  }
  function fmtPct(n, digits = 1) {
    if (n == null || isNaN(n)) return '--%';
    return (n * 100).toFixed(digits) + '%';
  }
  function fmtDate(isoDateStr) {
    if (!isoDateStr) return '';
    const d = new Date(isoDateStr + 'T00:00:00');
    if (isNaN(d.getTime())) return isoDateStr;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function showToast(msg) {
    const toast = document.getElementById('save-toast');
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2200);
  }

  function uid(prefix) {
    return prefix + '_' + Math.random().toString(36).slice(2, 9);
  }

  // ── routing ────────────────────────────────────────────────────────────
  const VIEWS = ['presentation', 'data', 'configuration'];

  function showView(name) {
    if (!VIEWS.includes(name)) name = 'presentation';
    // First-run gate: until the core interview is done, every route forces
    // Configuration's wizard — a fresh clone (or a fresh person) should
    // never land on Presentation and see a dashboard of zeros before ever
    // being asked who they are.
    if (state.config && !isSetupComplete(state.config)) {
      name = 'configuration';
      if (location.hash !== '#configuration') location.hash = '#configuration';
    }
    VIEWS.forEach(v => {
      document.getElementById('view-' + v).classList.toggle('hidden', v !== name);
    });
    document.querySelectorAll('.topnav a[data-nav]').forEach(a => {
      const isActive = a.dataset.nav === name;
      a.classList.toggle('active', isActive);
      a.title = isActive ? 'Click to close' : '';
    });
    if (name === 'data') renderData();
    if (name === 'configuration') renderConfiguration();
  }

  function currentRouteName() {
    const hash = (location.hash || '#presentation').replace('#', '');
    return VIEWS.includes(hash) ? hash : 'presentation';
  }

  window.addEventListener('hashchange', () => showView(currentRouteName()));

  // Clicking an already-active Data/Configuration tab closes it back to
  // Presentation, instead of just re-navigating to the same place.
  document.querySelectorAll('.topnav a[data-nav]').forEach(a => {
    a.addEventListener('click', e => {
      if (a.dataset.nav === currentRouteName()) {
        e.preventDefault();
        location.hash = '#presentation';
      }
    });
  });

  // ── Presentation ───────────────────────────────────────────────────────
  let projectionChart, portfolioChart;
  let portfolioView = 'current'; // 'current' or 'projected'

  function renderPresentation() {
    const { config, projection } = state;
    if (!config || !projection) return;

    const primary = (config.household && config.household[0]) || { name: 'there' };
    const firstName = primary.name || 'there';
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'GOOD MORNING' : hour < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING';
    document.getElementById('hero-eyebrow').textContent = `${greeting}, ${firstName.toUpperCase()}`;
    document.getElementById('avatar-initials').textContent = initials(config.household);

    // ── Top row: standing + desire, and the one place they meet ──────────
    document.getElementById('kpi-savings').textContent = fmtCurrency(projection.startingBase);
    document.getElementById('kpi-savings-foot').textContent =
      `Across ${state.data.vehicles.filter(v => v.retirementCashValue > 0).length} retirement vehicles`;

    document.getElementById('kpi-desired-age').textContent =
      projection.targetRetirementAge != null ? projection.targetRetirementAge : '--';

    const helper = config.destinationNumberHelper || {};
    const desiredTotal = helper.desiredAnnualIncome || 0;

    document.getElementById('kpi-desired-income').textContent = fmtCurrency(desiredTotal);
    document.getElementById('kpi-desired-income-foot').textContent = 'Total annual income desired';

    const trajectory = trajectoryStatus(projection);
    document.getElementById('kpi-status').textContent = trajectory.label;
    document.getElementById('kpi-status-foot').textContent = trajectory.caption;

    // Projection chart
    renderProjectionChart(projection);

    // Portfolio donut
    renderPortfolioChart(projection);

    // ── Bottom row: current projected reality, in detail ──────────────────
    // Everything is in future dollars (what you'll see in your bank account).
    // Today's dollars shown as context so you understand purchasing power.
    document.getElementById('metric-projected-age').textContent =
      projection.solvedAge != null ? projection.solvedAge : 'Beyond projection';

    const mc = projection.monteCarlo || { median: [], p20: [], p80: [] };
    const medianAtTarget = mc.median && mc.median[projection.yearsToRetirement]
      ? mc.median[projection.yearsToRetirement]
      : projection.totalProjected;
    document.getElementById('metric-projected-balance').textContent = fmtCurrency(medianAtTarget);

    const projectedAnnualIncome = medianAtTarget * 0.04;
    document.getElementById('metric-projected-income').textContent = fmtCurrency(projectedAnnualIncome);

    const inflationRate = state.config && state.config.inflationRate != null
      ? state.config.inflationRate
      : 0.025;
    const inflationFactor = Math.pow(1 + inflationRate, projection.yearsToRetirement);
    const medianTodaysDollars = medianAtTarget / inflationFactor;
    const incomeTodaysDollars = projectedAnnualIncome / inflationFactor;

    document.getElementById('metric-projected-balance-caption').textContent =
      `at age ${projection.targetRetirementAge} (~${fmtCurrency(medianTodaysDollars)} in today's dollars)`;
    document.getElementById('metric-projected-income-caption').textContent =
      `per year at retirement (~${fmtCurrency(incomeTodaysDollars)} in today's dollars)`;

    // Withdrawal capacity: portfolio-only at 4-5%, plus SSA upside if it materializes
    const withdrawalAt4Pct = medianAtTarget * 0.04;
    const withdrawalAt5Pct = medianAtTarget * 0.05;
    const withdrawalRangeTodaysDollars4 = withdrawalAt4Pct / inflationFactor;
    const withdrawalRangeTodaysDollars5 = withdrawalAt5Pct / inflationFactor;

    // SSA upside: risk-adjusted to 50% of estimate
    const ssaEstimate = (config.destinationNumberHelper && config.destinationNumberHelper.socialSecurityEstimate) || 0;
    const ssaRiskDiscount = 0.50; // 50% risk adjustment
    const ssaAdjusted = ssaEstimate * (1 - ssaRiskDiscount);
    const ssaAdjustedToday = ssaAdjusted / inflationFactor;

    const totalWithSSALow = withdrawalAt4Pct + ssaAdjusted;
    const totalWithSSAHigh = withdrawalAt5Pct + ssaAdjusted;
    const totalWithSSALowToday = withdrawalRangeTodaysDollars4 + ssaAdjustedToday;
    const totalWithSSAHighToday = withdrawalRangeTodaysDollars5 + ssaAdjustedToday;

    // High end of range: 5% of portfolio + discounted SSA (if applicable)
    const rangeHigh = ssaEstimate > 0 ? totalWithSSAHigh : withdrawalAt5Pct;
    const rangeHighToday = ssaEstimate > 0 ? totalWithSSAHighToday : withdrawalRangeTodaysDollars5;

    document.getElementById('metric-withdrawal-range').textContent =
      `${fmtCurrency(withdrawalAt4Pct)} – ${fmtCurrency(rangeHigh)}`;

    // Simplified caption: just show today's dollars context
    const rangeCaption = `at 4–5% annual withdrawal (~${fmtCurrency(withdrawalRangeTodaysDollars4)}–${fmtCurrency(rangeHighToday)} in today's dollars)`;
    document.getElementById('metric-withdrawal-range-caption').textContent = rangeCaption;


    // Load and render coach analysis
    loadCoachAnalysis().then(() => renderCoachPanel(projection, config));
  }

  function initials(household) {
    if (!household || !household.length) return '--';
    const name = household[0].name || '';
    const parts = name.trim().split(/\s+/);
    return parts.map(p => p[0] || '').join('').slice(0, 2).toUpperCase() || '--';
  }

  // Trajectory is a choice-point, not a verdict — see Visual Brief's "worth
  // looking at" vs "something is wrong" philosophy. Classified purely on
  // years (solvedAge vs. desired age), not dollars — the two move together
  // mathematically, and years reads as a solvable nudge rather than a
  // stamped dollar deficit. Thresholds are a value judgment, set directly
  // by the user, not inferred: more than 1yr early = Ahead; within 1yr
  // early to 2yrs late = On Track; beyond 2yrs late = Worth Review.
  function trajectoryStatus(projection) {
    const target = projection.targetRetirementAge;
    const solved = projection.solvedAge;

    if (solved == null) {
      return {
        label: 'Worth Review',
        caption: "Your current pace doesn't reach your number within our projection window — this one's worth a real conversation with your coach.",
      };
    }

    const gap = solved - target; // positive = later than desired, negative = earlier

    if (gap < -1) {
      return { label: 'Ahead', caption: `On pace for about age ${solved} — earlier than the ${target} you're aiming for.` };
    }
    if (gap <= 2) {
      return { label: 'On Track', caption: `On pace for about age ${solved}, close to the ${target} you're aiming for.` };
    }
    return {
      label: 'Worth Review',
      caption: `On pace for about age ${solved} — a few years past your ${target} goal. Run a new analysis to see your options.`,
    };
  }

  function renderProjectionChart(projection) {
    // Register the vertical lines plugin once
    if (!Chart.registry.plugins.get('verticalLinesPlugin')) {
      Chart.register({
        id: 'verticalLinesPlugin',
        // Drawn before the datasets (not afterDraw) so the hover tooltip,
        // painted later, always sits on top of this line.
        beforeDatasetsDraw(chart) {
          const ctx = chart.ctx;
          const xScale = chart.scales.x;
          const yScale = chart.scales.y;
          const goalIndex = chart.options.plugins.verticalLines?.goalIndex;
          const targetIndex = chart.options.plugins.verticalLines?.targetIndex;

          // Draw dashed vertical line at goal crossing (on top of all chart elements)
          if (goalIndex >= 0) {
            const x = xScale.getPixelForValue(goalIndex);
            const yTop = yScale.top;
            const yBottom = yScale.bottom;

            ctx.strokeStyle = '#5B7C94';
            ctx.lineWidth = 2.5;
            ctx.setLineDash([4, 4]);
            ctx.globalAlpha = 1.0;

            ctx.beginPath();
            ctx.moveTo(x, yTop);
            ctx.lineTo(x, yBottom);
            ctx.stroke();
            ctx.setLineDash([]);
          }
        },
      });
    }


    const ctx = document.getElementById('projection-chart');
    // The server simulates up to 60 years but trims `series` (the year labels)
    // to the display horizon. Trim the simulation arrays to match, or the extra
    // points stretch the Y axis to values far beyond what the chart shows.
    const mcFull = projection.monteCarlo || { p20: [], median: [], p80: [], sampledPaths: [] };
    const horizonLen = projection.series.length;
    const mc = {
      p20: mcFull.p20.slice(0, horizonLen),
      median: mcFull.median.slice(0, horizonLen),
      p80: mcFull.p80.slice(0, horizonLen),
      sampledPaths: mcFull.sampledPaths.map(p => p.slice(0, horizonLen)),
    };
    const labels = projection.series.map(p => p.year);
    const targetData = projection.series.map(() => projection.destinationNumber);

    const retirementIndex = projection.series.findIndex(p => p.age === projection.targetRetirementAge);
    const medianPointRadii = mc.median.map((_, i) => (i === retirementIndex ? 5 : 0));

    // Find where median crosses the destination number (goal)
    let goalCrossIndex = -1;
    if (mc.median && projection.destinationNumber > 0) {
      goalCrossIndex = mc.median.findIndex(val => val >= projection.destinationNumber);
    }

    // Dataset order matters: p80 first (invisible border, just a fill
    // reference), then p20 with fill:'-1' to shade the region between them
    // — the standard Chart.js two-line-band technique. Sampled spaghetti
    // paths are tagged isSpaghetti so the tooltip filter can hide them;
    // they're visual texture, not data points worth reading individually.
    const spaghettiDatasets = mc.sampledPaths.map(path => ({
      label: 'Simulated path',
      data: path,
      borderColor: 'rgba(143, 182, 217, 0.12)',
      borderWidth: 1,
      pointRadius: 0,
      // No hover dot: 25 stacked translucent dots smear into a vertical
      // streak behind the median's own hover dot.
      pointHoverRadius: 0,
      fill: false,
      tension: 0.25,
      isSpaghetti: true,
    }));

    if (projectionChart) projectionChart.destroy();
    projectionChart = new Chart(ctx, {
      type: 'line',
      plugins: [{
        // The retirement callout is an HTML box over the canvas, so the
        // canvas-drawn tooltip can't render above it. Hide the callout while
        // the tooltip overlaps it.
        id: 'calloutYield',
        afterDraw(chart) {
          const callout = document.getElementById('chart-callout');
          if (!callout) return;
          callout.style.transition = 'opacity 0.15s';
          const tt = chart.tooltip;
          let overlaps = false;
          if (tt && tt.opacity > 0 && !callout.classList.contains('hidden')) {
            const base = chart.canvas.getBoundingClientRect();
            const c = callout.getBoundingClientRect();
            const pad = 6;
            overlaps = !(base.left + tt.x + tt.width + pad < c.left ||
                         base.left + tt.x - pad > c.right ||
                         base.top + tt.y + tt.height + pad < c.top ||
                         base.top + tt.y - pad > c.bottom);
          }
          callout.style.opacity = overlaps ? '0' : '1';
        },
      }, {
        // Thin vertical guide at the hovered year, drawn under the lines.
        id: 'hoverGuide',
        beforeDatasetsDraw(chart) {
          const active = chart.getActiveElements();
          if (!active.length) return;
          const x = active[0].element.x;
          const { top, bottom } = chart.scales.y;
          const ctx = chart.ctx;
          ctx.save();
          ctx.strokeStyle = 'rgba(215, 225, 234, 0.35)';
          ctx.lineWidth = 1;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.moveTo(x, top);
          ctx.lineTo(x, bottom);
          ctx.stroke();
          ctx.restore();
        },
      }],
      data: {
        labels,
        datasets: [
          {
            label: '80th percentile',
            data: mc.p80,
            borderColor: 'transparent',
            pointRadius: 0,
            pointHoverRadius: 0,
            fill: false,
            tension: 0.25,
          },
          {
            label: '20th percentile',
            data: mc.p20,
            borderColor: 'transparent',
            backgroundColor: 'rgba(143, 182, 217, 0.22)',
            pointRadius: 0,
            pointHoverRadius: 0,
            fill: '-1',
            tension: 0.25,
          },
          ...spaghettiDatasets,
          {
            label: 'Median (250 simulations)',
            data: mc.median,
            borderColor: '#8FB6D9',
            backgroundColor: 'transparent',
            fill: false,
            tension: 0.25,
            pointRadius: medianPointRadii,
            pointBackgroundColor: '#B8783D',
            pointBorderColor: '#FFFFFF',
            pointBorderWidth: 2,
            pointHoverBackgroundColor: '#D49C5C',
            pointHoverBorderColor: '#FFFFFF',
            pointHoverBorderWidth: 2,
            pointHoverRadius: 6,
            borderWidth: 2.5,
          },
          {
            label: 'Target',
            data: targetData,
            borderColor: '#6B7C8C',
            borderDash: [5, 5],
            pointRadius: 0,
            pointHoverRadius: 0,
            borderWidth: 1.5,
            fill: false,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        // Re-place the callout once the draw animation settles; positioning
        // it up front reads a point position from mid-animation.
        animation: { onComplete: () => positionRetirementCallout(mc, retirementIndex, 2 + spaghettiDatasets.length, projection.targetRetirementAge) },
        plugins: {
          legend: { display: false },
          // Custom plugin to draw vertical reference lines
          verticalLines: {
            goalIndex: goalCrossIndex,
            targetIndex: retirementIndex,
          },
          tooltip: {
            backgroundColor: '#1E252C',
            titleColor: '#F6F7F8',
            bodyColor: '#D7E1EA',
            borderColor: 'rgba(215,225,234,0.5)',
            borderWidth: 2,
            displayColors: false,
            filter: item => !item.dataset.isSpaghetti,
            callbacks: {
              // "2049 (Age 65)": the app talks in ages, the axis in years.
              title: items => {
                if (!items.length) return '';
                const point = projection.series[items[0].dataIndex];
                return point && point.age != null
                  ? `${items[0].label} (Age ${point.age})`
                  : items[0].label;
              },
              label: ctx => `${ctx.dataset.label}: ${fmtCurrency(ctx.parsed.y)}`,
            },
          },
          filler: {
            propagate: true,
          },
          // Plugin to draw vertical reference lines at key milestones
          annotation: {
            annotations: {
              retirementAge: retirementIndex >= 0 ? {
                type: 'line',
                xMin: retirementIndex,
                xMax: retirementIndex,
                borderColor: '#5B7C94',
                borderWidth: 2.5,
                borderDash: [4, 4],
              } : null,
              goalCross: goalCrossIndex >= 0 && goalCrossIndex !== retirementIndex ? {
                type: 'line',
                xMin: goalCrossIndex,
                xMax: goalCrossIndex,
                borderColor: 'rgba(184, 120, 61, 0.4)',
                borderWidth: 2,
                borderDash: [3, 3],
              } : null,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: 'rgba(215,225,234,0.55)', maxTicksLimit: 9, font: { size: 11 } },
          },
          y: {
            grid: { color: 'rgba(215,225,234,0.10)' },
            ticks: {
              color: 'rgba(215,225,234,0.55)',
              font: { size: 11 },
              callback: v => fmtCurrencyShort(v),
            },
          },
        },
      },
    });

    // Median is always the last "real" dataset before Target — index is
    // 2 (p80, p20) + however many spaghetti datasets came before it.
    const medianDatasetIndex = 2 + spaghettiDatasets.length;
    positionRetirementCallout(mc, retirementIndex, medianDatasetIndex, projection.targetRetirementAge);
  }

  function positionRetirementCallout(mc, retirementIndex, medianDatasetIndex, targetAge) {
    const callout = document.getElementById('chart-callout');
    if (retirementIndex < 0) {
      callout.classList.add('hidden');
      return;
    }
    const meta = projectionChart.getDatasetMeta(medianDatasetIndex);
    const point = meta.data[retirementIndex];
    if (!point) {
      callout.classList.add('hidden');
      return;
    }
    const pointValue = mc.median[retirementIndex];
    callout.innerHTML = `Retirement (age ${targetAge})<br/><strong>${fmtCurrencyShort(pointValue)} projected</strong>`;
    callout.style.left = point.x + 'px';
    callout.style.top = (point.y - 10) + 'px';
    callout.classList.remove('hidden');
  }

  // Groups the current portfolio by Category (Investment / Insurance /
  // Checking/Savings / Other) so the donut co-locates vehicle types, per
  // request — rather than one slice per individual account.
  function groupVehiclesByCategory() {
    const groups = {};
    state.data.vehicles
      .filter(v => v.retirementCashValue > 0)
      .forEach(v => {
        const cat = v.category || 'Uncategorized';
        if (!groups[cat]) groups[cat] = { total: 0, members: [] };
        groups[cat].total += v.retirementCashValue;
        groups[cat].members.push(v);
      });
    return Object.keys(groups)
      .sort((a, b) => (CATEGORY_ORDER[a] != null ? CATEGORY_ORDER[a] : 99) - (CATEGORY_ORDER[b] != null ? CATEGORY_ORDER[b] : 99))
      .map(cat => ({ category: cat, total: groups[cat].total, members: groups[cat].members }));
  }

  function renderPortfolioChart(projection) {
    // Use provided projection or fall back to state.projection
    const proj = projection || state.projection;
    if (!proj) return;

    const grouped = groupVehiclesByCategory();
    const labels = grouped.map(g => g.category);

    // Current values
    const currentValues = grouped.map(g => g.total);
    const currentTotal = currentValues.reduce((a, b) => a + b, 0);

    // Projected values use the Monte Carlo median or total projected
    const mc = proj.monteCarlo || { median: [] };
    let medianAtRetirement = 0;
    if (mc.median && mc.median.length > 0 && proj.yearsToRetirement != null) {
      medianAtRetirement = mc.median[proj.yearsToRetirement] || 0;
    }

    // Use median if available, otherwise use totalProjected
    const projectedTotal = medianAtRetirement > 0 ? medianAtRetirement : (proj.totalProjected || 0);

    // Calculate projectedTotals from detail — these already have the correct breakdown
    // (Checking/Savings stable, Insurance deterministic, Investment variable)
    const projectedTotals = {};
    const allCategories = ['Investment', 'Insurance', 'Checking/Savings', 'Other'];
    allCategories.forEach(cat => { projectedTotals[cat] = 0; });

    if (proj.detail && Array.isArray(proj.detail)) {
      proj.detail.forEach(v => {
        if (!v.excluded && v.category && v.projectedBalance != null) {
          projectedTotals[v.category] = (projectedTotals[v.category] || 0) + v.projectedBalance;
        }
      });
    }

    // Use the actual projected category values (not proportional scaling)
    let projectedValues = grouped.map(g => projectedTotals[g.category] || 0);

    const isProjected = portfolioView === 'projected';
    const values = isProjected ? projectedValues : currentValues;
    const total = isProjected ? projectedTotal : currentTotal;
    const colors = grouped.map((_, i) => BLUE_PALETTE[i % BLUE_PALETTE.length]);

    // Update toggle state
    const toggleGroup = document.getElementById('portfolio-toggle-group');
    const toggleOptions = document.querySelectorAll('.toggle-option');
    if (toggleGroup) {
      toggleGroup.classList.toggle('projected', portfolioView === 'projected');
      toggleOptions.forEach(opt => {
        opt.classList.toggle('active', opt.dataset.view === portfolioView);
      });
    }

    // Update center label - always visible showing total
    const categoryEl = document.getElementById('portfolio-total-category');
    const valueEl = document.getElementById('portfolio-total-value');
    const labelEl = document.getElementById('portfolio-total-label');
    if (categoryEl) categoryEl.textContent = isProjected ? 'Projected Total' : 'Current Total';
    if (valueEl) valueEl.textContent = fmtCurrencyShort(total);
    if (labelEl) labelEl.style.opacity = '1'; // Always visible

    const ctx = document.getElementById('portfolio-chart');

    // If chart exists, just update the data instead of destroying/recreating
    if (portfolioChart) {
      portfolioChart.data.labels = labels;
      portfolioChart.data.datasets[0].data = values;
      portfolioChart.data.datasets[0].backgroundColor = colors;
      portfolioChart.update();
    } else {
      // First time creating the chart
      portfolioChart = new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels,
          datasets: [{ data: values, backgroundColor: colors, borderColor: '#333E4C', borderWidth: 2 }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          cutout: '72%', // Show center by default
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false }, // Remove default tooltip
          },
        },
      });
    }

    // Add hover handlers to update center with segment info
    const canvas = document.getElementById('portfolio-chart');
    const label = document.getElementById('portfolio-total-label');

    let currentHoveredCategory = null;

    canvas.addEventListener('mousemove', (e) => {
      if (!portfolioChart || !portfolioChart.getElementsAtEventForMode) return;

      const elements = portfolioChart.getElementsAtEventForMode(e, 'nearest', { intersect: true }, true);
      if (elements.length > 0) {
        const idx = elements[0].index;
        const cat = grouped[idx].category;
        const val = isProjected ? projectedTotals[cat] : grouped[idx].total;

        // Update center if segment changed
        if (currentHoveredCategory !== cat) {
          currentHoveredCategory = cat;
          document.getElementById('portfolio-total-category').textContent = cat;
          document.getElementById('portfolio-total-value').textContent = fmtCurrencyShort(val);
        }
      }
    });

    canvas.addEventListener('mouseleave', () => {
      // Restore to total
      if (currentHoveredCategory !== null) {
        currentHoveredCategory = null;
        document.getElementById('portfolio-total-category').textContent = isProjected ? 'Projected Total' : 'Current Total';
        document.getElementById('portfolio-total-value').textContent = fmtCurrencyShort(total);
      }
    });

    // Render vertical legend to the right of pie
    const legend = document.getElementById('portfolio-legend');
    legend.innerHTML = '';
    if (!grouped.length) {
      legend.innerHTML = '<div class="form-hint">Add a vehicle with a Retirement Cash Value in the Data tab to see your portfolio breakdown.</div>';
    } else {
      // Show all standard categories in legend, whether in use or not
      const allCategories = ['Investment', 'Insurance', 'Checking/Savings', 'Other'];
      allCategories.forEach((cat, i) => {
        const g = grouped.find(g => g.category === cat);
        const displayTotal = isProjected ? (projectedTotals[cat] || 0) : (g ? g.total : 0);
        const pct = displayTotal && total > 0 ? Math.round((displayTotal / total) * 100) : 0;
        const row = document.createElement('div');
        row.className = 'legend-row';
        const color = BLUE_PALETTE[i % BLUE_PALETTE.length];
        row.innerHTML = `
          <span class="legend-dot" style="background:${color}"></span>
          <span class="legend-label">${escapeHtml(cat)}</span>
          <span class="legend-pct">${pct}%</span>
        `;
        legend.appendChild(row);
      });
    }

    // Wire up toggle buttons
    if (toggleGroup) {
      toggleOptions.forEach(btn => {
        btn.onclick = () => {
          portfolioView = btn.dataset.view;
          toggleGroup.classList.toggle('projected', portfolioView === 'projected');
          toggleOptions.forEach(opt => opt.classList.toggle('active', opt === btn));
          renderPortfolioChart();
        };
      });
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  // ── Data tab ───────────────────────────────────────────────────────────
  // Purely organizational — groups vehicles in the table and the portfolio
  // chart. Does not feed the projection math (that's driven by RCV /
  // Contribution / Period / Value Added Contribution, per calculator.js).
  const CATEGORIES = ['Investment', 'Insurance', 'Checking/Savings', 'Other'];
  const CATEGORY_ORDER = { Investment: 0, Insurance: 1, 'Checking/Savings': 2, Other: 3 };

  const ACCOUNT_FIELDS = [
    { key: 'company', type: 'text' },
    { key: 'vehicle', type: 'text' },
    { key: 'category', type: 'select', options: ['', ...CATEGORIES] },
    { key: 'benefit', type: 'number' },
  ];
  const CONTRIBUTION_FIELDS = [
    { key: 'contribution', type: 'number' },
    { key: 'period', type: 'select', options: ['', 'Monthly', 'Annually', 'Ad-hoc'] },
    { key: 'addsToRetirementValue', type: 'checkbox' },
  ];

  function renderData() {
    renderVehiclesTable();
    renderCheckinRows();
  }

  // Vehicles sort into category order (Investment, Insurance, Checking/
  // Savings, Other, then Uncategorized) so like types sit together — the
  // Category column itself carries that grouping, no separate banner row.
  function sortedVehiclesWithIndex() {
    return state.data.vehicles
      .map((vehicle, idx) => ({ vehicle, idx }))
      .sort((a, b) => {
        const ca = a.vehicle.category || 'Uncategorized';
        const cb = b.vehicle.category || 'Uncategorized';
        const oa = CATEGORY_ORDER[ca] != null ? CATEGORY_ORDER[ca] : 99;
        const ob = CATEGORY_ORDER[cb] != null ? CATEGORY_ORDER[cb] : 99;
        return oa - ob;
      });
  }

  function buildFieldCell(vehicle, field) {
    const td = document.createElement('td');
    let input;

    // Benefit is a real, separately-tracked config value only for Insurance
    // (a death benefit vs. cash value are genuinely different numbers). For
    // every other category it's the same figure as RCV, so there's nothing
    // to type here — it's auto-mirrored from RCV when a check-in updates it.
    if (field.key === 'benefit' && vehicle.category !== 'Insurance') {
      const span = document.createElement('span');
      span.className = 'cell-readonly cell-na';
      span.textContent = '—';
      td.appendChild(span);
      return td;
    }

    // "Builds cash value?" only means something for Insurance (cash value vs.
    // pure protection). Every other category is told apart by its Category
    // alone, so there is nothing to check here.
    if (field.key === 'addsToRetirementValue' && vehicle.category !== 'Insurance') {
      const span = document.createElement('span');
      span.className = 'cell-readonly cell-na';
      span.textContent = '—';
      td.appendChild(span);
      return td;
    }

    if (field.type === 'select') {
      input = document.createElement('select');
      field.options.forEach(opt => {
        const o = document.createElement('option');
        o.value = opt;
        o.textContent = opt || '—';
        if (vehicle[field.key] === opt) o.selected = true;
        input.appendChild(o);
      });
      input.addEventListener('input', () => {
        vehicle[field.key] = input.value;
        if (field.key === 'category') {
          // Moving off Insurance clears the cash-value flag so a stale "true"
          // can't ride along unseen on a non-insurance row.
          if (input.value !== 'Insurance') vehicle.addsToRetirementValue = false;
          renderVehiclesTable();
          renderCheckinRows();
        }
      });
    } else if (field.type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!vehicle[field.key];
      input.className = 'row-checkbox';
      input.addEventListener('change', () => { vehicle[field.key] = input.checked; });
    } else {
      input = document.createElement('input');
      input.type = field.type;
      input.value = vehicle[field.key] != null ? vehicle[field.key] : '';
      input.addEventListener('input', () => {
        vehicle[field.key] = field.type === 'number'
          ? (input.value === '' ? 0 : parseFloat(input.value))
          : input.value;
      });
    }
    td.appendChild(input);
    return td;
  }

  // Renders as two separate <table>s (Account setup vs. Contribution
  // movement) rather than one wide table, so the row lines of one never
  // visually bleed into the other. Rows are paired across both tables by
  // `data-row-idx` (their shared sorted position) so hovering one
  // highlights its counterpart — see wireRowHoverSync.
  function renderVehiclesTable() {
    const tbodyAccount = document.getElementById('vehicles-tbody-account');
    const tbodyContribution = document.getElementById('vehicles-tbody-contribution');
    tbodyAccount.innerHTML = '';
    tbodyContribution.innerHTML = '';

    sortedVehiclesWithIndex().forEach(({ vehicle, idx }, pos) => {
      const trA = document.createElement('tr');
      trA.dataset.rowIdx = pos;
      ACCOUNT_FIELDS.forEach(field => trA.appendChild(buildFieldCell(vehicle, field)));
      tbodyAccount.appendChild(trA);

      const trC = document.createElement('tr');
      trC.dataset.rowIdx = pos;
      CONTRIBUTION_FIELDS.forEach(field => trC.appendChild(buildFieldCell(vehicle, field)));
      const tdRemove = document.createElement('td');
      const removeBtn = document.createElement('button');
      removeBtn.className = 'row-remove';
      removeBtn.textContent = '×';
      removeBtn.title = 'Remove vehicle';
      removeBtn.addEventListener('click', () => {
        state.data.vehicles.splice(idx, 1);
        renderVehiclesTable();
        renderCheckinRows();
      });
      tdRemove.appendChild(removeBtn);
      trC.appendChild(tdRemove);
      tbodyContribution.appendChild(trC);
    });

    wireRowHoverSync();
  }

  function wireRowHoverSync() {
    const rows = document.querySelectorAll(
      '#vehicles-tbody-account tr[data-row-idx], #vehicles-tbody-contribution tr[data-row-idx]'
    );
    rows.forEach(tr => {
      tr.addEventListener('mouseenter', () => {
        document.querySelectorAll(`tr[data-row-idx="${tr.dataset.rowIdx}"]`)
          .forEach(r => r.classList.add('row-hover-sync'));
      });
      tr.addEventListener('mouseleave', () => {
        document.querySelectorAll(`tr[data-row-idx="${tr.dataset.rowIdx}"]`)
          .forEach(r => r.classList.remove('row-hover-sync'));
      });
    });
  }

  // Whether a vehicle has any balance worth periodically confirming. Keyed
  // off Category (and, for Insurance, "Builds cash value?"), not current RCV,
  // since a brand-new vehicle of a moving-balance type also starts at RCV $0
  // and still needs to show up here to receive its first real number. Only
  // pure-protection Insurance (premium is a pure cost, no cash value — e.g.
  // Term Life) is excluded; everything else belongs in Check-in. An Insurance
  // policy that already carries a balance always belongs here too, even if the
  // box was never checked, so its number can't silently go stale.
  function needsCheckIn(vehicle) {
    if (vehicle.category !== 'Insurance') return true;
    return !!vehicle.addsToRetirementValue || (vehicle.retirementCashValue || 0) > 0;
  }

  // The most recent snapshot logged for a vehicle, if any — used to answer
  // "as of when is this balance current?" honestly, rather than implying
  // today's date for a number that might be the original starting balance.
  function mostRecentSnapshot(vehicleId) {
    const rows = state.data.snapshots.filter(s => s.vehicleId === vehicleId);
    if (!rows.length) return null;
    return rows.reduce((latest, s) => (s.date > latest.date ? s : latest), rows[0]);
  }

  function renderCheckinRows() {
    const tbody = document.getElementById('checkin-tbody');
    tbody.innerHTML = '';
    const candidates = sortedVehiclesWithIndex().filter(({ vehicle }) => needsCheckIn(vehicle));
    if (!candidates.length) {
      const msg = state.data.vehicles.length
        ? 'None of your current vehicles have a balance to check in on — protection-only policies (like term life) are configured once in Retirement Vehicles above and never need a balance update.'
        : 'Add at least one vehicle above before logging a check-in.';
      tbody.innerHTML = `<tr><td colspan="5" class="form-hint">${escapeHtml(msg)}</td></tr>`;
      return;
    }
    candidates.forEach(({ vehicle }) => {
      const tr = document.createElement('tr');
      const lastSnapshot = mostRecentSnapshot(vehicle.id);
      const lastBalanceSub = lastSnapshot
        ? `as of ${fmtDate(lastSnapshot.date)}`
        : 'starting balance — no check-ins logged yet';
      tr.innerHTML = `
        <td>${escapeHtml(vehicle.company || '—')}</td>
        <td>${escapeHtml(vehicle.vehicle || '—')}</td>
        <td>${escapeHtml(vehicle.category || '—')}</td>
        <td>
          ${escapeHtml(fmtCurrency(vehicle.retirementCashValue || 0))}
          <div class="cell-sub">${escapeHtml(lastBalanceSub)}</div>
        </td>
      `;
      const td = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number';
      input.placeholder = String(vehicle.retirementCashValue || 0);
      // Carries the vehicle's stable id, so the snapshot this creates links
      // back to the exact account for period-over-period comparison later
      // (see snapshots[].vehicleId, written in save-checkin-btn below).
      input.dataset.vehicleId = vehicle.id;
      td.appendChild(input);
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
  }

  function wireDataTab() {
    document.getElementById('add-vehicle-btn').addEventListener('click', () => {
      state.data.vehicles.push({
        id: uid('veh'),
        company: '', vehicle: '', category: '', benefit: 0,
        retirementCashValue: 0, contribution: 0, period: '',
        addsToRetirementValue: false,
      });
      renderVehiclesTable();
      renderCheckinRows();
    });

    document.getElementById('save-vehicles-btn').addEventListener('click', async () => {
      await postJSON(API.data, state.data);
      state.projection = await getJSON(API.projection);
      renderPresentation();
      showToast('Vehicles saved');
    });

    document.getElementById('save-checkin-btn').addEventListener('click', async () => {
      const inputs = document.querySelectorAll('#checkin-tbody input[data-vehicle-id]');
      const checkInId = uid('chk');
      const date = new Date().toISOString().slice(0, 10);
      let changedAny = false;

      inputs.forEach(input => {
        if (input.value === '') return;
        const vehicle = state.data.vehicles.find(v => v.id === input.dataset.vehicleId);
        if (!vehicle) return;
        const newBalance = parseFloat(input.value);
        state.data.snapshots.push({
          checkInId, date, vehicleId: vehicle.id,
          balance: newBalance,
          contributionAtTime: vehicle.contribution || 0,
          note: '',
        });
        vehicle.retirementCashValue = newBalance;
        // Benefit only diverges from RCV for Insurance (death benefit vs.
        // cash value are genuinely different numbers there); for every
        // other category they're the same figure, kept in sync here so
        // there's nothing to double-enter in the Data tab.
        if (vehicle.category !== 'Insurance') vehicle.benefit = newBalance;
        changedAny = true;
      });

      if (!changedAny) {
        showToast('No balances entered');
        return;
      }

      await postJSON(API.data, state.data);

      // Check-in is the one moment this app recomputes and persists the
      // projection (see server.js) — a plain GET would just re-read
      // whatever was last computed, which at this instant is now stale.
      state.projection = await postJSON(API.projectionRecompute, {});

      // Captures both "what actually happened" (the balances just entered,
      // already in snapshots above) and "what we now expect going forward"
      // side by side — so a future check-in can compare its own prediction
      // against what this one assumed, not just against raw balances.
      const mc = state.projection.monteCarlo;
      const idx = state.projection.yearsToRetirement;
      state.data.assessments.push({
        checkInId, date,
        destinationNumber: state.config.destinationNumber || 0,
        projectedBalance: state.projection.totalProjected,
        gap: state.projection.gap,
        status: trajectoryStatus(state.projection).label,
        projectedMedianAtTargetAge: mc && mc.median ? mc.median[idx] : null,
        projectedP20AtTargetAge: mc && mc.p20 ? mc.p20[idx] : null,
        projectedP80AtTargetAge: mc && mc.p80 ? mc.p80[idx] : null,
      });
      await postJSON(API.data, state.data);

      renderVehiclesTable();
      renderCheckinRows();
      renderPresentation();
      showToast('Check-in logged');
    });
  }

  // ── Configuration tab — interview wizard ────────────────────────────────
  // Short, conversational, one question at a time (TurboTax-style), rather
  // than a flat form of labeled boxes. Desired retirement age + desired
  // income are first-class questions here specifically so Presentation can
  // compare "what you want" against what the projection actually produces
  // (see solvedAge in the /api/projection response).

  function ensurePrimaryPerson(cfg) {
    cfg.household = (cfg.household && cfg.household.length) ? cfg.household : [{}];
    cfg.household[0] = cfg.household[0] || {};
    return cfg.household[0];
  }
  function ensureHelper(cfg) {
    cfg.destinationNumberHelper = cfg.destinationNumberHelper || {};
    return cfg.destinationNumberHelper;
  }
  function suggestedDestinationNumber(cfg) {
    const helper = cfg.destinationNumberHelper || {};
    const desired = helper.desiredAnnualIncome || 0;
    const ss = helper.socialSecurityEstimate || 0;
    if (!desired) return null;
    const net = Math.max(0, desired - ss);
    return net / 0.04;
  }

  const WIZARD_STEPS = [
    {
      id: 'name',
      question: 'What should we call you?',
      sub: 'This is how Waypoint will greet you on the home screen.',
      kind: 'text',
      placeholder: 'Alex',
      get: cfg => ensurePrimaryPerson(cfg).name || '',
      set: (cfg, val) => { ensurePrimaryPerson(cfg).name = val; },
    },
    {
      id: 'dob',
      question: 'When were you born?',
      sub: 'We use this to figure your current age and years to retirement.',
      kind: 'date',
      get: cfg => ensurePrimaryPerson(cfg).dateOfBirth || '',
      set: (cfg, val) => { ensurePrimaryPerson(cfg).dateOfBirth = val; },
    },
    {
      id: 'targetAge',
      question: 'By what age would you like to retire?',
      sub: "The age you're aiming for — we'll compare it to what your current plan actually produces.",
      kind: 'number',
      placeholder: '62',
      get: cfg => cfg.targetRetirementAge || '',
      set: (cfg, val) => { cfg.targetRetirementAge = val; },
    },
    {
      id: 'desiredIncome',
      question: 'What annual income would you like to live on in retirement?',
      sub: "In today's dollars — we'll adjust for inflation later.",
      kind: 'number',
      placeholder: '90000',
      get: cfg => ensureHelper(cfg).desiredAnnualIncome || '',
      set: (cfg, val) => { ensureHelper(cfg).desiredAnnualIncome = val; },
    },
    {
      id: 'ssEstimate',
      question: 'Will Social Security or a pension cover part of that?',
      sub: 'Rough estimate is fine — about how much per year? Enter 0 if none.',
      kind: 'number',
      placeholder: '0',
      get: cfg => ensureHelper(cfg).socialSecurityEstimate || '',
      set: (cfg, val) => { ensureHelper(cfg).socialSecurityEstimate = val; },
    },
    {
      id: 'destinationNumber',
      question: "Here's a target that could work.",
      kind: 'number',
      dynamicSub: cfg => {
        const suggestion = suggestedDestinationNumber(cfg);
        return suggestion
          ? `Based on what you told us — ${fmtCurrency(suggestion)} would support that income at a 4% withdrawal rate. Adjust it if you already have a number, from an advisor or otherwise.`
          : "A direct, editable number — ideally from an advisor conversation, or your own gut number.";
      },
      get: cfg => cfg.destinationNumber || suggestedDestinationNumber(cfg) || '',
      set: (cfg, val) => { cfg.destinationNumber = val; },
    },
    { id: 'done', kind: 'done' },
  ];
  const DATA_STEP_COUNT = WIZARD_STEPS.length - 1;

  // The wizard-card UI is used for the first-time sequential setup walk,
  // and can be manually re-triggered in full (the wand icon) from the
  // paragraph view. Editing a single answer from the paragraph instead
  // opens the field modal — see openFieldModal.
  let wizardStepIndex = 0;

  function isSetupComplete(cfg) {
    const p = (cfg.household && cfg.household[0]) || {};
    return !!(p.name && p.dateOfBirth && cfg.targetRetirementAge && cfg.destinationNumber);
  }
  function firstIncompleteStepIndex(cfg) {
    for (let i = 0; i < DATA_STEP_COUNT; i++) {
      if (!WIZARD_STEPS[i].get(cfg)) return i;
    }
    return 0;
  }

  function renderConfiguration() {
    if (isSetupComplete(state.config)) {
      showConfigSummary();
    } else {
      openWizard(firstIncompleteStepIndex(state.config));
    }
  }

  function showConfigSummary() {
    document.getElementById('config-wizard').classList.add('hidden');
    document.getElementById('config-summary').classList.remove('hidden');
    renderPlanParagraph();
    renderAdvancedPanel();
    document.getElementById('cfg-coach-notes').value = state.config.coachNotes || '';
  }

  function openWizard(stepIndex) {
    wizardStepIndex = stepIndex;
    document.getElementById('config-summary').classList.add('hidden');
    document.getElementById('config-wizard').classList.remove('hidden');
    renderWizardStep();
  }

  function renderWizardStep() {
    const step = WIZARD_STEPS[wizardStepIndex];
    const cfg = state.config;

    const progress = document.getElementById('wizard-progress');
    if (step.kind === 'done') {
      progress.innerHTML = '';
    } else {
      progress.innerHTML = WIZARD_STEPS.slice(0, DATA_STEP_COUNT).map((_, i) => {
        const cls = i === wizardStepIndex ? 'active' : (i < wizardStepIndex ? 'done' : '');
        return `<div class="dot ${cls}"></div>`;
      }).join('');
    }

    const questionEl = document.getElementById('wizard-question');
    const subEl = document.getElementById('wizard-sub');
    const inputArea = document.getElementById('wizard-input-area');
    const backBtn = document.getElementById('wizard-back-btn');
    const nextBtn = document.getElementById('wizard-next-btn');
    inputArea.innerHTML = '';

    if (step.kind === 'done') {
      const p = ensurePrimaryPerson(cfg);
      questionEl.textContent = `You're all set, ${p.name || 'there'}.`;
      subEl.textContent = "We'll compare where you're headed against what you told us here every time you open Waypoint.";
      inputArea.innerHTML = `
        <div class="wizard-done-actions">
          <button class="btn-primary" id="wizard-goto-presentation">See my plan</button>
          <button class="btn-secondary" id="wizard-goto-summary">Review my answers</button>
        </div>
      `;
      backBtn.style.visibility = 'hidden';
      nextBtn.style.display = 'none';
      document.getElementById('wizard-close-btn').classList.add('hidden');
      document.getElementById('wizard-goto-presentation').addEventListener('click', () => {
        location.hash = '#presentation';
      });
      document.getElementById('wizard-goto-summary').addEventListener('click', showConfigSummary);
      return;
    }

    nextBtn.style.display = '';
    backBtn.style.visibility = wizardStepIndex > 0 ? 'visible' : 'hidden';
    nextBtn.textContent = wizardStepIndex === DATA_STEP_COUNT - 1 ? 'Finish' : 'Next';
    document.getElementById('wizard-close-btn').classList.remove('hidden');

    questionEl.textContent = step.question;
    subEl.textContent = step.dynamicSub ? step.dynamicSub(cfg) : (step.sub || '');

    const input = document.createElement('input');
    input.type = step.kind === 'date' ? 'date' : (step.kind === 'number' ? 'number' : 'text');
    if (step.placeholder) input.placeholder = step.placeholder;
    input.value = step.get(cfg);
    input.id = 'wizard-current-input';
    inputArea.appendChild(input);
    setTimeout(() => input.focus(), 0);

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); nextBtn.click(); }
    });
  }

  async function persistConfig() {
    await postJSON(API.config, state.config);
    state.projection = await getJSON(API.projection);
  }

  async function wizardCommitCurrentStep() {
    const step = WIZARD_STEPS[wizardStepIndex];
    const input = document.getElementById('wizard-current-input');
    if (!input) return;
    const val = step.kind === 'number'
      ? (input.value === '' ? 0 : parseFloat(input.value))
      : input.value;
    step.set(state.config, val);
    await persistConfig();
  }

  function wireWizardNav() {
    document.getElementById('wizard-back-btn').addEventListener('click', () => {
      if (wizardStepIndex > 0) { wizardStepIndex--; renderWizardStep(); }
    });

    document.getElementById('wizard-next-btn').addEventListener('click', async () => {
      // Commit is async (persists over the network before advancing) —
      // guard against a rapid double-click or slow connection landing a
      // second commit before the first one's finished, which could write
      // the wrong step's value into the wrong field.
      const nextBtn = document.getElementById('wizard-next-btn');
      const backBtn = document.getElementById('wizard-back-btn');
      if (nextBtn.disabled) return;
      nextBtn.disabled = true;
      backBtn.disabled = true;
      try {
        await wizardCommitCurrentStep();
        if (wizardStepIndex < WIZARD_STEPS.length - 1) {
          wizardStepIndex++;
          renderWizardStep();
        }
      } finally {
        nextBtn.disabled = false;
        backBtn.disabled = false;
      }
    });
  }

  // ── Plan paragraph — return-visit landing view ──────────────────────────
  // Reads as the coach's own voice describing the plan back to you. Each
  // captured value is an inline fill-in-the-blank; clicking one opens the
  // field modal scoped to just that question (openFieldModal). The wand
  // icon instead re-runs the full wizard sequence, pre-filled.
  function renderPlanParagraph() {
    const cfg = state.config;
    const p = ensurePrimaryPerson(cfg);
    const helper = cfg.destinationNumberHelper || {};
    const el = document.getElementById('plan-paragraph');

    const fill = (stepIndex, text) =>
      `<span class="paragraph-fill" data-step="${stepIndex}">${escapeHtml(text)}</span>`;

    el.innerHTML =
      `Hi ${fill(0, p.name || 'there')}! Waypoint understands that you were born on ` +
      `${fill(1, p.dateOfBirth || '—')} and wish to retire by the age of ` +
      `${fill(2, String(cfg.targetRetirementAge || '—'))}. In retirement, you'd prefer to live on ` +
      `${fill(3, fmtCurrency(helper.desiredAnnualIncome || 0) + '/yr')} while expecting supplemental income ` +
      `from Social Security or pension of ${fill(4, fmtCurrency(helper.socialSecurityEstimate || 0) + '/yr')} ` +
      `beyond your Data Vehicles. By the time you retire, you'd like to have ` +
      `${fill(5, fmtCurrency(cfg.destinationNumber || 0))} total in the bank to feel like you can retire ` +
      `comfortably. As you're supported via Waypoint, your coach will provide you a ` +
      `<span class="paragraph-fill disabled" title="Only one voice available for now">centered</span> tone of assistance.`;

    el.querySelectorAll('.paragraph-fill[data-step]').forEach(span => {
      span.addEventListener('click', () => openFieldModal(parseInt(span.dataset.step, 10)));
    });
  }

  // ── Field modal — editing a single paragraph value ──────────────────────
  let modalStepIndex = null;

  function openFieldModal(stepIndex) {
    modalStepIndex = stepIndex;
    const step = WIZARD_STEPS[stepIndex];
    const cfg = state.config;

    document.getElementById('modal-question').textContent = step.question;
    document.getElementById('modal-sub').textContent = step.dynamicSub ? step.dynamicSub(cfg) : (step.sub || '');

    const inputArea = document.getElementById('modal-input-area');
    inputArea.innerHTML = '';
    const input = document.createElement('input');
    input.type = step.kind === 'date' ? 'date' : (step.kind === 'number' ? 'number' : 'text');
    if (step.placeholder) input.placeholder = step.placeholder;
    input.value = step.get(cfg);
    input.id = 'modal-current-input';
    inputArea.appendChild(input);

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('modal-save-btn').click(); }
      if (e.key === 'Escape') { closeFieldModal(); }
    });

    document.getElementById('field-modal-overlay').classList.remove('hidden');
    setTimeout(() => input.focus(), 0);
  }

  function closeFieldModal() {
    document.getElementById('field-modal-overlay').classList.add('hidden');
    modalStepIndex = null;
  }

  function wireFieldModal() {
    document.getElementById('modal-cancel-btn').addEventListener('click', closeFieldModal);
    document.getElementById('field-modal-overlay').addEventListener('click', e => {
      if (e.target.id === 'field-modal-overlay') closeFieldModal();
    });
    document.getElementById('modal-save-btn').addEventListener('click', async () => {
      if (modalStepIndex == null) return;
      const step = WIZARD_STEPS[modalStepIndex];
      const input = document.getElementById('modal-current-input');
      const val = step.kind === 'number' ? (input.value === '' ? 0 : parseFloat(input.value)) : input.value;
      step.set(state.config, val);
      await persistConfig();
      closeFieldModal();
      renderPlanParagraph();
      renderPresentation();
    });
  }

  // ── Advanced panel — projection rates, inflation (collapsed by default) ─
  function renderAdvancedPanel() {
    const cfg = state.config;
    document.getElementById('cfg-inflation').value = cfg.inflationRate != null ? cfg.inflationRate : '';

    const rates = cfg.projectionRates || {};
    document.getElementById('cfg-rate-min').value = rates.min != null ? rates.min : '';
    document.getElementById('cfg-rate-max').value = rates.max != null ? rates.max : '';
    document.getElementById('cfg-rate-upside').value = rates.upside != null ? rates.upside : '';
  }

  function wireConfigurationTab() {
    wireWizardNav();
    wireFieldModal();

    document.getElementById('wizard-restart-btn').addEventListener('click', () => openWizard(0));

    // Escape hatch mid-wizard. Re-runs the same completeness check the tab
    // uses on entry: if setup is done (e.g. re-walking via the wand), this
    // drops straight back to the paragraph summary; if it's a genuinely
    // incomplete first-time setup, it re-anchors at the first unanswered
    // question rather than leaving a dead end with nowhere to go.
    document.getElementById('wizard-close-btn').addEventListener('click', () => renderConfiguration());

    document.getElementById('advanced-toggle').addEventListener('click', () => {
      const toggle = document.getElementById('advanced-toggle');
      const body = document.getElementById('advanced-body');
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!expanded));
      body.classList.toggle('hidden', expanded);
    });

    document.getElementById('save-notes-btn').addEventListener('click', async () => {
      state.config.coachNotes = document.getElementById('cfg-coach-notes').value;
      await persistConfig();
      showToast('Notes saved');
    });

    document.getElementById('save-config-btn').addEventListener('click', async () => {
      const cfg = state.config;
      cfg.inflationRate = parseFloat(document.getElementById('cfg-inflation').value) || 0;
      cfg.projectionRates = {
        min: parseFloat(document.getElementById('cfg-rate-min').value) || 0,
        max: parseFloat(document.getElementById('cfg-rate-max').value) || 0,
        upside: parseFloat(document.getElementById('cfg-rate-upside').value) || 0,
      };
      cfg.coachTone = 'centered';

      await persistConfig();
      renderPresentation();
      showToast('Configuration saved');
    });
  }

  // ── boot ───────────────────────────────────────────────────────────────
  async function init() {
    const [config, data] = await Promise.all([getJSON(API.config), getJSON(API.data)]);
    state.config = config;
    state.data = data;
    state.projection = await getJSON(API.projection);

    wireDataTab();
    wireConfigurationTab();

    document.getElementById('run-analysis-btn').addEventListener('click', () => {
      showCoachModal(state.config);
    });

    renderPresentation();
    showView(currentRouteName());
  }

  // ── Coach analysis functions ────────────────────────────────────────
  async function loadCoachAnalysis() {
    try {
      const res = await fetch('/waypoint-app/api/coach-analyses');
      if (!res.ok) return;
      const analyses = await res.json();
      state.latestAnalysis = analyses && analyses.length ? analyses[analyses.length - 1] : null;
    } catch (e) {
      // coach analyses optional — app works without them
    }
  }

  function renderCoachPanel(projection, config) {
    const analysis = state.latestAnalysis;

    // Render verdict/heading
    if (analysis && analysis.verdict) {
      document.getElementById('coach-name-heading').textContent = analysis.verdict;
      // Hide placeholder text when analysis exists
      const coachBody = document.querySelector('.coach-body');
      if (coachBody) coachBody.style.display = 'none';
    }

    // Render recommendations
    const recContainer = document.querySelector('.coach-col-recs');
    if (!recContainer || !analysis || !analysis.recommendations) return;

    const existingRecs = recContainer.querySelectorAll('.coach-rec');
    existingRecs.forEach(r => r.remove());

    analysis.recommendations.slice(0, 3).forEach((rec, i) => {
      const div = document.createElement('div');
      div.className = 'coach-rec';
      div.innerHTML = `
        <div class="coach-rec-num">${i + 1}</div>
        <div>
          <div class="coach-rec-title">${rec.title}</div>
          <div class="coach-rec-sub">${rec.description}</div>
        </div>
      `;
      recContainer.appendChild(div);
    });

    // Wire up explore link — only when analysis exists
    const exploreLink = document.querySelector('.coach-scenarios-link');
    if (exploreLink) {
      if (analysis && analysis.fullReport) {
        exploreLink.style.pointerEvents = 'auto';
        exploreLink.style.opacity = '1';
        exploreLink.onclick = (e) => {
          e.preventDefault();
          showFullReport(analysis);
        };
      } else {
        // Disable the link if no analysis
        exploreLink.style.pointerEvents = 'none';
        exploreLink.style.opacity = '0.5';
        exploreLink.onclick = (e) => e.preventDefault();
      }
    }
  }

  window.showCoachModal = function(config) {
    const existing = document.getElementById('coach-modal-overlay');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'coach-modal-overlay';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:1000;';

    modal.innerHTML = `
      <div style="background:white;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.15);max-width:500px;width:90%;max-height:80vh;overflow-y:auto;padding:24px;color:#333;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h2 style="margin:0;font-size:18px;font-weight:600;">What's on your mind?</h2>
          <button id="coach-modal-close" style="background:none;border:none;font-size:24px;cursor:pointer;padding:0;width:24px;height:24px;">×</button>
        </div>

        <p style="color:#666;font-size:13px;margin:0 0 12px 0;">Before we analyze your numbers, what's worth knowing? Any concerns, opportunities, or changes you're thinking about?</p>

        <textarea id="coach-concerns-input" placeholder="e.g. Considering a major change to contributions, have questions about liquidity, thinking about timeline adjustments..." style="width:100%;min-height:100px;padding:12px;border:1px solid #ddd;border-radius:8px;font-family:inherit;font-size:13px;resize:vertical;box-sizing:border-box;margin-bottom:16px;"></textarea>

        <div style="display:flex;gap:8px;margin-bottom:12px;">
          <button id="coach-modal-cancel" style="flex:1;padding:10px;border:1px solid #ddd;background:#f5f5f5;border-radius:6px;cursor:pointer;font-size:14px;">Cancel</button>
          <button id="coach-analyze-btn" style="flex:1;padding:10px;background:#B8783D;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;">Run Analysis</button>
        </div>

        <div id="coach-status" style="font-size:12px;color:#666;min-height:16px;"></div>
      </div>
    `;

    document.body.appendChild(modal);

    // Wire up button handlers with addEventListener
    const closeBtn = document.getElementById('coach-modal-close');
    const cancelBtn = document.getElementById('coach-modal-cancel');
    const analyzeBtn = document.getElementById('coach-analyze-btn');

    closeBtn.addEventListener('click', () => {
      const overlay = document.getElementById('coach-modal-overlay');
      if (overlay) overlay.remove();
    });

    cancelBtn.addEventListener('click', () => {
      const overlay = document.getElementById('coach-modal-overlay');
      if (overlay) overlay.remove();
    });

    analyzeBtn.addEventListener('click', () => {
      window.runCoachAnalysis();
    });

    document.getElementById('coach-concerns-input').focus();
  }

  window.runCoachAnalysis = async function() {
    const concerns = document.getElementById('coach-concerns-input').value;
    const btn = document.getElementById('coach-analyze-btn');
    const status = document.getElementById('coach-status');

    btn.disabled = true;
    btn.textContent = 'Analyzing…';
    status.textContent = 'Running analysis (2-3 minutes)…';
    status.style.color = '#666';

    try {
      const res = await fetch('/waypoint-app/api/projection/coach-analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userConcerns: concerns })
      });

      let result;
      try {
        result = await res.json();
      } catch (parseErr) {
        status.style.color = '#d32f2f';
        status.textContent = `Server error (could not parse response). Check server logs for details.`;
        btn.disabled = false;
        btn.textContent = 'Run Analysis';
        return;
      }

      if (!res.ok || !result.ok) {
        status.style.color = '#d32f2f';
        status.textContent = `Failed: ${result.error || 'Unknown error'}`;
        btn.disabled = false;
        btn.textContent = 'Run Analysis';
        return;
      }

      // Success — close modal and refresh panel
      await loadCoachAnalysis();
      renderCoachPanel(state.projection, state.config);
      document.getElementById('coach-modal-overlay').remove();
      showToast('Coach analysis complete');
    } catch (e) {
      status.style.color = '#d32f2f';
      status.textContent = `Error: ${e.message}`;
      btn.disabled = false;
      btn.textContent = 'Run Analysis';
    }
  };

  window.showFullReport = function(analysis) {
    const existing = document.getElementById('full-report-overlay');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'full-report-overlay';
    modal.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:1000;';

    // Clean up and parse markdown with better typography
    let rawReport = (analysis.fullReport || '')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/^## (.+)$/gm, '\n<section><h2>$1</h2>');

    // Split into sections and rebuild with proper structure
    const sections = rawReport.split('<section>').filter(s => s.trim());
    const styledReport = sections.map(section => {
      const lines = section.split('\n').filter(l => l.trim());
      if (lines.length === 0) return '';

      const heading = lines[0].replace(/<\/?h2>/g, '').trim();
      const content = lines.slice(1).filter(l => l.trim()).join('\n');

      return `
        <div style="margin-bottom:32px;">
          <div style="margin-bottom:14px;">
            <h3 style="font-size:17px;font-weight:600;color:#3F4E5C;margin:0 0 8px 0;line-height:1.4;">${heading}</h3>
          </div>
          <div style="font-size:13px;line-height:1.8;color:#666;">
            ${content.split('\n').map(line => {
              if (!line.trim()) return '';
              return line.includes('<strong>')
                ? `<p style="margin:8px 0;">${line}</p>`
                : `<p style="margin:8px 0;">${line}</p>`;
            }).join('')}
          </div>
        </div>
      `;
    }).join('');

    modal.innerHTML = `
      <div style="background:white;border-radius:12px;box-shadow:0 10px 40px rgba(0,0,0,0.15);max-width:700px;width:90%;max-height:85vh;overflow-y:auto;padding:32px;color:#333;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:28px;">
          <h2 style="margin:0;font-size:22px;font-weight:600;color:#B8783D;">Analysis</h2>
          <button style="background:none;border:none;font-size:28px;cursor:pointer;padding:0;width:28px;height:28px;line-height:1;color:#999;flex-shrink:0;margin-left:16px;" onclick="document.getElementById('full-report-overlay').remove()">×</button>
        </div>

        <div>${styledReport}</div>

        <button style="margin-top:32px;width:100%;padding:12px;background:#B8783D;color:white;border:none;border-radius:6px;cursor:pointer;font-size:14px;font-weight:500;" onclick="document.getElementById('full-report-overlay').remove()">Close</button>
      </div>
    `;

    document.body.appendChild(modal);
  }

  init();
})();
