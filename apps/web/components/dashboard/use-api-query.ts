'use client'

import { useCallback, useEffect, useState } from 'react'
import { fetchApi } from '@/lib/api-client'

interface QueryState<TData> {
  data: TData | null
  generatedAt: string | null
  isLoading: boolean
  error: string | null
}

export function useApiQuery<TData>(url: string, options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true
  const [state, setState] = useState<QueryState<TData>>({
    data: null,
    generatedAt: null,
    isLoading: enabled,
    error: null
  })

  const refresh = useCallback(async () => {
    if (!enabled) {
      return
    }

    setState((previous) => ({
      ...previous,
      isLoading: true,
      error: null
    }))

    try {
      const payload = await fetchApi<TData>(url)
      setState({
        data: payload.data,
        generatedAt: payload.generatedAt,
        isLoading: false,
        error: null
      })
    } catch (error) {
      setState((previous) => ({
        ...previous,
        isLoading: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    }
  }, [enabled, url])

  useEffect(() => {
    if (!enabled) {
      setState((previous) => ({
        ...previous,
        isLoading: false
      }))
      return
    }

    void refresh()
  }, [enabled, refresh])

  return {
    ...state,
    refresh,
    setData: (updater: (value: TData | null) => TData | null) => {
      setState((previous) => ({
        ...previous,
        data: updater(previous.data)
      }))
    }
  }
}
