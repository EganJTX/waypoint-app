// US market history the Monte Carlo draws from, instead of a hand-picked
// rate range. Each simulated year is a real year from this record.
//
// Source: Aswath Damodaran (NYU Stern), "Historical Returns on Stocks, Bonds
// and Bills - United States", histretSP.xls, years 1928-2025. Inflation is the
// CPI annual change (FRED CPIAUCNS) from the same file. Total returns,
// nominal, rounded to 4 decimals.
//
//   STOCKS      S&P 500 including dividends
//   BONDS       10-year US Treasury bond
//   INFLATION   CPI, year over year
//
// Works in the browser (window.HistoricalReturns) and in Node (require).

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HistoricalReturns = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const FIRST_YEAR = 1928;

  const STOCKS = [
  0.4381, -0.0830, -0.2512, -0.4384, -0.0864, 0.4998, -0.0119, 0.4674, 0.3194, -0.3534,
  0.2928, -0.0110, -0.1067, -0.1277, 0.1917, 0.2506, 0.1903, 0.3582, -0.0843, 0.0520,
  0.0570, 0.1830, 0.3081, 0.2368, 0.1815, -0.0121, 0.5256, 0.3260, 0.0744, -0.1046,
  0.4372, 0.1206, 0.0034, 0.2664, -0.0881, 0.2261, 0.1642, 0.1240, -0.0997, 0.2380,
  0.1081, -0.0824, 0.0356, 0.1422, 0.1876, -0.1431, -0.2590, 0.3700, 0.2383, -0.0698,
  0.0651, 0.1852, 0.3174, -0.0470, 0.2042, 0.2234, 0.0615, 0.3124, 0.1849, 0.0581,
  0.1654, 0.3148, -0.0306, 0.3023, 0.0749, 0.0997, 0.0133, 0.3720, 0.2268, 0.3310,
  0.2834, 0.2089, -0.0903, -0.1185, -0.2197, 0.2836, 0.1074, 0.0483, 0.1561, 0.0548,
  -0.3655, 0.2594, 0.1482, 0.0210, 0.1589, 0.3215, 0.1352, 0.0138, 0.1177, 0.2161,
  -0.0423, 0.3121, 0.1802, 0.2847, -0.1804, 0.2606, 0.2488, 0.1772,
  ];

  const BONDS = [
  0.0084, 0.0420, 0.0454, -0.0256, 0.0879, 0.0186, 0.0796, 0.0447, 0.0502, 0.0138,
  0.0421, 0.0441, 0.0540, -0.0202, 0.0229, 0.0249, 0.0258, 0.0380, 0.0313, 0.0092,
  0.0195, 0.0466, 0.0043, -0.0030, 0.0227, 0.0414, 0.0329, -0.0134, -0.0226, 0.0680,
  -0.0210, -0.0265, 0.1164, 0.0206, 0.0569, 0.0168, 0.0373, 0.0072, 0.0291, -0.0158,
  0.0327, -0.0501, 0.1675, 0.0979, 0.0282, 0.0366, 0.0199, 0.0361, 0.1598, 0.0129,
  -0.0078, 0.0067, -0.0299, 0.0820, 0.3281, 0.0320, 0.1373, 0.2571, 0.2428, -0.0496,
  0.0822, 0.1769, 0.0624, 0.1500, 0.0936, 0.1421, -0.0804, 0.2348, 0.0143, 0.0994,
  0.1492, -0.0825, 0.1666, 0.0557, 0.1512, 0.0038, 0.0449, 0.0287, 0.0196, 0.1021,
  0.2010, -0.1112, 0.0846, 0.1604, 0.0297, -0.0910, 0.1075, 0.0128, 0.0069, 0.0280,
  -0.0002, 0.0964, 0.1133, -0.0442, -0.1783, 0.0388, -0.0164, 0.0780,
  ];

  const INFLATION = [
  -0.0116, 0.0058, -0.0640, -0.0932, -0.1027, 0.0076, 0.0152, 0.0299, 0.0145, 0.0286,
  -0.0278, 0.0000, 0.0071, 0.0993, 0.0903, 0.0296, 0.0230, 0.0225, 0.1813, 0.0884,
  0.0299, -0.0207, 0.0593, 0.0600, 0.0075, 0.0075, -0.0074, 0.0037, 0.0299, 0.0290,
  0.0176, 0.0173, 0.0136, 0.0067, 0.0133, 0.0164, 0.0097, 0.0192, 0.0346, 0.0304,
  0.0472, 0.0620, 0.0557, 0.0327, 0.0341, 0.0871, 0.1234, 0.0694, 0.0486, 0.0670,
  0.0902, 0.1329, 0.1252, 0.0892, 0.0383, 0.0379, 0.0395, 0.0380, 0.0110, 0.0443,
  0.0442, 0.0465, 0.0611, 0.0306, 0.0290, 0.0275, 0.0267, 0.0254, 0.0332, 0.0170,
  0.0161, 0.0268, 0.0339, 0.0155, 0.0238, 0.0188, 0.0326, 0.0342, 0.0254, 0.0408,
  0.0009, 0.0272, 0.0150, 0.0296, 0.0174, 0.0150, 0.0076, 0.0073, 0.0207, 0.0211,
  0.0191, 0.0229, 0.0136, 0.0704, 0.0645, 0.0335, 0.0289, 0.0274,
  ];

  // A 60/40 stock/bond mix, rebalanced every year. The default for market
  // vehicles until accounts carry their own mix.
  const STOCK_WEIGHT = 0.6;
  const BLENDED = STOCKS.map((s, i) => STOCK_WEIGHT * s + (1 - STOCK_WEIGHT) * BONDS[i]);

  // Average yearly inflation over the same years the returns come from, so
  // the "today's dollars" conversion matches the era being simulated.
  const MEAN_INFLATION = INFLATION.reduce((a, b) => a + b, 0) / INFLATION.length;

  // Years of history drawn together in one simulated stretch. Long enough to
  // keep a downturn or a hot streak intact, short enough to mix many eras.
  const BLOCK_YEARS = 5;

  // Inflation used for the today's-dollars conversion when none is set: the
  // average over the same years the returns come from (3.1%).
  const DEFAULT_INFLATION = 0.031;

  // True when the user has chosen their own return and swing.
  function isCustomMode(rates) {
    return !!rates && rates.mode === 'custom' &&
      Number.isFinite(rates.expectedReturn) && Number.isFinite(rates.volatility);
  }

  // What the projection's numbers were built on, as one comparable string.
  // Two projections or coach analyses are about the same footing only when
  // their keys match. History is keyed by its method (start year, mix, block
  // length), not its end year, so adding a new year of data doesn't reset
  // anything. Custom is keyed by the exact numbers. Inflation is in both
  // because it changes every today's-dollars figure.
  function basisKey(rates, inflationRate) {
    const bp = x => Math.round(x * 10000);
    const infl = bp(Number.isFinite(inflationRate) ? inflationRate : DEFAULT_INFLATION);
    if (isCustomMode(rates)) {
      return `custom:${bp(rates.expectedReturn)}:${bp(rates.volatility)}:${infl}`;
    }
    return `history:${FIRST_YEAR}:${STOCK_WEIGHT}:${BLOCK_YEARS}:${infl}`;
  }

  // Plain-number summary of the blended series: its average yearly return,
  // how much a typical year swings from that average (standard deviation),
  // and the extremes. Shown as the starting point for "my own assumptions".
  function stats() {
    const n = BLENDED.length;
    const mean = BLENDED.reduce((a, b) => a + b, 0) / n;
    const variance = BLENDED.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1);
    return {
      firstYear: FIRST_YEAR,
      lastYear: FIRST_YEAR + n - 1,
      expectedReturn: mean,
      volatility: Math.sqrt(variance),
      worstYear: Math.min(...BLENDED),
      bestYear: Math.max(...BLENDED),
    };
  }

  return { FIRST_YEAR, STOCK_WEIGHT, BLOCK_YEARS, DEFAULT_INFLATION, isCustomMode, basisKey, STOCKS, BONDS, INFLATION, BLENDED, MEAN_INFLATION, stats };
});
