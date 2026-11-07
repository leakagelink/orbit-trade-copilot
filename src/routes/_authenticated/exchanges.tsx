import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Cable, KeyRound, Plus, RefreshCw, ShieldCheck, Unplug } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader, EmptyState } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EXCHANGES, exchangeName, type ExchangeMeta } from "@/lib/exchanges";
import { derivConnectionReserved } from "@/lib/deriv";
import { connectExchange, disconnectExchange, updateExchangeCredentials, verifyExchange } from "@/lib/exchanges.functions";

const D = "Connect your exchange and broker accounts. API credentials are encrypted on the server.";
export const Route = createFileRoute("/_authenticated/exchanges")({
  head: () => ({ meta: [{ title: "Exchanges — AlgoVirt" }, { name: "description", content: D }, { property: "og:title", content: "Exchanges — AlgoVirt" }, { property: "og:description", content: D }, { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" }] }),
  component: Exchanges,
});

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = { connected: "default", pending: "secondary", error: "destructive", expired: "destructive", disconnected: "outline" };

function Exchanges() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["exchange_connections"],
    queryFn: async () => {
      const { data, error } = await supabase.from("exchange_connections").select("*").order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const [picked, setPicked] = useState<ExchangeMeta | null>(null);
  const derivReserved = derivConnectionReserved(q.data ?? []);
  const derivStatus = q.data?.find((c) => c.exchange === "deriv" && c.status !== "disconnected")?.status;
  const [reconnect, setReconnect] = useState<{ id: string; exchange: string } | null>(null);
  const [toDisconnect, setToDisconnect] = useState<string | null>(null);
  const disconnect = useServerFn(disconnectExchange);
  const verify = useServerFn(verifyExchange);
  const [verifying, setVerifying] = useState<string | null>(null);
  async function runVerify(id: string) {
    setVerifying(id);
    try {
      const r = await verify({ data: { id } });
      if (r.ok) toast.success(`Keys verified — ${r.assets} assets with a balance`); else toast.error(r.error);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Verification failed"); }
    setVerifying(null); refresh();
  }
  const refresh = () => qc.invalidateQueries({ queryKey: ["exchange_connections"] });

  return (
    <div>
      <PageHeader title="Exchange connections" description={D} />
      <div className="space-y-8 p-6">
        <div className="flex items-start gap-3 rounded-lg border bg-accent/40 p-4 text-sm">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p className="text-muted-foreground">Create API keys with <span className="text-foreground">read + trade</span> permissions only. <span className="text-foreground">Never enable withdrawals.</span> Restrict keys by IP where your exchange allows it.</p>
        </div>

        <section>
          <h2 className="mb-3 text-sm font-medium">Your connections</h2>
          {q.isLoading ? <Skeleton className="h-24" /> : q.isError ? <p className="text-sm text-destructive">{q.error.message}</p> : !q.data?.length ? (
            <EmptyState icon={Cable} title="No exchanges connected" body="Pick an exchange below to add your API keys." />
          ) : (
            <div className="divide-y rounded-lg border bg-card">
              {q.data.map((c) => (
                <div key={c.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <div className="flex min-w-0 flex-wrap items-center gap-2"><span className="min-w-0 break-words font-medium">{c.label}</span><Badge variant={STATUS_VARIANT[c.status]}>{c.status === "connected" ? "Active" : c.status}</Badge>{c.is_testnet && <Badge variant="outline">{c.exchange === "deriv" ? "demo" : "testnet"}</Badge>}</div>
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{exchangeName(c.exchange)} · {c.account_type}{c.exchange !== "deriv" && ` · key ${c.api_key_hint ?? "—"}`}</div>
                    {c.exchange === "deriv" && <Badge variant="outline">Connection only · orders unavailable</Badge>}
                    {(() => { const bal = (c.permissions as { balances?: { asset: string; free: number; locked: number }[] } | null)?.balances; return c.status === "connected" && bal ? <p className="mt-1 font-mono text-xs">{bal.length ? bal.slice(0, 6).map((b) => `${b.asset} ${+(b.free + b.locked).toPrecision(6)}`).join(" · ") : "No balances"}{c.last_synced_at && <span className="text-muted-foreground"> · synced {new Date(c.last_synced_at).toLocaleString()}</span>}</p> : null; })()}
                    {c.last_error && <p className="mt-1 max-w-xl text-xs text-muted-foreground">{c.last_error}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {c.status !== "disconnected" && <Button size="sm" variant="outline" disabled={verifying === c.id} onClick={() => runVerify(c.id)}><RefreshCw className={`mr-1 h-3.5 w-3.5 ${verifying === c.id ? "animate-spin" : ""}`} />Verify</Button>}
                    {c.exchange !== "deriv" && <Button size="sm" variant="outline" onClick={() => setReconnect({ id: c.id, exchange: c.exchange })}><KeyRound className="mr-1 h-3.5 w-3.5" />{c.status === "disconnected" ? "Reconnect" : "Update keys"}</Button>}
                    {c.status !== "disconnected" && <Button size="sm" variant="ghost" onClick={() => setToDisconnect(c.id)}><Unplug className="mr-1 h-3.5 w-3.5" />Disconnect</Button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-sm font-medium">Add a connection</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {EXCHANGES.map((e) => (
              <Button variant="outline" key={e.id} disabled={!e.available || (e.id === "deriv" && (derivReserved || q.isLoading || q.isError))} onClick={() => setPicked(e)} className="group block h-auto whitespace-normal rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:border-border">
                <div className="flex items-center justify-between"><span className="font-medium">{e.name}</span>{e.id === "deriv" && derivReserved ? <Badge variant={derivStatus === "connected" ? "default" : "secondary"}>{derivStatus === "connected" ? "Active" : "Already added"}</Badge> : e.available ? <Plus className="h-4 w-4 text-muted-foreground group-hover:text-primary" /> : <Badge variant="outline">Soon</Badge>}</div>
                <div className="mt-1 text-xs text-muted-foreground">{e.market}</div>
                <div className="mt-3 font-mono text-[10px] text-muted-foreground">{e.id === "deriv" && derivReserved ? "Disconnect existing account to add another" : e.connectionOnly ? "PAT / App ID · demo or real" : e.orderTypes.join(" · ")}</div>
              </Button>
            ))}
          </div>
        </section>
      </div>

      <CredentialsDialog meta={picked} onClose={() => setPicked(null)} onDone={refresh} />
      <CredentialsDialog meta={reconnect ? EXCHANGES.find((e) => e.id === reconnect.exchange) ?? null : null} connectionId={reconnect?.id} onClose={() => setReconnect(null)} onDone={refresh} />

      <AlertDialog open={!!toDisconnect} onOpenChange={(o) => !o && setToDisconnect(null)}>
        <AlertDialogContent>
          <AlertDialogHeader><AlertDialogTitle>Disconnect this account?</AlertDialogTitle><AlertDialogDescription>Stored API keys are permanently deleted. Bots using this account will be unable to trade.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={async () => { if (!toDisconnect) return; try { await disconnect({ data: { id: toDisconnect } }); toast.success("Disconnected"); refresh(); } catch (e) { toast.error((e as Error).message); } }}>Disconnect</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function CredentialsDialog({ meta, connectionId, onClose, onDone }: { meta: ExchangeMeta | null; connectionId?: string | undefined; onClose: () => void; onDone: () => void }) {
  const connect = useServerFn(connectExchange);
  const update = useServerFn(updateExchangeCredentials);
  const [busy, setBusy] = useState(false);
  const [testnet, setTestnet] = useState(false);
  const [accountType, setAccountType] = useState<"spot" | "futures">("spot");

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!meta) return;
    const f = new FormData(e.currentTarget);
    const creds = { apiKey: String(f.get("apiKey")), apiSecret: String(f.get("apiSecret")), passphrase: meta.needsPassphrase ? String(f.get("passphrase")) : undefined };
    setBusy(true);
    try {
      if (connectionId) await update({ data: { id: connectionId, ...creds } });
      else await connect({ data: { exchange: meta.id, label: String(f.get("label")), accountType, isTestnet: testnet, ...creds } });
      toast.success("Credentials saved securely");
      onDone();
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!meta} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{connectionId ? "Update keys" : "Connect"} {meta?.name}</DialogTitle>
          <DialogDescription>Keys are encrypted on the server and never shown again.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4" autoComplete="off">
          {!connectionId && (
            <>
              <div className="space-y-1.5"><Label htmlFor="label">Label</Label><Input id="label" name="label" required maxLength={60} defaultValue={meta ? `${meta.name} main` : ""} /></div>
              <div className="grid gap-4 sm:flex">
                {meta?.id === "deriv" ? <div className="flex-1 space-y-1.5"><Label>Account type</Label><p className="text-sm">Deriv Options</p></div> : <div className="flex-1 space-y-1.5"><Label>Account type</Label>
                  <Select value={accountType} onValueChange={(v) => setAccountType(v as "spot" | "futures")}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="spot">Spot</SelectItem><SelectItem value="futures">Futures</SelectItem></SelectContent></Select>
                </div>}
                {meta?.supportsTestnet && <div className="flex items-end gap-2 pb-2"><Switch id="tn" checked={testnet} onCheckedChange={setTestnet} /><Label htmlFor="tn">{meta?.id === "deriv" ? "Demo account" : meta?.id === "oanda" ? "Practice account" : "Testnet"}</Label></div>}
              </div>
            </>
          )}
          {meta?.id === "deriv" && <div className="space-y-2 text-sm text-muted-foreground"><p>Use a Deriv Personal Access Token (PAT) with trade scope and its PAT App ID. Legacy API tokens and MT5 passwords are not supported. Orders are not available in AlgoVirt for this connection.</p><a href="https://developers.deriv.com/docs/intro/authentication/" target="_blank" rel="noopener noreferrer" className="text-primary underline">Deriv token and App ID setup</a></div>}
          <div className="space-y-1.5"><Label htmlFor="apiKey">{meta?.id === "deriv" ? "Personal Access Token (PAT)" : meta?.id === "oanda" ? "API token" : "API key"}</Label><Input id="apiKey" name="apiKey" type="password" required minLength={8} className="font-mono" /></div>
          <div className="space-y-1.5"><Label htmlFor="apiSecret">{meta?.id === "deriv" ? "PAT App ID" : meta?.id === "oanda" ? "Account ID (e.g. 101-004-1234567-001)" : "API secret"}</Label><Input id="apiSecret" name="apiSecret" type={meta?.id === "oanda" || meta?.id === "deriv" ? "text" : "password"} required minLength={meta?.id === "deriv" ? 1 : 8} className="font-mono" /></div>
          {meta?.needsPassphrase && <div className="space-y-1.5"><Label htmlFor="passphrase">API passphrase</Label><Input id="passphrase" name="passphrase" type="password" required className="font-mono" /></div>}
          <DialogFooter><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={busy}>{busy ? "Saving…" : "Save"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
