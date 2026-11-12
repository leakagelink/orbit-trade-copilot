// Testnet-only failure injection for the Phase 1.6 certification harness. Inert unless a plan is attached to a Testnet
// account; every fired rule is logged so injected outcomes are never reported as real exchange behaviour.
export type CallParams = Record<string, string | number>;
export type FaultEffect =
  | { kind: 'reject'; code: number; msg: string }                 // request is NOT sent; caller sees a Binance-style error
  | { kind: 'mutate'; params: (p: CallParams) => CallParams }     // request IS sent with altered params; broker answers for real
  | { kind: 'drop_response' }                                     // request IS sent; the response is withheld as a timeout
  | { kind: 'respond'; body: (real: unknown) => unknown };        // request IS sent; the caller sees a replaced response
export interface FaultRule { id: string; method: 'GET' | 'POST' | 'DELETE'; path: string; when?: (p: CallParams) => boolean; times?: number; effect: FaultEffect }
export interface FaultEvent { rule: string; kind: FaultEffect['kind']; method: string; path: string; sent: boolean; at: string }
export interface FaultPlan { label: string; rules: FaultRule[]; fired: Record<string, number>; events: FaultEvent[] }

export function faultPlan(label: string, rules: FaultRule[]): FaultPlan {
  const ids = new Set<string>();
  for (const r of rules) { if (ids.has(r.id)) throw new Error(`Duplicate fault rule ${r.id}`); ids.add(r.id); }
  return { label, rules, fired: {}, events: [] };
}
export const INJECTED = '[injected]';
const log = (plan: FaultPlan, rule: FaultRule, method: string, path: string, sent: boolean) =>
  plan.events.push({ rule: rule.id, kind: rule.effect.kind, method, path, sent, at: new Date().toISOString() });

/** Chooses at most one rule per call and records it. Throws (without sending) for `reject`. */
export function prepareCall(plan: FaultPlan, testnet: boolean, method: string, path: string, params: CallParams) {
  if (!testnet) throw new Error('Fault injection is Testnet-only; production call refused');
  const rule = plan.rules.find(r => r.method === method && r.path === path && (plan.fired[r.id] ?? 0) < (r.times ?? 1) && (!r.when || r.when(params)));
  if (!rule) return { rule: null, params };
  plan.fired[rule.id] = (plan.fired[rule.id] ?? 0) + 1;
  if (rule.effect.kind === 'reject') { log(plan, rule, method, path, false); throw new Error(`Binance Futures 400 (${rule.effect.code}): ${rule.effect.msg} ${INJECTED}`); }
  log(plan, rule, method, path, true);
  return { rule, params: rule.effect.kind === 'mutate' ? rule.effect.params({ ...params }) : params };
}
/** Applies post-send effects to a successful broker response. */
export function finishCall(rule: FaultRule | null, body: unknown): unknown {
  if (!rule) return body;
  if (rule.effect.kind === 'drop_response') throw new Error(`TimeoutError: response lost after the request was sent ${INJECTED}`);
  if (rule.effect.kind === 'respond') return rule.effect.body(body);
  return body;
}
