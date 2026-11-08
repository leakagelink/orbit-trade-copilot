import { createFileRoute } from "@tanstack/react-router";
import { handleAutopilot } from "@/lib/autopilot.server";

export const Route = createFileRoute("/api/autopilot")({
  server: { handlers: { POST: ({ request }) => handleAutopilot(request) } },
});
