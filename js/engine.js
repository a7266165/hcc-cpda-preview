// HCC-CPDA web engine (model v0.1.0-mvp): pure computation, ES module, no DOM, no dependencies.
// Runs unchanged in browsers and in Node 22. Interfaces: docs/CONTRACTS.md sections 4-7.
//
// It reproduces the paper's analysis code path (package cpda) for one complete profile:
//   * booster margin exactly as XGBoost 3.4.1 CPU predict(output_margin=True): inputs and split
//     thresholds compared as float32, s = fround(ln(base_score)), then s = fround(s + leaf) tree by tree;
//   * log-normal survival S(t) = 1 - Phi((ln t - mu) / sigma), S(0) = 1   (cpda.aft.survival_from_location);
//   * mean of the per-model curves, trapezoid RMST with unit step          (cpda.projection.predict_fold,
//                                                                          cpda.aft.rmst_from_curve);
//   * treatment-ranking sequence: RMST descending, exact ties by treatment code (cpda.ranking.build_sequences);
//   * per-position RMST mismatch against a reference sequence           (cpda.ranking.mismatch_by_position).
// Nothing is imputed: every predictor, the BCLC stage and the site are required.

export const TREATMENT_ORDER = Object.freeze(['LT', 'SR', 'RFA', 'TACE', 'TT', 'HAIC', 'RT', 'BSC']);
export const STAGE_ORDER = Object.freeze(['0', 'A', 'B', 'C', 'D']);
export const SITES = Object.freeze([1, 2, 3]);
// The 15 predictors in locked-configuration order (model column names, including the source spellings).
export const PREDICTORS = Object.freeze([
  'sex', 'age', 'BMI', 'HBV', 'HCV', 'maximal_tumor_size', 'tumor_number', 'lymphonodules',
  'metastatsis', 'cirrhosis', 'childPugh_class', 'total_bilirubin', 'INR', 'AFP', 'creatine',
]);
// The 27 design columns in model order (cpda.features.design_columns).
export const COLUMNS = Object.freeze([
  ...PREDICTORS, 'stage_code', ...SITES.map((h) => `hosp_${h}`), ...TREATMENT_ORDER.map((t) => `trt_${t}`),
]);

const MANIFEST_FORMAT = 'hcc-cpda-web-manifest/1';
const BOOSTER_FORMAT = 'hcc-cpda-compact-booster/1';
const STAGE_CODES = Object.freeze({ 0: 0, A: 1, B: 2, C: 3, D: 4 });
// Allowed codes of the categorical predictors (locked configuration: binary, or ordinal 0-2).
// Every other predictor is continuous and only has to be a finite number here; clinical
// plausibility bounds live in site/data/config.json (`fields`) and are applied by project().
const CODES = Object.freeze({
  sex: [0, 1], HBV: [0, 1], HCV: [0, 1], tumor_number: [0, 1], lymphonodules: [0, 1],
  metastatsis: [0, 1], cirrhosis: [0, 1], childPugh_class: [0, 1, 2],
});
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

// ---------------------------------------------------------------------------------------------
// Errors. `code` is stable and machine-readable; messages name the field but never echo values.
// ---------------------------------------------------------------------------------------------
export class EngineError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'EngineError';
    this.code = code; // missing_input | invalid_input | out_of_range | invalid_model | invalid_config |
    //                   invalid_support | load_failed | hash_mismatch
    if (field !== undefined) this.field = field;
  }
}

function fail(code, message, field) {
  throw new EngineError(code, `engine: ${message}`, field);
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const sameList = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);

