import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/app-shell";

export const Route = createFileRoute("/reset-password")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Set a new password — AlgoVirt" },
      { name: "description", content: "Choose a new password for your AlgoVirt account." },
      { property: "og:title", content: "Set a new password — AlgoVirt" },
      { property: "og:description", content: "Choose a new password for your AlgoVirt account." },
    ],
  }),
  component: Reset,
});

function Reset() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (window.location.hash.includes("type=recovery")) setReady(true);
    const { data } = supabase.auth.onAuthStateChange((ev) => ev === "PASSWORD_RECOVERY" && setReady(true));
    supabase.auth.getSession().then(({ data: s }) => s.session && setReady(true));
    return () => data.subscription.unsubscribe();
  }, []);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password"));
    if (password.length < 8) return void toast.error("Password must be at least 8 characters");
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (error) return void toast.error(error.message);
    toast.success("Password updated");
    navigate({ to: "/dashboard" });
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background bg-grid p-6">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-6">
        <Logo />
        {ready ? (
          <form onSubmit={submit} className="space-y-4">
            <h1 className="text-lg font-semibold">Set a new password</h1>
            <div className="space-y-1.5"><Label htmlFor="p">New password</Label><Input id="p" name="password" type="password" minLength={8} required /></div>
            <Button className="w-full" disabled={busy}>Update password</Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">Open this page from the reset link in your email.</p>
        )}
      </div>
    </div>
  );
}
