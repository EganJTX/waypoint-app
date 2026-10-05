# Design notes

Ideas that are intentionally **not built yet**, so they aren't lost. Nothing here changes how Waypoint works today.

## Where the types table stands
Every vehicle has a **Type** that belongs to a parent group. The table in `js/vehicle-types.js` is the single source of truth for how each type is treated: the projection, the Data tab, the check-in rule, and the coach's account guide all read from it. See the README for the current table.

Reserved fields in that table that don't change anything yet:
- `countsTowardRetirement`: every type is "yes" today. The first real use will be earmarked money such as a college fund or a real 529 plan (tracked, but not counted toward the retirement goal).
- `moneyRole` (`building`, `buffer`, `protectionCost`, `other`): for the "where your money goes" idea below.

## Parked: "where your money goes" view
Show monthly contributions split by what the money is doing: building retirement, earmarked or buffer savings, or a protection cost (term life, which is money out that can't be used for retirement). Pair it with checking and savings behavior as a whole, so the coach can judge whether the user is saving enough and where non-checking dollars go when they set money aside.

It needs data Waypoint already has: per-vehicle contributions, plus the check-in snapshots over time.

## Parked: "ends in" dates
An optional end date for a contribution would let the coach say when money frees up: a 20-year term policy that stops, or college-fund contributions that stop when the child starts school.

## Known simplifications
- Cash value insurance is modeled as balance plus contributions, with no growth and no cap, because the real cap is unknown.
- Savings and checking get no interest; only Investment accounts grow at the market-rate range.