// ---------------------------------------------------------------------------------------------
// Compact boosters (CONTRACTS.md section 4)
// ---------------------------------------------------------------------------------------------
function parseTree(t, k, numFeature) {
  const bad = (why) => fail('invalid_model', `booster tree ${k}: ${why}`);
  if (!t || typeof t !== 'object') bad('not an object');
  const { l: L, r: R, f: F, c: C } = t;
  if (!Array.isArray(L) || L.length === 0) bad('missing node arrays');
  const n = L.length;
  if (!Array.isArray(R) || !Array.isArray(F) || !Array.isArray(C) || R.length !== n || F.length !== n || C.length !== n) {
    bad('node arrays l, r, f, c must have equal lengths');
  }
  const l = Int32Array.from(L);
  const r = Int32Array.from(R);
  const f = Int32Array.from(F);
  const c = Float32Array.from(C); // float32 rounding of the written shortest decimal = XGBoost's float32
  for (let i = 0; i < n; i++) {
    if (l[i] !== L[i] || r[i] !== R[i] || f[i] !== F[i]) bad(`node ${i} has a non-integer index`);
    if (typeof C[i] !== 'number' || !Number.isFinite(c[i])) bad(`node ${i} has a non-finite value`);
  }
  // Every node reachable from the root is visited exactly once (a tree, so traversal terminates).
  const seen = new Uint8Array(n);
  const stack = [0];
  while (stack.length > 0) {
    const i = stack.pop();
    if (seen[i]) bad(`node ${i} is reached twice`);
    seen[i] = 1;
    if (l[i] === -1) {
      if (r[i] !== -1) bad(`leaf ${i} has a right child`);
      continue;
    }
    if (l[i] <= 0 || l[i] >= n || r[i] <= 0 || r[i] >= n || l[i] === r[i]) bad(`node ${i} has invalid children`);
    if (f[i] < 0 || f[i] >= numFeature) bad(`node ${i} splits on a feature outside 0..${numFeature - 1}`);
    stack.push(r[i], l[i]);
  }
  return { l, r, f, c };
}

/** Parse a compact booster (object or JSON text) into typed arrays; validates the tree structure. */
export function parseBooster(json) {
  let obj = json;
  if (typeof json === 'string') {
    try {
      obj = JSON.parse(json);
    } catch (e) {
      fail('invalid_model', `booster is not valid JSON (${e.message})`);
    }
  }
  if (!obj || typeof obj !== 'object') fail('invalid_model', 'booster must be a JSON object');
  if (obj.format !== BOOSTER_FORMAT) fail('invalid_model', `booster format must be "${BOOSTER_FORMAT}"`);
  const baseScore = obj.base_score;
  if (!isFiniteNumber(baseScore) || !(baseScore > 0)) fail('invalid_model', 'booster base_score must be a positive number');
  const numFeature = obj.num_feature;
  if (!Number.isInteger(numFeature) || numFeature <= 0) fail('invalid_model', 'booster num_feature must be a positive integer');
  if (!Array.isArray(obj.trees) || obj.trees.length === 0) fail('invalid_model', 'booster has no trees');
  const trees = obj.trees.map((t, k) => parseTree(t, k, numFeature));
  // AFT margin offset = ProbToMargin(base_score) = ln(base_score), held in float32 like XGBoost.
  return { baseScore, baseMargin: Math.fround(Math.log(baseScore)), numFeature, trees };
}

/**
 * Margin (log-time location) of one booster for one design vector, accumulated in float32
 * exactly like XGBoost: s = fround(ln base_score); for each tree in order s = fround(s + leaf).
 * A node goes left iff float32(x[f]) < float32(c). Returns a float32 value held in a double.
 */
