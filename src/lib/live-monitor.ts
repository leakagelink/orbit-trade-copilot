// Phase 4H.8 — structured monitoring for the live scalping pipeline. Pure and browser-safe. Every event carries a unique
// event id and a correlation id (shared by events that belong to one incident, e.g. a gap and its resync). Details are
// redacted: keys that look like credentials are dropped and long hex/base64 strings are masked, so no API key, secret,
// signature or token can reach a log line. Memory is bounded (ring buffer); per-type counters never reset silently.
export const MONITOR_EVENT_TYPES = [
  "WS_CONNECTED", "WS_DISCONNECTED", "WS_RECONNECT_SCHEDULED", "STALE_DATA", "FEED_RECOVERED", "MISSING_CANDLE", "CANDLE_BACKFILLED",
  "SEQUENCE_GAP", "BOOK_RESYNC", "BOOK_SYNCED", "BUFFER_OVERFLOW", "DUPLICATE_EVENT", "MALFORMED_MESSAGE", "TRADE_ID_GAP",
  "CLOCK_DRIFT", "RATE_LIMITED", "REST_ERROR", "SIGNAL_EMITTED", "SIGNAL_LATENCY", "RISK_REJECTED", "RISK_INSUFFICIENT_DATA",
  "RISK_ACCEPTED", "PAPER_ORDER_REJECTED", "PAPER_FILL", "PAPER_ERROR", "PAPER_LIQUIDATION", "WORKER_RESTART",
  "RECONCILIATION_OK", "RECONCILIATION_MISMATCH", "EXECUTION_REFUSED",
] as const;
export type MonitorEventType = (typeof MONITOR_EVENT_TYPES)[number];
export type Severity = "info" | "warn" | "error";
export interface MonitorEvent {
  id: string; correlationId: string; seq: number; at: number; type: MonitorEventType; severity: Severity;
  symbol: string | null; detail: Record<string, string | number | boolean | null>;
}
const SECRET_KEY = /(api[-_]?key|secret|signature|token|password|passphrase|credential|authorization|cookie|listenkey)/i;
const LONG_OPAQUE = /\b(?:[A-Fa-f0-9]{32,}|[A-Za-z0-9+/_-]{40,}={0,2})\b/g;

/** Drops credential-like keys, masks long opaque strings and keeps only scalar values (bounded length). */
export function redact(detail: Record<string, unknown> | undefined): MonitorEvent["detail"] {
  const out: MonitorEvent["detail"] = {};
  for (const [k, v] of Object.entries(detail ?? {}).slice(0, 24)) {
    if (SECRET_KEY.test(k)) continue;
    if (v === null || typeof v === "boolean") out[k] = v;
    else if (typeof v === "number") out[k] = Number.isFinite(v) ? v : null;
    else if (typeof v === "string") out[k] = v.replace(LONG_OPAQUE, "[redacted]").slice(0, 300);
  }
  return out;
}

let fallbackCounter = 0;
export function newId(prefix = "ev"): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return `${prefix}_${c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}${(++fallbackCounter).toString(36)}`}`;
}

export interface Monitor {
  emit(type: MonitorEventType, severity: Severity, symbol: string | null, detail?: Record<string, unknown>, correlationId?: string): MonitorEvent;
  readonly events: readonly MonitorEvent[];
  readonly counts: Readonly<Record<string, number>>;
  subscribe(fn: (e: MonitorEvent) => void): () => void;
}
export function createMonitor(o: { capacity?: number; now?: () => number; id?: (p: string) => string } = {}): Monitor {
  const cap = Math.max(10, Math.min(o.capacity ?? 500, 5000)), now = o.now ?? Date.now, id = o.id ?? newId;
  const events: MonitorEvent[] = [], counts: Record<string, number> = {}, subs = new Set<(e: MonitorEvent) => void>();
  let seq = 0;
  return {
    emit(type, severity, symbol, detail, correlationId) {
      const e: MonitorEvent = Object.freeze({ id: id("ev"), correlationId: correlationId ?? id("corr"), seq: ++seq, at: now(), type, severity, symbol, detail: Object.freeze(redact(detail)) });
      events.push(e); if (events.length > cap) events.splice(0, events.length - cap);
      counts[type] = (counts[type] ?? 0) + 1;
      for (const s of subs) { try { s(e); } catch { /* a subscriber never breaks the pipeline */ } }
      return e;
    },
    get events() { return events; },
    get counts() { return counts; },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
  };
}
