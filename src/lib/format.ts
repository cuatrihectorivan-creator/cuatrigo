const currencyFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
})

const dateTimeFormatter = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'short',
  timeStyle: 'short',
})
const relativeTimeFormatter = new Intl.RelativeTimeFormat('es-CO', {
  numeric: 'auto',
})

export function formatCurrencyCop(value: number | null | undefined): string {
  return currencyFormatter.format(value ?? 0)
}

export function formatDateTime(value: string | null): string {
  if (!value) {
    return '-'
  }

  return dateTimeFormatter.format(new Date(value))
}

export function formatMinutes(value: number | null | undefined): string {
  return `${Math.max(0, value ?? 0)} min`
}

export function getRemainingMs(targetEndAt: string, nowMs: number): number {
  return new Date(targetEndAt).getTime() - nowMs
}

export function formatRemainingClock(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
}

export function formatTimeAgo(value: string | null, nowMs = Date.now()): string {
  if (!value) {
    return '-'
  }

  const diffSeconds = Math.round((new Date(value).getTime() - nowMs) / 1000)
  const absSeconds = Math.abs(diffSeconds)

  if (absSeconds >= 86400) {
    return relativeTimeFormatter.format(Math.round(diffSeconds / 86400), 'day')
  }
  if (absSeconds >= 3600) {
    return relativeTimeFormatter.format(Math.round(diffSeconds / 3600), 'hour')
  }
  if (absSeconds >= 60) {
    return relativeTimeFormatter.format(Math.round(diffSeconds / 60), 'minute')
  }
  return relativeTimeFormatter.format(diffSeconds, 'second')
}