export function boosterMargin(booster, x) {
  const nf = booster.numFeature;
  if (!x || x.length !== nf) fail('invalid_input', `design vector must have ${nf} entries`);
  for (let j = 0; j < nf; j++) {
    if (!Number.isFinite(x[j])) fail('invalid_input', `design vector entry ${j} is not a finite number`);
  }
  const trees = booster.trees;
  let s = booster.baseMargin;
  for (let k = 0; k < trees.length; k++) {
    const t = trees[k];
    const l = t.l;
    const r = t.r;
    const f = t.f;
    const c = t.c;
    let i = 0;
    while (l[i] !== -1) i = Math.fround(x[f[i]]) < c[i] ? l[i] : r[i];
    s = Math.fround(s + c[i]); // exact float32 addition (53 >= 2*24 + 2 bits, so no double-rounding error)
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// Design vector (cpda.features.design_matrix for one row)
// ---------------------------------------------------------------------------------------------
function checkPredictor(name, v) {
  if (v === undefined || v === null) fail('missing_input', `${name} is missing`, name);
  if (typeof v !== 'number') fail('invalid_input', `${name} must be a number`, name);
  if (Number.isNaN(v)) fail('invalid_input', `${name} is NaN`, name);
  if (!Number.isFinite(v)) fail('invalid_input', `${name} must be finite`, name);
  if (hasOwn(CODES, name) && !CODES[name].includes(v)) {
    fail('invalid_input', `${name} must be one of ${CODES[name].join(', ')}`, name);
  }
  return v;
}

function checkStageSite(manifest, profile) {
  if (!profile || typeof profile !== 'object') fail('invalid_input', 'profile must be an object');
  const stageCodes = manifest.stage_codes;
  if (!stageCodes || typeof stageCodes !== 'object') fail('invalid_model', 'manifest.stage_codes is missing');
  const { stage, site } = profile;
  if (stage === undefined || stage === null) fail('missing_input', 'stage is missing', 'stage');
  if (typeof stage !== 'string' || !hasOwn(stageCodes, stage)) {
    fail('invalid_input', `stage must be one of ${Object.keys(stageCodes).join(', ')}`, 'stage');
  }
  const hospitals = Array.isArray(manifest.hospitals) ? manifest.hospitals : SITES;
  if (site === undefined || site === null) fail('missing_input', 'site is missing', 'site');
  if (!hospitals.includes(site)) fail('invalid_input', `site must be one of ${hospitals.join(', ')}`, 'site');
  return { stage, site, stageCode: stageCodes[stage] };
}

/**
 * Float32Array in manifest.columns order: the 15 predictors, stage_code, one-hot site and one-hot
 * treatment. Throws EngineError on a missing, NaN, non-numeric or out-of-domain value; never imputes.
 */
export function designVector(manifest, profile, treatment) {
  const columns = manifest && manifest.columns;
  if (!Array.isArray(columns) || columns.length === 0) fail('invalid_model', 'manifest.columns is missing');
  const { site, stage, stageCode } = checkStageSite(manifest, profile);
  if (!Number.isInteger(stageCode)) fail('invalid_model', `manifest.stage_codes has no integer code for stage ${stage}`);
  if (!TREATMENT_ORDER.includes(treatment)) fail('invalid_input', 'unknown treatment', 'treatment');
  const x = new Float32Array(columns.length); // float32 storage = XGBoost's float32 DMatrix input
  for (let j = 0; j < columns.length; j++) {
    const name = columns[j];
    if (name === 'stage_code') x[j] = stageCode;
    else if (name.startsWith('hosp_')) x[j] = name === `hosp_${site}` ? 1 : 0;
    else if (name.startsWith('trt_')) x[j] = name === `trt_${treatment}` ? 1 : 0;
    else if (PREDICTORS.includes(name)) x[j] = checkPredictor(name, profile[name]);
    else fail('invalid_model', `unknown design column ${name}`);
  }
  return x;
}

// ---------------------------------------------------------------------------------------------
// Standard normal CDF in double precision
// ---------------------------------------------------------------------------------------------
// Phi(z) = 1/2 + erf(x)/2 for |x| < 1 and 1/2 erfc(|x|) in the tails, x = z / sqrt(2).
// No fitted coefficients are used:
//   erf(x)  = (2/sqrt(pi)) x exp(-x^2) sum_{n>=0} (2x^2)^n / (1*3*...*(2n+1))   (positive terms);
//   erfc(x) = exp(-x^2)/sqrt(pi) / (x + (1/2)/(x + (2/2)/(x + (3/2)/(x + ...)))) (Laplace continued
//             fraction, all terms positive, evaluated backward from a depth that grows as 1/x^2).
// Backward evaluation keeps the rounding error at a few ulps (forward Lentz drifts to ~1e-14 near
// x = 1). In the tails exp(-z^2/2) is taken from z directly with z split into a short head and a
// tail, so the rounding of z*z does not degrade the relative accuracy far out.
// Measured against mpmath (60 digits) over 48,001 points in [-40, 40]: absolute error < 5e-16.
const TWO_OVER_SQRT_PI = 1.1283791670955126; // 2/sqrt(pi) rounded to double
const ONE_OVER_SQRT_PI = 0.5641895835477563; // 1/sqrt(pi) rounded to double

function expHalfNegSquare(z) {
  // exp(-z^2/2) without the rounding error of z*z: z = h + l with h a multiple of 1/16, so h*h is exact.
  const az = Math.abs(z);
  const h = Math.round(az * 16) / 16;
  const l = az - h; // exact (Sterbenz) for h > 0; l = az for h = 0
  return Math.exp(-0.5 * h * h) * Math.exp(-(h * l + 0.5 * l * l));
}

function erfSmall(x) {
  // |x| < 1: positive-term series; ~20 terms at |x| = 1 for a relative step below 1e-17.
  const y = x * x;
  const y2 = 2 * y;
  let term = 1;
  let sum = 1;
  for (let n = 1; n < 200; n++) {
    term *= y2 / (2 * n + 1);
    sum += term;
    if (term <= sum * 1e-17) break;
  }
  return TWO_OVER_SQRT_PI * x * Math.exp(-y) * sum;
}

function erfcTailFactor(x) {
  // x >= 1: returns 1/(sqrt(pi) * K(x)) with K the Laplace continued fraction, so that
  // erfc(x) = exp(-x^2) * erfcTailFactor(x). Depth 16 + 320/x^2 (<= 336) is about twice the depth
  // at which the truncation error falls below the rounding error (179 at x = 1, 52 at x = 2 and
  // 20 at x = 4 for 4e-16 relative, measured against mpmath).
  const depth = Math.ceil(16 + 320 / (x * x));
  let t = x;
  for (let j = depth; j >= 1; j--) t = x + (0.5 * j) / t;
  return ONE_OVER_SQRT_PI / t;
}

/** Standard normal CDF, double precision (absolute error < 1e-14 on [-40, 40]; measured < 5e-16). */
export function normCdf(z) {
  if (typeof z !== 'number' || Number.isNaN(z)) return NaN;
  if (z >= 40) return 1;
  if (z <= -40) return 0; // Phi(-40) ~ 4e-350 underflows anyway
  const x = z * Math.SQRT1_2;
  const ax = Math.abs(x);
  if (ax < 1) return 0.5 + 0.5 * erfSmall(x);
  const tail = 0.5 * expHalfNegSquare(z) * erfcTailFactor(ax); // = Phi(-|z|)
  return x > 0 ? 1 - tail : tail;
}

// ---------------------------------------------------------------------------------------------
// Survival curves and RMST (cpda.aft)
// ---------------------------------------------------------------------------------------------
/** Log-normal survival on the monthly grid 0..horizon: S(0) = 1, S(t) = 1 - Phi((ln t - mu)/sigma). */
export function survivalCurve(mu, sigma, horizon) {
  if (!isFiniteNumber(mu)) fail('invalid_input', 'survivalCurve: mu must be a finite number');
  if (!isFiniteNumber(sigma) || !(sigma > 0)) fail('invalid_input', 'survivalCurve: sigma must be a positive number');
  if (!Number.isInteger(horizon) || horizon < 0) fail('invalid_input', 'survivalCurve: horizon must be a non-negative integer');
  const s = new Float64Array(horizon + 1);
  s[0] = 1;
  for (let t = 1; t <= horizon; t++) s[t] = 1 - normCdf((Math.log(t) - mu) / sigma);
  return s;
}

/** Trapezoid RMST with unit step over the whole array (0..horizon), summed left to right like numpy cumsum. */
export function rmst(curve) {
  if (!curve || typeof curve.length !== 'number' || curve.length < 1) fail('invalid_input', 'rmst: curve must be a non-empty array');
  let s = 0;
  for (let k = 1; k < curve.length; k++) s += 0.5 * (curve[k] + curve[k - 1]);
  if (!Number.isFinite(s)) fail('invalid_input', 'rmst: curve has non-finite values');
  return s;
}

// ---------------------------------------------------------------------------------------------
// Model assembly and loading
// ---------------------------------------------------------------------------------------------
function checkManifest(mf) {
  const bad = (why) => fail('invalid_model', `manifest: ${why}`);
  if (!mf || typeof mf !== 'object') bad('not an object');
  if (mf.format !== MANIFEST_FORMAT) bad(`format must be "${MANIFEST_FORMAT}"`);
  if (!Array.isArray(mf.columns) || mf.columns.length !== COLUMNS.length) bad(`expected ${COLUMNS.length} columns`);
  if (!sameList(mf.columns, COLUMNS)) bad('columns differ from the model design order');
  if (mf.predictors !== undefined && !sameList(mf.predictors, PREDICTORS)) bad('predictors differ from the locked order');
  if (!sameList(mf.treatments, TREATMENT_ORDER)) bad('treatments differ from TREATMENT_ORDER');
  if (!sameList(mf.hospitals, SITES)) bad('hospitals must be [1, 2, 3]');
  const sc = mf.stage_codes;
  if (!sc || typeof sc !== 'object' || Object.keys(sc).length !== STAGE_ORDER.length || STAGE_ORDER.some((s) => sc[s] !== STAGE_CODES[s])) {
    bad('stage_codes must be {"0":0,"A":1,"B":2,"C":3,"D":4}');
  }
  const hz = mf.horizons_months;
  if (!hz || typeof hz !== 'object' || STAGE_ORDER.some((s) => !Number.isInteger(hz[s]) || hz[s] <= 0)) {
    bad('horizons_months must give a positive integer for every stage');
  }
  const aft = mf.aft;
  if (!aft || aft.distribution !== 'normal') bad('aft.distribution must be "normal"');
  if (!isFiniteNumber(aft.sigma) || !(aft.sigma > 0)) bad('aft.sigma must be a positive number');
  if (!isFiniteNumber(aft.base_score) || !(aft.base_score > 0)) bad('aft.base_score must be a positive number');
  if (!Number.isInteger(mf.n_models) || mf.n_models < 1) bad('n_models must be a positive integer');
  if (!Array.isArray(mf.boosters) || mf.boosters.length !== mf.n_models) bad(`expected n_models = ${mf.n_models} boosters`);
  const files = new Set();
  mf.boosters.forEach((b, m) => {
    if (!b || typeof b.file !== 'string' || !FILE_NAME.test(b.file)) bad(`booster ${m}: file must be a plain .json file name`);
    if (files.has(b.file)) bad(`booster ${m}: duplicate file name`);
    files.add(b.file);
    if (typeof b.sha256 !== 'string' || !SHA256_HEX.test(b.sha256)) bad(`booster ${m}: sha256 must be 64 hex digits`);
    if (b.n_trees !== undefined && (!Number.isInteger(b.n_trees) || b.n_trees < 1)) bad(`booster ${m}: n_trees must be a positive integer`);
  });
}

/**
 * Assemble a model from a manifest and its boosters (raw compact JSON objects or parseBooster output),
 * in manifest order. loadModel() uses this after fetching and hashing; tests may call it directly.
 */
export function createModel(manifest, boosters, { sha256Verified = false } = {}) {
  checkManifest(manifest);
  if (!Array.isArray(boosters) || boosters.length !== manifest.n_models) {
    fail('invalid_model', `expected ${manifest.n_models} boosters`);
  }
  const parsed = boosters.map((b, m) => {
    const pb = b && Array.isArray(b.trees) && b.trees.length > 0 && b.trees[0].c instanceof Float32Array ? b : parseBooster(b);
    const entry = manifest.boosters[m];
    if (pb.numFeature !== manifest.columns.length) fail('invalid_model', `${entry.file}: num_feature differs from the manifest columns`);
    if (pb.baseScore !== manifest.aft.base_score) fail('invalid_model', `${entry.file}: base_score differs from the manifest`);
    if (entry.n_trees !== undefined && pb.trees.length !== entry.n_trees) fail('invalid_model', `${entry.file}: expected ${entry.n_trees} trees`);
    return pb;
  });
  return {
    manifest,
    modelVersion: manifest.model_version,
    sigma: manifest.aft.sigma,
    boosters: parsed,
    sha256Verified: sha256Verified === true,
  };
}

function joinUrl(base, file) {
  if (base === '') return file;
  return base.endsWith('/') ? base + file : `${base}/${file}`;
}

async function fetchBytes(fetchFn, url) {
  let res;
  try {
    res = await fetchFn.call(globalThis, url);
  } catch (e) {
    fail('load_failed', `could not fetch ${url} (${e && e.message ? e.message : String(e)})`);
  }
  if (!res || !res.ok) fail('load_failed', `could not fetch ${url} (HTTP ${res ? res.status : 'no response'})`);
  return new Uint8Array(await res.arrayBuffer());
}

function parseJsonBytes(bytes, label) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('load_failed', `${label} is not valid UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    fail('load_failed', `${label} is not valid JSON (${e.message})`);
  }
}

async function sha256Hex(subtle, bytes) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Fetch `manifest.json` and the boosters it lists from `baseUrl`, verify every booster's sha256 with
 * crypto.subtle when available (model.sha256Verified records whether it ran), parse and validate.
 * Errors are EngineError with code load_failed, hash_mismatch or invalid_model.
 */
export async function loadModel(baseUrl, fetchFn = globalThis.fetch) {
  if (typeof baseUrl !== 'string') fail('load_failed', 'baseUrl must be a string');
  if (typeof fetchFn !== 'function') fail('load_failed', 'no fetch function is available');
  const manifestUrl = joinUrl(baseUrl, 'manifest.json');
  const manifest = parseJsonBytes(await fetchBytes(fetchFn, manifestUrl), manifestUrl);
  checkManifest(manifest);
  const subtle = (globalThis.crypto && globalThis.crypto.subtle) || null;
  const raw = await Promise.all(
    manifest.boosters.map(async (entry) => {
      const url = joinUrl(baseUrl, entry.file);
      const bytes = await fetchBytes(fetchFn, url);
      if (subtle) {
        const got = await sha256Hex(subtle, bytes);
        if (got !== entry.sha256.toLowerCase()) {
          fail('hash_mismatch', `${entry.file}: sha256 ${got} does not match the manifest (${entry.sha256.toLowerCase()})`);
        }
      }
      return parseJsonBytes(bytes, url);
    }),
  );
  return createModel(manifest, raw, { sha256Verified: subtle !== null });
}

function checkModel(model) {
  if (!model || !model.manifest || !Array.isArray(model.boosters) || model.boosters.length === 0 || !isFiniteNumber(model.sigma)) {
    fail('invalid_model', 'model must come from loadModel() or createModel()');
  }
  return model;
}

// ---------------------------------------------------------------------------------------------
// Projection of all eight treatment inputs (cpda.projection.predict_fold for one profile)
// ---------------------------------------------------------------------------------------------
/**
 * { horizon: H, byTreatment: { LT: { margins: [n_models], locationMean, curve: Float64Array(H+1), rmst }, ... } }
 * The curve is the mean of the per-model curves (a mixture of log-normals), accumulated in model order
 * and divided by n_models as in predict_fold; rmst = rmst(curve). Only the treatment block of the
 * design vector changes across treatments; profile, stage and site are held fixed.
 */
export function projectAll(model, profile) {
  const { manifest, boosters, sigma } = checkModel(model);
  const { stage } = checkStageSite(manifest, profile);
  const H = manifest.horizons_months[stage];
  if (!Number.isInteger(H) || H < 1) fail('invalid_model', `manifest has no horizon for stage ${stage}`);
  const nM = boosters.length;
  const byTreatment = {};
  for (const trt of TREATMENT_ORDER) {
    const x = designVector(manifest, profile, trt);
    const margins = new Array(nM);
    const acc = new Float64Array(H + 1);
    let locSum = 0;
    for (let m = 0; m < nM; m++) {
      const mu = boosterMargin(boosters[m], x);
      margins[m] = mu;
      locSum += mu;
      const s = survivalCurve(mu, sigma, H);
      for (let t = 0; t <= H; t++) acc[t] += s[t];
    }
    for (let t = 0; t <= H; t++) acc[t] /= nM;
    byTreatment[trt] = { margins, locationMean: locSum / nM, curve: acc, rmst: rmst(acc) };
  }
  return { horizon: H, byTreatment };
}

// ---------------------------------------------------------------------------------------------
// Ranking and mismatch (cpda.ranking)
// ---------------------------------------------------------------------------------------------
function checkMenu(menu, label, code = 'invalid_input') {
  if (!Array.isArray(menu) || menu.length === 0) fail(code, `${label} must be a non-empty array of treatments`);
  const seen = new Set();
  for (const t of menu) {
    if (!TREATMENT_ORDER.includes(t)) fail(code, `${label} contains an unknown treatment`);
    if (seen.has(t)) fail(code, `${label} lists a treatment twice`);
    seen.add(t);
  }
  return menu.slice();
}

function rmstOf(rmstByTrt, t) {
  if (!rmstByTrt || typeof rmstByTrt !== 'object') fail('invalid_input', 'RMST map must be an object or a Map');
  const v = rmstByTrt instanceof Map ? rmstByTrt.get(t) : hasOwn(rmstByTrt, t) ? rmstByTrt[t] : undefined;
  if (!isFiniteNumber(v)) fail('invalid_input', `no finite RMST for ${t}`);
  return v;
}

/** Menu treatments by RMST, descending; exact ties go to the lower TREATMENT_ORDER index first. */
export function rankTreatments(rmstByTrt, menu) {
  const list = checkMenu(menu, 'menu');
  const value = new Map(list.map((t) => [t, rmstOf(rmstByTrt, t)]));
  return list.sort((a, b) => {
    const va = value.get(a);
    const vb = value.get(b);
    if (va !== vb) return va > vb ? -1 : 1;
    return TREATMENT_ORDER.indexOf(a) - TREATMENT_ORDER.indexOf(b);
  });
}

/** |RMST(trs[k]) - RMST(ref[k])| at every rank position (appendix table S11B). */
export function mismatchByPosition(rmstByTrt, trs, ref) {
  if (!Array.isArray(trs) || !Array.isArray(ref) || trs.length !== ref.length) {
    fail('invalid_input', 'trs and ref must be arrays of the same length');
  }
  return trs.map((q, k) => Math.abs(rmstOf(rmstByTrt, q) - rmstOf(rmstByTrt, ref[k])));
}

/** M = max_k |RMST(trs[k]) - RMST(ref[k])| (S4.2, S5.2). */
export function maxMismatch(rmstByTrt, trs, ref) {
  const d = mismatchByPosition(rmstByTrt, trs, ref);
  if (d.length === 0) fail('invalid_input', 'trs and ref are empty');
  return Math.max(...d);
}

// ---------------------------------------------------------------------------------------------
// Result object (CONTRACTS.md section 7)
// ---------------------------------------------------------------------------------------------
function stageConfig(config, manifest, stage, H) {
  const bad = (why) => fail('invalid_config', `config.stages.${stage}: ${why}`);
  const st = config.stages[stage];
  if (!st || typeof st !== 'object') fail('invalid_config', `config.stages has no entry for stage ${stage}`);
  if (st.horizon !== H) bad('horizon differs from the model manifest');
  if (st.code !== undefined && st.code !== manifest.stage_codes[stage]) bad('code differs from the model manifest');
  const menu = checkMenu(st.menu, `config.stages.${stage}.menu`, 'invalid_config');
  const reference = checkMenu(st.reference, `config.stages.${stage}.reference`, 'invalid_config');
  if (reference.length !== menu.length || reference.some((t) => !menu.includes(t))) bad('reference is not an ordering of the menu');
  const landmarks = st.landmarks === undefined ? [] : st.landmarks;
  if (!Array.isArray(landmarks) || landmarks.some((L) => !Number.isInteger(L) || L < 0 || L > H)) {
    bad(`landmarks must be integer months within 0..${H}`);
  }
  return { menu, reference, landmarks };
}

function fieldRangeWarnings(fields, profile) {
  // Hard bounds (min/max) are clinical plausibility limits: outside them nothing is projected.
  // Soft bounds (soft_min/soft_max) only add a "soft_range:<name>" warning.
  const warnings = [];
  if (fields === undefined || fields === null) return warnings;
  if (!Array.isArray(fields)) fail('invalid_config', 'config.fields must be an array');
  for (const fd of fields) {
    if (!fd || typeof fd.name !== 'string') continue;
    const v = profile[fd.name];
    if (typeof v !== 'number') continue; // presence and type are enforced by designVector
    if ((isFiniteNumber(fd.min) && v < fd.min) || (isFiniteNumber(fd.max) && v > fd.max)) {
      fail('out_of_range', `${fd.name} is outside the accepted range`, fd.name);
    }
    if ((isFiniteNumber(fd.soft_min) && v < fd.soft_min) || (isFiniteNumber(fd.soft_max) && v > fd.soft_max)) {
      warnings.push(`soft_range:${fd.name}`);
    }
  }
  return warnings;
}

function localSupport(support, site, stage, menu) {
  if (!support || !Array.isArray(support.cells)) fail('invalid_support', 'support.cells is required');
  const rule = support.rule;
  const cells = new Map();
  for (const c of support.cells) {
    if (!c || c.site !== site || c.stage !== stage || !menu.includes(c.treatment)) continue;
    if (cells.has(c.treatment)) fail('invalid_support', `two support cells for Site ${site}, stage ${stage}, ${c.treatment}`);
    const counts = [c.n, c.deaths, c.at_risk];
    if (counts.some((v) => !Number.isInteger(v) || v < 0) || typeof c.supported !== 'boolean') {
      fail('invalid_support', `malformed support cell for Site ${site}, stage ${stage}, ${c.treatment}`);
    }
    if (rule && [rule.min_patients, rule.min_deaths, rule.min_at_risk_at_horizon].every(Number.isInteger)) {
      const expected = c.n >= rule.min_patients && c.deaths >= rule.min_deaths && c.at_risk >= rule.min_at_risk_at_horizon;
      if (expected !== c.supported) fail('invalid_support', `support flag disagrees with the rule for Site ${site}, stage ${stage}, ${c.treatment}`);
    }
    cells.set(c.treatment, { n: c.n, deaths: c.deaths, atRisk: c.at_risk, supported: c.supported });
  }
  for (const t of menu) {
    if (!cells.has(t)) fail('invalid_support', `no support cell for Site ${site}, stage ${stage}, ${t}`);
  }
  return cells;
}

/**
 * Full projection for one profile: menu rows in TRS order with RMST, mean curve, landmark survival,
 * distance from the top RMST, tolerance flag and local support; TRS vs the pooled reference sequence.
 * Values are unrounded. Throws EngineError on invalid input, configuration or support data.
 */
export function project(model, config, support, profile) {
  const { manifest } = checkModel(model);
  if (!config || typeof config !== 'object' || !config.stages || typeof config.stages !== 'object') {
    fail('invalid_config', 'config.stages is required');
  }
  if (config.treatment_order !== undefined && !sameList(config.treatment_order, TREATMENT_ORDER)) {
    fail('invalid_config', 'config.treatment_order differs from TREATMENT_ORDER');
  }
  const tol = config.tolerance_months;
  if (!isFiniteNumber(tol) || tol < 0) fail('invalid_config', 'config.tolerance_months must be a non-negative number');

  designVector(manifest, profile, TREATMENT_ORDER[0]); // validate every input before anything else
  const { stage, site } = checkStageSite(manifest, profile);
  if (Array.isArray(config.sites) && !config.sites.includes(site)) fail('invalid_input', 'site is not offered by the configuration', 'site');
  const rangeWarnings = fieldRangeWarnings(config.fields, profile);
  const H = manifest.horizons_months[stage];
  const { menu, reference, landmarks } = stageConfig(config, manifest, stage, H);
  const local = localSupport(support, site, stage, menu);

  const all = projectAll(model, profile);
  const rmstByTrt = {};
  for (const t of TREATMENT_ORDER) rmstByTrt[t] = all.byTreatment[t].rmst;
  const trs = rankTreatments(rmstByTrt, menu);
  const top = rmstByTrt[trs[0]];
  const rows = trs.map((t) => {
    const p = all.byTreatment[t];
    const lm = {};
    for (const L of landmarks) lm[String(L)] = p.curve[L];
    const diffFromTop = top - p.rmst;
    return {
      treatment: t,
      rmst: p.rmst,
      curve: Array.from(p.curve),
      landmarks: lm,
      diffFromTop,
      withinTolerance: diffFromTop <= tol,
      local: { ...local.get(t) },
    };
  });
  const byPosition = mismatchByPosition(rmstByTrt, trs, reference);
  const warnings = [];
  if (rows.every((r) => r.local.supported !== true)) warnings.push('no_local_support_any');
  warnings.push(...rangeWarnings);
  return {
    modelVersion: manifest.model_version,
    stage,
    site,
    horizon: H,
    grid: Array.from({ length: H + 1 }, (_, t) => t),
    menu,
    rows,
    trs,
    reference,
    agreement: { first: trs[0] === reference[0], complete: trs.every((t, k) => t === reference[k]) },
    maxMismatch: Math.max(...byPosition),
    mismatchByPosition: byPosition,
    warnings,
  };
}
