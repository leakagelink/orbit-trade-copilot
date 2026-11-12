// Pure, deterministic gradient-boosted decision trees (histogram splits, logistic loss, Newton leaf values with L2) for
// strategy-signal research — a self-contained alternative to LightGBM/XGBoost that runs in any JS runtime with no
// native or WASM dependency. Bins come from TRAINING rows only; ties break by feature then bin order; no randomness.
// Like the logistic baseline, a model here is evidence only and never sizes or authorizes a trade.
export const GBDT_MODEL_VERSION = "gbdt-hist-v1" as const;

export interface GbdtNode { leaf: boolean; feature: number; threshold: number; left: number; right: number; value: number }
export interface GbdtModel { version: typeof GBDT_MODEL_VERSION; featureNames: string[]; base: number; trees: GbdtNode[][]; calibration: { a: number; b: number } | null; trainedOn: number; params: Required<GbdtParams> }
export interface GbdtParams { trees?: number; depth?: number; learningRate?: number; minLeaf?: number; l2?: number; bins?: number }
const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** Quantile bin edges per feature from the training rows (sorted, de-duplicated). Value v goes to bin #edges ≤ v… */
export function binEdges(X: number[][], bins: number): number[][] {
  const d = X[0]?.length ?? 0;
  return Array.from({ length: d }, (_, j) => {
    const v = X.map((r) => r[j]!).sort((a, b) => a - b), out: number[] = [];
    for (let k = 1; k < bins; k++) { const q = v[Math.min(v.length - 1, Math.floor((k / bins) * v.length))]!; if (!out.length || q > out.at(-1)!) out.push(q); }
    return out;
  });
}
const binOf = (edges: number[], x: number) => { let lo = 0, hi = edges.length; while (lo < hi) { const m = (lo + hi) >> 1; if (x <= edges[m]!) hi = m; else lo = m + 1; } return lo; };

export function trainGbdt(X: number[][], y: number[], featureNames: string[], p: GbdtParams = {}): GbdtModel {
  if (X.length !== y.length || X.length < 50) throw new Error("At least 50 labelled rows are required");
  if (X.some((r) => r.length !== featureNames.length || r.some((v) => !Number.isFinite(v)))) throw new Error("Feature rows must be finite and match the feature list");
  const P: Required<GbdtParams> = { trees: p.trees ?? 100, depth: p.depth ?? 3, learningRate: p.learningRate ?? 0.05, minLeaf: p.minLeaf ?? 50, l2: p.l2 ?? 1, bins: p.bins ?? 32 };
  const n = X.length, d = featureNames.length, edges = binEdges(X, P.bins);
  const B = Array.from({ length: d }, (_, j) => Uint8Array.from(X.map((r) => binOf(edges[j]!, r[j]!))));
  const rate = Math.min(1 - 1e-6, Math.max(1e-6, y.reduce((a, v) => a + v, 0) / n)), base = Math.log(rate / (1 - rate));
  const F = new Float64Array(n).fill(base), g = new Float64Array(n), h = new Float64Array(n);
  const trees: GbdtNode[][] = [];
  for (let t = 0; t < P.trees; t++) {
    for (let i = 0; i < n; i++) { const pr = sigmoid(F[i]!); g[i] = pr - y[i]!; h[i] = Math.max(1e-12, pr * (1 - pr)); }
    const nodes: GbdtNode[] = [];
    const grow = (rows: Int32Array, depth: number): number => {
      let G = 0, H = 0; for (const i of rows) { G += g[i]!; H += h[i]!; }
      const id = nodes.length; nodes.push({ leaf: true, feature: -1, threshold: 0, left: -1, right: -1, value: (-G / (H + P.l2)) * P.learningRate });
      if (depth >= P.depth || rows.length < 2 * P.minLeaf) return id;
      const parent = (G * G) / (H + P.l2);
      let best = { gain: 1e-12, f: -1, b: -1 };
      for (let j = 0; j < d; j++) {
        const nb = edges[j]!.length + 1, hg = new Float64Array(nb), hh = new Float64Array(nb), hc = new Int32Array(nb), col = B[j]!;
        for (const i of rows) { const b = col[i]!; hg[b] = hg[b]! + g[i]!; hh[b] = hh[b]! + h[i]!; hc[b] = hc[b]! + 1; }
        let gl = 0, hl = 0, cl = 0;
        for (let b = 0; b < nb - 1; b++) {
          gl += hg[b]!; hl += hh[b]!; cl += hc[b]!;
          if (cl < P.minLeaf || rows.length - cl < P.minLeaf) continue;
          const gain = (gl * gl) / (hl + P.l2) + ((G - gl) * (G - gl)) / (H - hl + P.l2) - parent;
          if (gain > best.gain) best = { gain, f: j, b };
        }
      }
      if (best.f < 0) return id;
      const col = B[best.f]!, L: number[] = [], R: number[] = [];
      for (const i of rows) (col[i]! <= best.b ? L : R).push(i);
      const node = nodes[id]!; node.leaf = false; node.feature = best.f; node.threshold = edges[best.f]![best.b]!;
      node.left = grow(Int32Array.from(L), depth + 1); node.right = grow(Int32Array.from(R), depth + 1);
      return id;
    };
    grow(Int32Array.from({ length: n }, (_, i) => i), 0);
    trees.push(nodes);
    for (let i = 0; i < n; i++) F[i] = F[i]! + treeValue(nodes, X[i]!);
  }
  return { version: GBDT_MODEL_VERSION, featureNames, base, trees, calibration: null, trainedOn: n, params: P };
}
function treeValue(nodes: GbdtNode[], x: number[]) { let k = 0; while (!nodes[k]!.leaf) { const nd = nodes[k]!; k = x[nd.feature]! <= nd.threshold ? nd.left : nd.right; } return nodes[k]!.value; }
export function gbdtRaw(m: GbdtModel, x: number[]) { let s = m.base; for (const t of m.trees) s += treeValue(t, x); return s; }
export function gbdtProba(m: GbdtModel, x: number[]) { const s = gbdtRaw(m, x); return m.calibration ? sigmoid(m.calibration.a * s + m.calibration.b) : sigmoid(s); }

/** Platt scaling on held-out scores (never training rows). */
export function plattFit(scores: number[], y: number[], iterations = 400) {
  if (scores.length < 20) throw new Error("At least 20 validation rows are required to calibrate");
  let a = 1, b = 0;
  for (let k = 0; k < iterations; k++) { let ga = 0, gb = 0; for (let i = 0; i < scores.length; i++) { const e = sigmoid(a * scores[i]! + b) - y[i]!; ga += e * scores[i]!; gb += e; } a -= 0.5 * (ga / scores.length); b -= 0.5 * (gb / scores.length); }
  return { a, b };
}
export function calibrateGbdt(m: GbdtModel, X: number[][], y: number[]): GbdtModel { return { ...m, calibration: plattFit(X.map((x) => gbdtRaw(m, x)), y) }; }
