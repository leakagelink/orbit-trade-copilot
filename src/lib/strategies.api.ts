// Client-side strategy persistence (RLS-scoped to the signed-in user).
import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { validateStrategy, type StrategyConfig } from "./strategy";

async function uid() {
  const { data } = await supabase.auth.getUser();
  if (!data.user) throw new Error("Not signed in");
  return data.user.id;
}

export async function createStrategy(name: string, config: StrategyConfig, source: "manual" | "ai" | "clone" = "manual", description?: string) {
  const user_id = await uid();
  const issues = validateStrategy(config);
  const { data, error } = await supabase.from("strategies").insert({
    user_id, name, description: description ?? null, source, config: config as unknown as Json,
    status: issues.length ? "draft" : "validated", validation_errors: issues as unknown as Json,
  }).select("id").single();
  if (error) throw new Error(error.message);
  await supabase.from("strategy_versions").insert({ strategy_id: data.id, user_id, version: 1, config: config as unknown as Json, notes: "Initial version" });
  return data.id;
}

export async function saveStrategyVersion(id: string, name: string, description: string, config: StrategyConfig, currentVersion: number, notes?: string) {
  const user_id = await uid();
  const issues = validateStrategy(config);
  const version = currentVersion + 1;
  const { error: vErr } = await supabase.from("strategy_versions").insert({ strategy_id: id, user_id, version, config: config as unknown as Json, notes: notes ?? null });
  if (vErr) throw new Error(vErr.message);
  const { error } = await supabase.from("strategies").update({
    name, description, config: config as unknown as Json, current_version: version,
    status: issues.length ? "invalid" : "validated", validation_errors: issues as unknown as Json,
  }).eq("id", id);
  if (error) throw new Error(error.message);
  return { version, issues };
}
