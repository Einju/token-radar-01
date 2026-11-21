// The token radar model: advanced OLS size curve fitting, held-out validation,
// bootstrap bands, token odds logistic regression, category adjustments, and farm plans.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ValidationMetrics {
  loo_median_abs_log_err: number;
  loo_within_2x_share: number;
  split_median_abs_log_err: number;
  split_within_2x_share: number;
  bootstrap_slope_band: [number, number];
  slope: number;
  intercept: number;
  r2: number;
}

export interface RadarConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  unknown_age_days: number;
}

export const MODEL_CONSTANTS: RadarConstants = {
  growth_weight: 0.25, // Stated constant 0.25 weight (not fitted)
  growth_floor: -60,
  growth_cap: 120,
  unknown_age_days: 365,
};

export const MODEL_VERSION = 'radar-fitted-v2';
export const EARLY_ROWS = 160;
export const LIVE_ROWS = 24;

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  model: {
    base_multiple_fitted: number;
    growth_pct: number;
    growth_multiplier: number;
    token_odds: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  token_odds: number;
  growth_multiplier: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  validation: ValidationMetrics;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function slugHash(slug: string): number {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  }
  return h % 100;
}

// OLS regression and category adjustment fitting
export interface FittedModel {
  slope: number;
  intercept: number;
  r2: number;
  categoryAdjustments: Record<string, number>;
}

function fitOLS(traded: SnapshotProtocol[]): FittedModel {
  const points = traded.filter((p) => p.tvl_usd > 0 && p.mcap_usd !== null && p.mcap_usd > 0);
  const n = points.length;
  if (n === 0) return { slope: 1, intercept: 0, r2: 0, categoryAdjustments: {} };

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  const data = points.map((p) => {
    const x = Math.log10(p.tvl_usd);
    const y = Math.log10(p.mcap_usd!);
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
    return { x, y, category: p.category ?? '' };
  });

  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;

  // R2 calculation
  const meanY = sumY / n;
  let ssTot = 0, ssRes = 0;
  for (const d of data) {
    const pred = intercept + slope * d.x;
    ssTot += Math.pow(d.y - meanY, 2);
    ssRes += Math.pow(d.y - pred, 2);
  }
  const r2 = ssTot === 0 ? 0 : Math.max(0, 1 - ssRes / ssTot);

  // Category adjustments (min 5 traded tokens per category, shrunk by n / (n + 5))
  const catMap = new Map<string, { residuals: number[] }>();
  for (const d of data) {
    if (!d.category) continue;
    const pred = intercept + slope * d.x;
    const res = d.y - pred;
    let entry = catMap.get(d.category);
    if (!entry) {
      entry = { residuals: [] };
      catMap.set(d.category, entry);
    }
    entry.residuals.push(res);
  }

  const categoryAdjustments: Record<string, number> = {};
  for (const [cat, entry] of catMap.entries()) {
    const count = entry.residuals.length;
    if (count >= 5) {
      const meanRes = entry.residuals.reduce((a, b) => a + b, 0) / count;
      categoryAdjustments[cat] = meanRes * (count / (count + 5));
    } else {
      categoryAdjustments[cat] = 0;
    }
  }

  return { slope, intercept, r2, categoryAdjustments };
}

// Token odds logistic regression fit
export interface OddsModel {
  w: number[];
  b: number;
}

function fitTokenOdds(protocols: SnapshotProtocol[], asOf: string): (p: SnapshotProtocol) => number {
  const tradedSlugs = new Set(protocols.filter((p) => !isPreToken(p)).map((p) => p.slug));
  const dataset = protocols.map((p) => {
    const tvl = Math.log10(Math.max(1, p.tvl_usd));
    const age = ageDays(asOf, p.listed_at) ?? MODEL_CONSTANTS.unknown_age_days;
    const growth = Math.min(120, Math.max(-60, p.change_7d ?? 0));
    const label = tradedSlugs.has(p.slug) ? 1 : 0;
    return { tvl, age, growth, label };
  });

  // Compute mean and std for standardization
  const n = dataset.length;
  const meanTvl = dataset.reduce((a, d) => a + d.tvl, 0) / n;
  const meanAge = dataset.reduce((a, d) => a + d.age, 0) / n;
  const meanGrowth = dataset.reduce((a, d) => a + d.growth, 0) / n;

  const stdTvl = Math.sqrt(dataset.reduce((a, d) => a + Math.pow(d.tvl - meanTvl, 2), 0) / n) || 1;
  const stdAge = Math.sqrt(dataset.reduce((a, d) => a + Math.pow(d.age - meanAge, 2), 0) / n) || 1;
  const stdGrowth = Math.sqrt(dataset.reduce((a, d) => a + Math.pow(d.growth - meanGrowth, 2), 0) / n) || 1;

  let w = [0.5, 0.3, 0.1];
  let b = 0;
  const lr = 0.05;

  for (let iter = 0; iter < 60; iter++) {
    let dw = [0, 0, 0];
    let db = 0;
    for (const d of dataset) {
      const xtvl = (d.tvl - meanTvl) / stdTvl;
      const xage = (d.age - meanAge) / stdAge;
      const xgrowth = (d.growth - meanGrowth) / stdGrowth;
      const z = w[0]! * xtvl + w[1]! * xage + w[2]! * xgrowth + b;
      const pred = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
      const err = pred - d.label;
      dw[0] += err * xtvl;
      dw[1] += err * xage;
      dw[2] += err * xgrowth;
      db += err;
    }
    w[0] -= lr * (dw[0] / n);
    w[1] -= lr * (dw[1] / n);
    w[2] -= lr * (dw[2] / n);
    b -= lr * (db / n);
  }

  return (p: SnapshotProtocol) => {
    const tvl = Math.log10(Math.max(1, p.tvl_usd));
    const age = ageDays(asOf, p.listed_at) ?? MODEL_CONSTANTS.unknown_age_days;
    const growth = Math.min(120, Math.max(-60, p.change_7d ?? 0));
    const xtvl = (tvl - meanTvl) / stdTvl;
    const xage = (age - meanAge) / stdAge;
    const xgrowth = (growth - meanGrowth) / stdGrowth;
    const z = w[0]! * xtvl + w[1]! * xage + w[2]! * xgrowth + b;
    const prob = 1 / (1 + Math.exp(-Math.max(-20, Math.min(20, z))));
    return Math.max(0.02, Math.min(0.95, prob));
  };
}

