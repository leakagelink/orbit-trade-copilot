import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Keep screen data fresh for 30s so back-and-forth navigation is
        // instant; live trading screens still poll via their own intervals.
        staleTime: 30_000,
        gcTime: 10 * 60_000,
        refetchOnWindowFocus: false,
        retry: 1,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // Preload a route as soon as the user hovers/touches its link.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 30_000,
    defaultStaleTime: 30_000,
  });

  return router;
};
