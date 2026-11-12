// Pure, deterministic L2-regularised logistic regression with train-only standardisation, Platt calibration fitted on
// a separate validation slice, and out-of-sample diagnostics. No randomness, no I/O. Used for strategy-signal research;
// a model here is evidence only and never authorizes or sizes a trade.
export const LOGISTIC_MODEL_VERSION = "logreg-l2-gd-v1" as const;

export interface LogisticModel {
  version: typeof LOGISTIC_MODEL_VERSION; featureNames: string[]; mean: number[]; sd: number[]; weights: number[]; bias: number;
  calibration: { a: number; b: number } | null; trainedOn: number; positiveRate: number;
}
const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export function fitStandardizer(X: number[][]) {
  const d = X[0]?.length ?? 0, n = X.length;
  const mean = Array.from({ length: d }, (_, j) => X.reduce((a, r) => a + r[j]!, 0) / n);
  const sd = mean.map((m, j) => Math.sqrt(X.reduce((a, r) => a + (r[j]! - m) ** 2, 0) / Math.max(1, n - 1)) || 1);
  return { mean, sd };
}
const standardize = (x: number[], mean: number[], sd: number[]) => x.map((v, j) => (v - mean[j]!) / sd[j]!);

/** Full-batch gradient descent on the mean log-loss + (l2/2)·|w|². Deterministic: zero initialisation, fixed steps. */
export function trainLogistic(X: number[][], y: number[], featureNames: string[], o: { l2?: number; lr?: number; iterations?: number } = {}): LogisticModel {
  if (X.length !== y.length || X.length < 20) throw new Error("At least 20 labelled rows are required");
  if (X.some((r) => r.length !== featureNames.length || r.some((v) => !Number.isFinite(v)))) throw new Error("Feature rows must be finite and match the feature list");
  const { mean, sd } = fitStandardizer(X);
  const Z = X.map((r) => standardize(r, mean, sd));
  const l2 = o.l2 ?? 0.01, lr = o.lr ?? 0.5, it = o.iterations ?? 400, n = Z.length, d = featureNames.length;
  const w = new Array(d).fill(0); let b = 0;
  for (let k = 0; k < it; k++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = Z[i]!; let s = b; for (let j = 0; j < d; j++) s += w[j]! * z[j]!;
      const e = sigmoid(s) - y[i]!; gb += e; for (let j = 0; j < d; j++) gw[j] += e * z[j]!;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j]! / n + l2 * w[j]!);
    b -= lr * (gb / n);
  }
  return { version: LOGISTIC_MODEL_VERSION, featureNames, mean, sd, weights: w, bias: b, calibration: null, trainedOn: n, positiveRate: y.reduce((a, v) => a + v, 0) / n };
}

export function rawLogit(m: LogisticModel, x: number[]) {
  const z = standardize(x, m.mean, m.sd); let s = m.bias; for (let j = 0; j < z.length; j++) s += m.weights[j]! * z[j]!; return s;
}
/** Calibrated probability when a calibration was fitted, otherwise the raw model probability. */
export function predictProba(m: LogisticModel, x: number[]) {
  const s = rawLogit(m, x); return m.calibration ? sigmoid(m.calibration.a * s + m.calibration.b) : sigmoid(s);
}

/** Platt scaling fitted on a held-out slice (never the training rows). */
export function calibratePlatt(m: LogisticModel, X: number[][], y: number[], iterations = 400): LogisticModel {
  if (X.length < 20) throw new Error("At least 20 validation rows are required to calibrate");
  const s = X.map((x) => rawLogit(m, x)); let a = 1, b = 0;
  for (let k = 0; k < iterations; k++) {
    let ga = 0, gb = 0;
    for (let i = 0; i < s.length; i++) { const e = sigmoid(a * s[i]! + b) - y[i]!; ga += e * s[i]!; gb += e; }
    a -= 0.5 * (ga / s.length); b -= 0.5 * (gb / s.length);
  }
  return { ...m, calibration: { a, b } };
}

export function classificationMetrics(p: number[], y: number[]) {
  const n = p.length, eps = 1e-12;
  const logLoss = -p.reduce((a, q, i) => a + (y[i] ? Math.log(Math.max(q, eps)) : Math.log(Math.max(1 - q, eps))), 0) / n;
  const brier = p.reduce((a, q, i) => a + (q - y[i]!) ** 2, 0) / n;
  const base = y.reduce((a, v) => a + v, 0) / n;
  const brierBaseline = base * (1 - base); // always predicting the base rate
  // AUC via rank statistic (ties counted half).
  const idx = p.map((q, i) => [q, y[i]!] as const).sort((u, v) => u[0] - v[0]);
  let pos = 0, neg = 0, rankSum = 0;
  for (let i = 0; i < idx.length;) { let j = i; while (j < idx.length && idx[j]![0] === idx[i]![0]) j++; const r = (i + j + 1) / 2; for (let k = i; k < j; k++) if (idx[k]![1]) { rankSum += r; pos++; } else neg++; i = j; }
  const auc = pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : null;
  const bins = Array.from({ length: 10 }, (_, k) => ({ lo: k / 10, hi: (k + 1) / 10, n: 0, meanP: 0, observed: 0 }));
  p.forEach((q, i) => { const bn = bins[Math.min(9, Math.floor(q * 10))]!; bn.n++; bn.meanP += q; bn.observed += y[i]!; });
  const reliability = bins.filter((bn) => bn.n > 0).map((bn) => ({ range: `${bn.lo.toFixed(1)}–${bn.hi.toFixed(1)}`, n: bn.n, meanPredicted: bn.meanP / bn.n, observedRate: bn.observed / bn.n }));
  const ece = reliability.reduce((a, r) => a + (r.n / n) * Math.abs(r.meanPredicted - r.observedRate), 0);
  return { n, baseRate: base, logLoss, brier, brierBaseline, auc, ece, reliability };
}
