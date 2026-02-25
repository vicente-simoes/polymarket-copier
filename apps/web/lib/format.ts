const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) {
    return '$0.00'
  }
  return CURRENCY_FORMATTER.format(value)
}

export function formatSignedCurrency(value: number): string {
  const formatted = formatCurrency(Math.abs(value))
  if (!Number.isFinite(value)) {
    return formatted
  }
  if (value > 0) {
    return `+${formatted}`
  }
  if (value < 0) {
    return `-${formatted}`
  }
  return formatted
}

export function formatNumber(value: number, maximumFractionDigits = 4): string {
  if (!Number.isFinite(value)) {
    return '0'
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits
  }).format(value)
}

export function formatPercent(value: number, maximumFractionDigits = 2): string {
  if (!Number.isFinite(value)) {
    return '0%'
  }

  return `${value.toFixed(maximumFractionDigits)}%`
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return 'n/a'
  }

  const timestamp = new Date(value)
  if (Number.isNaN(timestamp.getTime())) {
    return 'n/a'
  }

  return timestamp.toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function formatRelativeSeconds(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a'
  }

  if (value < 60) {
    return `${value}s`
  }

  if (value < 3_600) {
    const minutes = Math.floor(value / 60)
    return `${minutes}m`
  }

  const hours = Math.floor(value / 3_600)
  const remainingMinutes = Math.floor((value % 3_600) / 60)
  return `${hours}h ${remainingMinutes}m`
}

export function shortAddress(value: string | null | undefined): string {
  if (!value) {
    return 'n/a'
  }

  if (value.length <= 12) {
    return value
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`
}

export function formatLatencyMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return 'n/a'
  }
  return `${Math.trunc(value)} ms`
}
