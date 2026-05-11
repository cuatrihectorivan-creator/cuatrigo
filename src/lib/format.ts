const currencyFormatter = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
})

const dateTimeFormatter = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'short',
  timeStyle: 'short',
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
