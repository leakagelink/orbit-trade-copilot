import { createFileRoute } from "@tanstack/react-router";
import { authenticateCronRequest } from "@/integrations/supabase/cron-auth";
export const Route = createFileRoute("/api/public/alerts/tick")({server:{handlers:{POST:async({request})=>{
  const failure=await authenticateCronRequest(request); if(failure) return failure;
  const {evaluateAlerts}=await import("@/lib/alerts.server"); return Response.json(await evaluateAlerts());
}}}});