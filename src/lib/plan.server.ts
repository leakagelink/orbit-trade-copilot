// Server-side plan check. Uses the caller's own client so the database decides (public.has_pro_access).
import type { SupabaseClient } from "@supabase/supabase-js";
import { UPGRADE_MESSAGE } from "./plans";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function hasPro(db: SupabaseClient<any>, userId: string): Promise<boolean> {
  const { data, error } = await db.rpc("has_pro_access", { _uid: userId });
  if (error) throw new Error(error.message);
  return data === true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function requirePro(db: SupabaseClient<any>, userId: string) {
  if (!(await hasPro(db, userId))) throw new Error(UPGRADE_MESSAGE);
}
