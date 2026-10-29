import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/** Current user's plan. `pro` is decided by the database (paid plan or admin). */
export function usePlan() {
  return useQuery({
    queryKey: ["plan"],
    queryFn: async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return { pro: false, plan: "free", status: null as string | null, periodEnd: null as string | null };
      const [{ data: pro }, { data: sub }] = await Promise.all([
        supabase.rpc("has_pro_access", { _uid: u.user.id }),
        supabase.from("subscriptions").select("plan,status,current_period_end").eq("user_id", u.user.id).maybeSingle(),
      ]);
      return { pro: pro === true, plan: sub?.plan ?? "free", status: sub?.status ?? null, periodEnd: sub?.current_period_end ?? null };
    },
    staleTime: 60_000,
  });
}
