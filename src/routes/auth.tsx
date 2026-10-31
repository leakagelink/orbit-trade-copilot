import { createFileRoute, Link, redirect, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import "@lovable.dev/cloud-auth-js/styles.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Logo } from "@/components/app-shell";

const searchSchema = z.object({ redirect: z.string().optional(), mode: z.enum(["login", "register"]).optional(), ref: z.string().max(16).optional() });

function safePath(p?: string) {
  if (!p) return "/dashboard";
  try {
    const u = new URL(p, window.location.origin);
    return u.origin === window.location.origin ? u.pathname + u.search : "/dashboard";
  } catch {
    return "/dashboard";
  }
}

export const Route = createFileRoute("/auth")({
  ssr: false,
  validateSearch: searchSchema,
  beforeLoad: async ({ search }) => {
    const { data } = await supabase.auth.getUser();
    if (data.user) throw redirect({ to: safePath(search.redirect) as "/dashboard" });
  },
  head: () => ({
    meta: [
      { title: "Sign in — Quantra" },
      { name: "description", content: "Sign in or create your Quantra trading account." },
      { property: "og:title", content: "Sign in — Quantra" },
      { property: "og:description", content: "Sign in or create your Quantra trading account." },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  useEffect(() => { if (search.ref && /^[A-Za-z0-9]{4,16}$/.test(search.ref)) localStorage.setItem("pending_ref", search.ref.toUpperCase()); }, [search.ref]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  async function oauth(provider: "google" | "lovable") {
    if (search.redirect) sessionStorage.setItem("post_auth_redirect", safePath(search.redirect));
    const r = await lovable.auth.signInWithOAuth(provider, { redirect_uri: window.location.origin + "/auth" });
    if (r.error) toast.error(r.error.message ?? "Sign-in failed");
    else if (!r.redirected) {
      const dest = sessionStorage.getItem("post_auth_redirect") ?? "/dashboard";
      sessionStorage.removeItem("post_auth_redirect");
      navigate({ to: dest as "/dashboard" });
    }
  }

  async function login(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    const { error } = await supabase.auth.signInWithPassword({ email: String(f.get("email")), password: String(f.get("password")) });
    setBusy(false);
    if (error) return void toast.error(error.message);
    navigate({ to: safePath(search.redirect) as "/dashboard" });
  }

  async function register(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password"));
    if (password.length < 8) return void toast.error("Password must be at least 8 characters");
    setBusy(true);
    const email = String(f.get("email"));
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin + "/dashboard", data: { display_name: String(f.get("name")) } },
    });
    setBusy(false);
    if (error) return void toast.error(error.message);
    setSent(email);
  }

  return (
    <div className="grid min-h-screen bg-background lg:grid-cols-2">
      <div className="relative hidden flex-col justify-between overflow-hidden border-r bg-sidebar bg-grid p-10 lg:flex">
        <Link to="/"><Logo /></Link>
        <div className="space-y-4">
          <p className="font-mono text-xs uppercase tracking-widest text-primary">Systematic. Risk-first.</p>
          <h2 className="max-w-md text-3xl font-semibold leading-tight">Turn trading ideas into validated, rule-based strategies.</h2>
          <p className="max-w-md text-sm text-muted-foreground">Paper trade before you risk capital. Every order passes risk controls. No promised returns — just discipline.</p>
        </div>
        <p className="font-mono text-xs text-muted-foreground">Trading involves substantial risk of loss.</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="mb-8 lg:hidden"><Logo /></div>
          {sent ? (
            <div className="space-y-3">
              <h1 className="text-xl font-semibold">Check your email</h1>
              <p className="text-sm text-muted-foreground">We sent a confirmation link to <span className="font-medium text-foreground">{sent}</span>. Click it to activate your account.</p>
              <Button variant="outline" onClick={() => setSent(null)}>Back to sign in</Button>
            </div>
          ) : (
            <Tabs defaultValue={search.mode ?? "login"}>
              <TabsList className="mb-6 grid w-full grid-cols-2">
                <TabsTrigger value="login">Sign in</TabsTrigger>
                <TabsTrigger value="register">Create account</TabsTrigger>
              </TabsList>
              <div className="space-y-2">
                <button type="button" className="lovable-auth-button w-full" onClick={() => oauth("lovable")}>Continue with Lovable</button>
                <Button type="button" variant="outline" className="w-full" onClick={() => oauth("google")}>Continue with Google</Button>
              </div>
              <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground"><div className="h-px flex-1 bg-border" />or<div className="h-px flex-1 bg-border" /></div>
              <TabsContent value="login">
                <form onSubmit={login} className="space-y-4">
                  <div className="space-y-1.5"><Label htmlFor="le">Email</Label><Input id="le" name="email" type="email" required autoComplete="email" /></div>
                  <div className="space-y-1.5">
                    <div className="flex justify-between"><Label htmlFor="lp">Password</Label><Link to="/forgot-password" className="text-xs text-primary hover:underline">Forgot?</Link></div>
                    <Input id="lp" name="password" type="password" required autoComplete="current-password" />
                  </div>
                  <Button className="w-full" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
                </form>
              </TabsContent>
              <TabsContent value="register">
                <form onSubmit={register} className="space-y-4">
                  <div className="space-y-1.5"><Label htmlFor="rn">Name</Label><Input id="rn" name="name" required maxLength={60} /></div>
                  <div className="space-y-1.5"><Label htmlFor="re">Email</Label><Input id="re" name="email" type="email" required autoComplete="email" /></div>
                  <div className="space-y-1.5"><Label htmlFor="rp">Password</Label><Input id="rp" name="password" type="password" required minLength={8} autoComplete="new-password" /></div>
                  <Button className="w-full" disabled={busy}>{busy ? "Creating…" : "Create account"}</Button>
                </form>
              </TabsContent>
            </Tabs>
          )}
        </div>
      </div>
    </div>
  );
}
