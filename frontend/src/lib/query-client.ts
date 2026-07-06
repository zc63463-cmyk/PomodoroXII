/**
 * Singleton QueryClient (F0 §6.2).
 *
 * staleTime: 60s — offline-first, avoid refetching too eagerly.
 * refetchOnWindowFocus: false — prevent sync storms on tab switch.
 */

import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnMount: false,
    },
    mutations: {
      retry: 0,
    },
  },
})
