import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export function useIsAdmin() {
  return useQuery({ queryKey: ["is-admin"], staleTime: 300_000, queryFn: async () => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) return false;
    const [a, s] = await Promise.all([
      supabase.rpc("has_role", { _user_id: u.user.id, _role: "admin" }),
      supabase.rpc("has_role", { _user_id: u.user.id, _role: "super_admin" }),
    ]);
    return a.data === true || s.data === true;
  } });
}

