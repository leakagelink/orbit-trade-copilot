import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/app-shell";

export const Route = createFileRoute("/forgot-password")({
  head: () => ({
    meta: [
      { title: "Reset password — Quantra" },
      { name: "description", content: "Request a password reset link for your Quantra account." },
      { property: "og:title", content: "Reset password — Quantra" },
      { property: "og:description", content: "Request a password reset link for your Quantra account." },
    ],
  }),
  component: Forgot,
});

function Forgot() {
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    const email = String(new FormData(e.currentTarget).get("email"));
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` });
    setBusy(false);
    if (error) return toast.error(error.message);
    setSent(true);
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background bg-grid p-6">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-6">
        <Logo />
        {sent ? (
          <p className="text-sm text-muted-foreground">If an account exists for that email, a reset link is on its way.</p>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <h1 className="text-lg font-semibold">Forgot your password?</h1>
            <div className="space-y-1.5"><Label htmlFor="e">Email</Label><Input id="e" name="email" type="email" required /></div>
            <Button className="w-full" disabled={busy}>Send reset link</Button>
          </form>
        )}
        <Link to="/auth" className="block text-center text-sm text-primary hover:underline">Back to sign in</Link>
      </div>
    </div>
  );
}
