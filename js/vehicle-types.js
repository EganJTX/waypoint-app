// The single source of truth for what each kind of vehicle IS and how
// Waypoint treats it. Everything else reads from this table: the projection
// engine (calculator.js, server.js), the Data tab dropdown and check-in rules
// (app.js), and the coach's account guide (scripts/coach-analyze.js).
//
// To add a new kind of account (a 529 plan, an HSA, ...), add ONE row to TYPES.
// Nothing else needs to know about it. To ask "how is X treated?", read the row.
//
// Fields per type:
//   id                       stable key, stored on each vehicle as `type`
//   group                    parent category shown in the dropdown and donut
//   label / products         plain-language name, and the product names people
//                            will recognize it by (shown in parentheses)
//   growth                   how the projection moves its balance:
//                              'market'        compounds at the market-rate range
//                                              (simulated) plus contributions
//                              'contributions' balance plus contributions only,
//                                              no growth (linear)
//                              'flat'          held at its current balance
//                              'none'          not part of the projection at all
//   countsTowardRetirement   whether the balance counts toward the retirement
//                            goal (every type is 'yes' for now; reserved for
//                            earmarked money like a college fund)
//   moneyRole                'building' | 'buffer' | 'protectionCost' | 'other'
//                            what contributions to it mean (reserved for a
//                            future "where your money goes" view)
//   needsCheckIn             whether it appears in Log a Check-in
//   help                     plain-language description shown to the user
//   coachNote                how the projection treats it, written for the coach
//
// Works in the browser (window.VehicleTypes) and in Node (require).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VehicleTypes = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Display order for groups, in the Data tab dropdown and the portfolio donut.
  const GROUPS = ['Investment', 'Insurance', 'Checking/Savings', 'Other'];

  const TYPES = [
    {
      id: 'investment',
      group: 'Investment',
      label: 'Investment account',
      products: '401k, IRA, brokerage',
      growth: 'market',
      countsTowardRetirement: true,
      moneyRole: 'building',
      needsCheckIn: true,
      help: 'Money invested in the market. It can grow, and it can dip.',
      coachNote: 'Grown at the assumed market range from the profile, plus recurring contributions. This is the only kind of account modeled with market growth.',
    },
    {
      id: 'cash_value_life',
      group: 'Insurance',
      label: 'Life insurance: builds cash value',
      products: 'whole life, universal, paid-up',
      growth: 'contributions',
      countsTowardRetirement: true,
      moneyRole: 'building',
      needsCheckIn: true,
      help: 'Pays your family and also builds a cash balance over time that you can borrow against or withdraw from. Your statement lists a "cash value" or "surrender value."',
      coachNote: 'Carries both a death benefit and a cash balance. Carried forward with its contributions only, no growth or dividends, because the policy cap is unknown, so the projection likely understates its real growth. Its contributions are fair to discuss, but do not assume the policy can absorb unlimited extra funding.',
    },
    {
      id: 'term_life',
      group: 'Insurance',
      label: 'Life insurance: protection only',
      products: 'term life',
      growth: 'none',
      countsTowardRetirement: false,
      moneyRole: 'protectionCost',
      needsCheckIn: false,
      help: 'Pays your family if something happens to you. It builds no cash value, so there is nothing to borrow or withdraw. Your statement will not list a cash value.',
      coachNote: 'The family safety net if something happens to the insured. It holds no cash value, and the premium is the cost of that net, not retirement savings. It is left out of the projection and listed separately as context. Never suggest increasing, redirecting, or finding more money for it, and never count it as a retirement asset.',
    },
    {
      id: 'checking',
      group: 'Checking/Savings',
      label: 'Checking',
      products: '',
      growth: 'contributions',
      countsTowardRetirement: true,
      moneyRole: 'buffer',
      needsCheckIn: true,
      help: 'Day-to-day spending money.',
      coachNote: 'Day-to-day spending and emergency access. Carried forward with any contributions only. Never recommend moving checking balances.',
    },
    {
      id: 'savings',
      group: 'Checking/Savings',
      label: 'Savings',
      products: '',
      growth: 'contributions',
      countsTowardRetirement: true,
      moneyRole: 'buffer',
      needsCheckIn: true,
      help: 'Money set aside that earns little or no market growth and is easy to access.',
      coachNote: 'A liquid buffer. Carried forward with its contributions only, no interest or market growth, so the projection likely understates it. Do not say it earns market returns, and do not recommend draining it fully.',
    },
    {
      id: 'other',
      group: 'Other',
      label: 'Other',
      products: '',
      growth: 'flat',
      countsTowardRetirement: true,
      moneyRole: 'other',
      needsCheckIn: true,
      help: 'Anything that does not fit above. It is carried forward at its current balance.',
      coachNote: 'Held flat at its current balance.',
    },
  ];

  const byId = {};
  TYPES.forEach(t => { byId[t.id] = t; });

  // Existing vehicles saved before types existed have only a `category` (and,
  // for insurance, the old cash-value checkbox). Work out the type they were
  // already being treated as, so nothing about their numbers changes.
  // Returns '' when there is not enough to go on (a brand-new blank row).
  function inferTypeId(vehicle) {
    if (vehicle && vehicle.type && byId[vehicle.type]) return vehicle.type;
    switch (vehicle && vehicle.category) {
      case 'Investment': return 'investment';
      case 'Insurance':
        return (vehicle.addsToRetirementValue || (vehicle.retirementCashValue || 0) > 0)
          ? 'cash_value_life' : 'term_life';
      case 'Checking/Savings':
        return /checking/i.test(vehicle.vehicle || '') ? 'checking' : 'savings';
      case 'Other': return 'other';
      default: return '';
    }
  }

  // The type object that governs a vehicle. Anything unrecognized is treated
  // as 'Other' (held flat), which matches how unknown categories always behaved.
  function typeOf(vehicle) {
    return byId[inferTypeId(vehicle)] || byId.other;
  }

  // Parent group of a vehicle ('' if it has none yet).
  function groupOf(vehicle) {
    if (vehicle && vehicle.type && byId[vehicle.type]) return byId[vehicle.type].group;
    return (vehicle && vehicle.category) || '';
  }

  function growthOf(vehicle) {
    return typeOf(vehicle).growth;
  }

  function typesInGroup(group) {
    return TYPES.filter(t => t.group === group);
  }

  // "Label (products)" as shown in the Data tab dropdown.
  function displayLabel(type) {
    return type.products ? `${type.label} (${type.products})` : type.label;
  }

  // The account guide handed to the coach, generated from the table so the
  // coach's understanding can never drift from the real treatment.
  function coachGuide() {
    return TYPES
      .map(t => `- ${displayLabel(t)}: ${t.coachNote}`)
      .join('\n');
  }

  return {
    GROUPS, TYPES, byId,
    inferTypeId, typeOf, groupOf, growthOf, typesInGroup, displayLabel, coachGuide,
  };
});
