/** Pure, failure-injectable Futures recovery contracts. No broker or database imports. */
export interface FillOrder {
  orderId: number; clientOrderId: string; symbol: string; side: string; positionSide?: string;
  status: string; executedQty: string; avgPrice: string;
}
export const terminalOrder = (s: string) => ['FILLED','CANCELED','CANCELLED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(s);
export const activeOrder = (s: string) => ['NEW','PARTIALLY_FILLED'].includes(s);
export function confirmedQuantity(o: Pick<FillOrder,'executedQty'>) {
  const q = Number(o.executedQty);
  if (!Number.isFinite(q) || q < 0) throw new Error('Invalid broker fill quantity');
  return q;
}
export function validateOrder(o: FillOrder, symbol: string, client: string, side: string) {
  if (o.symbol !== symbol || o.clientOrderId !== client || o.side !== side || (o.positionSide != null && o.positionSide !== 'BOTH')) throw new Error('Broker order identity mismatch');
  confirmedQuantity(o);
  if (!activeOrder(o.status) && !terminalOrder(o.status)) throw new Error('Unknown broker order status; original intent retained');
}
/** Cancels only the original order. A timeout or unknown status never leads to another submit. */
export async function settleOriginal(ports: {
  lookup(): Promise<FillOrder>; cancel(): Promise<unknown>;
}, validate: (o: FillOrder) => void): Promise<FillOrder> {
  let o = await ports.lookup(); validate(o);
  if (activeOrder(o.status)) {
    try { await ports.cancel(); } catch { /* cancellation ack is not authoritative */ }
    o = await ports.lookup(); validate(o);
  }
  if (!terminalOrder(o.status)) throw new Error('Order cancellation unconfirmed; exposure remains locked');
  return o;
}
export interface ProtectionOrder {
  algoId: number; clientAlgoId: string; symbol?: string; side?: string; positionSide?: string;
  orderType?: string; type?: string; algoStatus?: string; triggerPrice?: string;
  closePosition?: boolean | string; reduceOnly?: boolean | string; quantity?: string;
  workingType?: string; actualOrderId?: number;
}
const yes = (v: unknown) => v === true || v === 'true';
export function protectionProblem(o: ProtectionOrder, expected: {
  client: string; symbol: string; side: string; type: string; trigger: number; qty: number; tick: number;
}): string | null {
  if (!(o.algoId > 0) || o.clientAlgoId !== expected.client || o.symbol !== expected.symbol || o.side !== expected.side || o.positionSide !== 'BOTH') return 'Protection identity mismatch';
  if (!['NEW','WORKING'].includes(o.algoStatus ?? '')) return 'Protection is not active';
  if ((o.orderType ?? o.type) !== expected.type || o.workingType !== 'MARK_PRICE') return 'Protection trigger semantics mismatch';
  if (!Number.isFinite(Number(o.triggerPrice)) || Math.abs(Number(o.triggerPrice) - expected.trigger) > expected.tick / 2) return 'Protection trigger price mismatch';
  // closePosition intentionally has no quantity: it closes the entire actual one-way position.
  if (yes(o.closePosition)) {
    if (Number(o.quantity ?? 0) !== 0) return 'Close-position protection has a conflicting quantity';
  } else if (!yes(o.reduceOnly) || Math.abs(Number(o.quantity) - expected.qty) > 1e-8) return 'Protection does not reduce the confirmed exposure';
  return null;
}
export interface BrokerFill { id: number; orderId: number; qty: string; price: string; commission: string; commissionAsset: string; realizedPnl: string; side: string; time: number; positionSide?: string }
export interface FundingEvent { tranId: number | string; income: string; asset: string; incomeType: string; time: number; symbol: string }
export function attributeLedger(input: {
  fills: BrokerFill[]; funding: FundingEvent[]; entryOrderId: string; exitOrderIds: string[];
  symbol: string; side: 'buy'|'sell'; openedAt: number; closedAt: number;
}) {
  const dedup = new Map<string, BrokerFill>();
  for (const f of input.fills) {
    const key = String(f.id); const old = dedup.get(key);
    if (old && JSON.stringify(old) !== JSON.stringify(f)) throw new Error('Conflicting duplicate fill evidence');
    dedup.set(key, f);
  }
  const fills = [...dedup.values()];
  const ids = new Set([input.entryOrderId, ...input.exitOrderIds]);
  // External fills in the holding interval make funding/inventory attribution ambiguous.
  if (fills.some(f => f.time >= input.openedAt && f.time <= input.closedAt && !ids.has(String(f.orderId)))) throw new Error('External position changes require independent reconciliation');
  const owned = fills.filter(f => ids.has(String(f.orderId)) && f.time >= input.openedAt && f.time <= input.closedAt);
  if (owned.some(f => f.commissionAsset !== 'USDT' || (f.positionSide != null && f.positionSide !== 'BOTH') || ![f.qty,f.price,f.commission,f.realizedPnl].every(v => Number.isFinite(Number(v))) || Number(f.qty) <= 0 || Number(f.price) <= 0 || Number(f.commission) < 0)) throw new Error('Fill cost evidence incomplete');
  const entry = owned.filter(f => String(f.orderId) === input.entryOrderId && f.side === (input.side === 'buy' ? 'BUY' : 'SELL'));
  const exits = owned.filter(f => input.exitOrderIds.includes(String(f.orderId)) && f.side === (input.side === 'buy' ? 'SELL' : 'BUY'));
  if (entry.length + exits.length !== owned.length) throw new Error('Fill side mismatch');
  const total = (xs: BrokerFill[]) => xs.reduce((s,f) => s + Number(f.qty), 0);
  const qty = total(entry), exitQty = total(exits);
  if (!(qty > 0) || Math.abs(qty - exitQty) > 1e-8) throw new Error('Entry/exit fills do not reconcile to broker-flat inventory');
  const funding = new Map<string, FundingEvent>();
  for (const f of input.funding) {
    if (f.symbol !== input.symbol || f.time < input.openedAt || f.time > input.closedAt) continue;
    if (f.asset !== 'USDT' || f.incomeType !== 'FUNDING_FEE' || !Number.isFinite(Number(f.income)) || f.tranId == null) throw new Error('Funding evidence incomplete');
    const old = funding.get(String(f.tranId));
    if (old && JSON.stringify(old) !== JSON.stringify(f)) throw new Error('Conflicting funding transaction');
    funding.set(String(f.tranId), f);
  }
  const gross = exits.reduce((s,f) => s + Number(f.realizedPnl), 0);
  const fees = owned.reduce((s,f) => s + Number(f.commission), 0);
  const fundingPnl = [...funding.values()].reduce((s,f) => s + Number(f.income), 0);
  return { qty, entry: entry.reduce((s,f) => s + Number(f.qty)*Number(f.price),0)/qty,
    exit: exits.reduce((s,f) => s + Number(f.qty)*Number(f.price),0)/exitQty,
    gross, fees, funding: fundingPnl, net: gross + fundingPnl - fees, entryFills: entry, exitFills: exits, fundingEvents: [...funding.values()] };
}
/** Only a terminal original exit can permit a new remainder intent. Never reuse its client ID. */
export function remainderQuantity(entryQty: number, brokerSigned: number, side: 'buy'|'sell', exits: FillOrder[]) {
  if (!Number.isFinite(brokerSigned) || !(entryQty >= 0)) throw new Error('Broker inventory unavailable');
  if (exits.some(o => !terminalOrder(o.status))) throw new Error('Unknown or active exit; lookup only');
  const closed = exits.reduce((s,o) => s + confirmedQuantity(o),0);
  const remaining = entryQty - closed;
  if (remaining < -1e-8 || Math.abs(Math.abs(brokerSigned) - remaining) > 1e-8 || (remaining > 1e-8 && (brokerSigned > 0) !== (side === 'buy'))) throw new Error('Broker inventory changed externally; entry remains blocked');
  return Math.max(0, remaining);
}