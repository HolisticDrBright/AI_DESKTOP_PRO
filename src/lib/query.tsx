"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

/**
 * TanStack Query provider for the desktop's CLIENT components (Item 6).
 *
 * Server components fetch through the async adapter façade directly; the two
 * client components (CommandPalette, AssistantDrawer) read through this so they
 * sit on the same async data path and are ready to flag-swap to live tRPC
 * without further plumbing. Data is mock today; the query layer is neutral to
 * where the façade sources it.
 */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
