'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchApi } from '@/lib/api-client'

interface QueryState<TData> {
  data: TData | null
  generatedAt: string | null
  isLoading: boolean
  error: string | null
}

interface ApiQueryOptions {
  enabled?: boolean
  refreshIntervalMs?: number
}

export function useApiQuery<TData>(url: string, options?: ApiQueryOptions) {
  const enabled = options?.enabled ?? true
  const refreshIntervalMs = options?.refreshIntervalMs ?? 0
  const inFlightRef = useRef(false)
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
    if (inFlightRef.current) {
      return
    }
    inFlightRef.current = true

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
    } finally {
      inFlightRef.current = false
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

  useEffect(() => {
    if (!enabled || refreshIntervalMs <= 0) {
      return
    }

    const timer = window.setInterval(() => {
      if (document.hidden) {
        return
      }
      void refresh()
    }, refreshIntervalMs)

    return () => {
      window.clearInterval(timer)
    }
  }, [enabled, refresh, refreshIntervalMs])

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
