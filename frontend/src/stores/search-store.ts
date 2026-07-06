/**
 * Search store (F0 §7.3.15).
 *
 * S0 stub — actions are no-ops; F2+ implements real logic.
 * Zustand v5 curried form: create<T>()(devtools(...))
 */

import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface SearchResult {
  id: string
  type: 'task' | 'note' | 'quick-note'
  title: string
  snippet: string
}

interface SearchState {
  query: string
  results: SearchResult[]
  isSearching: boolean
  searchScope: 'all' | 'tasks' | 'notes' | 'quick-notes'
}

interface SearchActions {
  setQuery: (q: string) => void
  search: () => Promise<void>
  clearResults: () => void
  setScope: (scope: SearchState['searchScope']) => void
  reset: () => void
}

type SearchStore = SearchState & SearchActions

export const useSearchStore = create<SearchStore>()(
  devtools(
    (set) => ({
      query: '',
      results: [],
      isSearching: false,
      searchScope: 'all',

      setQuery: (q) => set({ query: q }),
      search: async () => { /* S0 stub */ },
      clearResults: () => set({ results: [] }),
      setScope: (scope) => set({ searchScope: scope }),
      reset: () => set({ query: '', results: [], isSearching: false, searchScope: 'all' }),
    }),
    { name: 'search-store' },
  ),
)
