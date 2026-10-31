export function alertHit(direction: "above" | "below", target: number, price: number): boolean {
  return Number.isFinite(price) && price > 0 && Number.isFinite(target) && target > 0 && (direction === "above" ? price >= target : price <= target);
}

export function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function tradeCsv(trades: Array<{ id: string; trading_pair: string; side: string; mode: string; opened_at: string; closed_at: string | null; entry_price: number; exit_price: number | null; quantity: number; realized_pnl: number; fees: number; close_reason: string | null }>): string {
  const headers = ["Trade ID", "Market", "Side", "Mode", "Opened UTC", "Closed UTC", "Entry", "Exit", "Quantity", "Gross P&L", "Fees", "Net P&L", "Close reason"];
  return "\ufeff" + [headers, ...trades.map(t => [t.id,t.trading_pair,t.side,t.mode,t.opened_at,t.closed_at,t.entry_price,t.exit_price,t.quantity,t.realized_pnl,t.fees,t.realized_pnl-t.fees,t.close_reason])].map(row => row.map(csvCell).join(",")).join("\r\n");
}

export function downloadCsv(content: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}