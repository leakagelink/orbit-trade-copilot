import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { PlanId } from "@/lib/plans";

/** Current user's plan. `pro` is decided by the database (paid plan or admin). */
export function usePlan() {
  return useQuery({
    queryKey: ["plan"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return { pro: false, elite: false, plan: "free" as PlanId, status: null as string | null, periodEnd: null as string | null };
      const [paid, advanced, subscription] = await Promise.all([
        supabase.rpc("has_pro_access", { _uid: u.user.id }),
        supabase.rpc("has_elite_access", { _uid: u.user.id }),
        supabase.from("subscriptions").select("plan,status,current_period_end").eq("user_id", u.user.id).maybeSingle(),
      ]);
      if (paid.error || advanced.error || subscription.error) throw new Error("Unable to load your plan");
      const sub = subscription.data;
      const plan: PlanId = advanced.data === true ? "elite" : paid.data === true ? "pro" : "free";
      return { pro: paid.data === true, elite: advanced.data === true, plan, status: sub?.status ?? null, periodEnd: sub?.current_period_end ?? null };
    },
    staleTime: 60_000,
  });
}