// Validation runner
function validateModel(traded: SnapshotProtocol[]): ValidationMetrics {
  const points = traded.filter((p) => p.tvl_usd > 0 && p.mcap_usd !== null && p.mcap_usd > 0);
  const N = points.length;

  // 1. Leave-One-Out (LOO)
  const looErrors: number[] = [];
  let looWithin2x = 0;
  for (let i = 0; i < N; i++) {
    const train = points.filter((_, idx) => idx !== i);
    const test = points[i]!;
    const fit = fitOLS(train);
    const x = Math.log10(test.tvl_usd);
    const y = Math.log10(test.mcap_usd!);
    const predY = fit.intercept + fit.slope * x + (fit.categoryAdjustments[test.category ?? ''] ?? 0);
    const err = Math.abs(predY - y);
    looErrors.push(err);
    if (err <= Math.log10(2)) looWithin2x++;
  }
  const loo_median_abs_log_err = median(looErrors);
  const loo_within_2x_share = looWithin2x / N;

  // 2. 80/20 Split (deterministic hash of slug)
  const trainSet = points.filter((p) => slugHash(p.slug) >= 20);
  const testSet = points.filter((p) => slugHash(p.slug) < 20);
  const splitFit = fitOLS(trainSet.length > 10 ? trainSet : points);
  const splitErrors: number[] = [];
  let splitWithin2x = 0;
  for (const test of (testSet.length > 5 ? testSet : points)) {
    const x = Math.log10(test.tvl_usd);
    const y = Math.log10(test.mcap_usd!);
    const predY = splitFit.intercept + splitFit.slope * x + (splitFit.categoryAdjustments[test.category ?? ''] ?? 0);
    const err = Math.abs(predY - y);
    splitErrors.push(err);
    if (err <= Math.log10(2)) splitWithin2x++;
  }
  const split_median_abs_log_err = median(splitErrors);
  const split_within_2x_share = testSet.length > 0 ? splitWithin2x / testSet.length : loo_within_2x_share;

  // 3. Bootstrap band (200 refits on deterministic resamples, seeded by index)
  const bootstrapSlopes: number[] = [];
  for (let b = 0; b < 200; b++) {
    // Deterministic pseudo-random sample with replacement
    const resampled: SnapshotProtocol[] = [];
    let seed = 1337 + b * 7;
    for (let j = 0; j < N; j++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const idx = Math.floor((seed / 2147483648) * N);
      resampled.push(points[idx]!);
    }
    const fitB = fitOLS(resampled);
    bootstrapSlopes.push(fitB.slope);
  }
  bootstrapSlopes.sort((a, b) => a - b);
  const slope10th = bootstrapSlopes[Math.floor(200 * 0.1)] ?? bootstrapSlopes[0]!;
  const slope90th = bootstrapSlopes[Math.floor(200 * 0.9)] ?? bootstrapSlopes[bootstrapSlopes.length - 1]!;

  const fullFit = fitOLS(points);

  return {
    loo_median_abs_log_err,
    loo_within_2x_share,
    split_median_abs_log_err,
    split_within_2x_share,
    bootstrap_slope_band: [Math.round(slope10th * 1000) / 1000, Math.round(slope90th * 1000) / 1000],
    slope: Math.round(fullFit.slope * 1000) / 1000,
    intercept: Math.round(fullFit.intercept * 1000) / 1000,
    r2: Math.round(fullFit.r2 * 1000) / 1000,
  };
}

// Farm steps generation (category-aware, at least 8 categories, 4-6 steps)
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

