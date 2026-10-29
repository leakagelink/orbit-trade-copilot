import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// Demo wallet (virtual USD). Balance changes go through public.wallet_apply (atomic, never below zero).
export const WALLET_MAX_DEPOSIT = 1_000_000;

const amount = z.object({ amount: z.number().positive().max(WALLET_MAX_DEPOSIT) });

async function apply(userId: string, delta: number, kind: "deposit" | "withdrawal") {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.rpc("wallet_apply", {
    _user: userId, _amount: delta, _kind: kind, _position: null as unknown as string, _note: kind === "deposit" ? "Deposit (demo money)" : "Withdrawal (demo money)",
  });
  if (error) throw new Error(error.message.includes("Insufficient") ? "You can't withdraw more than your available balance" : error.message);
  return { balance: Number(data) };
}

export const walletDeposit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => amount.parse(i))
  .handler(({ data, context }) => apply(context.userId, Math.round(data.amount * 100) / 100, "deposit"));

export const walletWithdraw = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((i: unknown) => amount.parse(i))
  .handler(({ data, context }) => apply(context.userId, -Math.round(data.amount * 100) / 100, "withdrawal"));
