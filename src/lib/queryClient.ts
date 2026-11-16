// The one query cache of the window: the pages read through it, and the MCP tools refresh it after a change
// (src/lib/mcp/bridge.ts), so what an agent did shows on the page that is open.

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});