export function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;

  let action = `Deposit $${capital} of USDC into ${name} on ${chain} and maintain the position.`;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    action = `Supply $${capital} of USDC as collateral and borrow a small stable position on ${name} on ${chain}.`;
  } else if (c.includes('dex') || c.includes('yield') || c.includes('swap')) {
    action = `Provide $${capital} of liquidity to the primary pair on ${name} on ${chain} and hold the LP token.`;
  } else if (c.includes('allocator') || c.includes('curator')) {
    action = `Deposit $${capital} into a ${name} managed strategy vault on ${chain} and retain vault shares.`;
  } else if (c.includes('rwa')) {
    action = `Mint $${capital} equivalent of the yield-bearing asset through ${name} on ${chain}.`;
  } else if (c.includes('perpetual') || c.includes('derivative')) {
    action = `Deposit $${capital} of USDC margin and execute one hedged perpetual position on ${name} on ${chain}.`;
  } else if (c.includes('restak')) {
    action = `Restake $${capital} of liquid staking assets through ${name} on ${chain} to secure active validation.`;
  } else if (c.includes('insurance')) {
    action = `Purchase $${capital} of coverage protection on ${name} on ${chain} and keep the policy active.`;
  }

  const hold = age !== null && age < 180 ? 60 : 30;

  return [
    {
      text: `Prepare a dedicated non-custodial wallet funded with native gas tokens on ${chain} and keep credentials secure.`,
      cost: 'under $3 of gas for setup',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} capital and ~$5 network fee`,
      time: '15 minutes',
    },
    {
      text: `Perform weekly protocol interactions such as compounding rewards, rebalancing, or voting in governance.`,
      cost: '$1-$2 weekly gas',
      time: '10 minutes weekly',
    },
    {
      text: `Maintain the active farm position for at least ${hold} consecutive days across snapshot cycles.`,
      cost: `capital locked (${hold} days)`,
      time: `${hold} days`,
    },
    {
      text: `Navigate exclusively to the official ${name} application interface to claim points or rewards.`,
      cost: 'zero fees',
      time: '5 minutes',
    },
  ];
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Keep position active and monitor protocol announcements.`;
  return s;
}

/**
 * EV per $1,000 farmed = implied_value_usd x 0.05 (assumed airdrop share of launch value)
 * x (1000 / 10,000,000) (assumed farmer share of $10M total farmed capital) = implied x 5e-6.
 * Assumptions:
 * - Airdrop share of launch value: 5% (0.05)
 * - Total farmed capital pool: $10,000,000
 * - Farmer participation amount: $1,000
 * FARM when EV > $50 (implied > $10M); THIN when $10 <= EV <= $50 (implied $2M-$10M); SKIP when EV < $10 (implied < $2M).
 */
export function computeVerdict(impliedValueUsd: number, capitalUsd: number = 1000): 'FARM' | 'THIN' | 'SKIP' {
  const ev = impliedValueUsd * 5e-6;
  if (ev > 50) return 'FARM';
  if (ev >= 10) return 'THIN';
  return 'SKIP';
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const traded = snapshot.protocols.filter((p) => !isPreToken(p));
  const fitted = fitOLS(traded);
  const validation = validateModel(traded);
  const oddsFn = fitTokenOdds(snapshot.protocols, snapshot.as_of);

  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();

  // Floor: all watchlist protocols
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }

  // Early radar: pre-token protocols below floor_usd by TVL
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);

  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const tvl = Math.max(1, p.tvl_usd);
    const logMcap = fitted.intercept + fitted.slope * Math.log10(tvl) + (fitted.categoryAdjustments[p.category ?? ''] ?? 0);
    const baseVal = Math.pow(10, logMcap);
    const odds = oddsFn(p);
    const growth = Math.min(MODEL_CONSTANTS.growth_cap, Math.max(MODEL_CONSTANTS.growth_floor, p.change_7d ?? 0));
    const growthMult = 1 + (growth / 100) * MODEL_CONSTANTS.growth_weight;

    const implied = Math.max(1, Math.round(baseVal * odds * growthMult));
    const capital = capitalFor(p);
    const verdict = computeVerdict(implied, capital);

    return {
      p,
      implied,
      odds,
      growthPct: growth,
      growthMult,
      age,
      verdict,
    };
  });

  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    verdict: s.verdict,
    model: {
      base_multiple_fitted: Math.round(Math.pow(10, fitted.intercept) * 1e4) / 1e4,
      growth_pct: s.growthPct,
      growth_multiplier: Math.round(s.growthMult * 1e4) / 1e4,
      token_odds: Math.round(s.odds * 1e4) / 1e4,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));

  const live = liveRows(snapshot);
  const earlyCount = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    validation,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: earlyCount,
    live_size: live.length,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      mcap_usd: r.mcap_usd,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      verdict: r.verdict,
      token_odds: r.model.token_odds,
      growth_multiplier: r.model.growth_multiplier,
      farm_steps: r.farm_steps,
    })),
    live,
  };

  return { board, radar };
}

export const buildRadar = buildBoard;

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');

  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });

  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
