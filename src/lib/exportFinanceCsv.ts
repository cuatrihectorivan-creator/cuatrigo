import type {
  Atv,
  BrincaSession,
  ComboFinanceSummary,
  FinanceByAtvRow,
  FinanceTotalRow,
  RideSession,
} from '../types/domain'

interface ExportFinanceCsvInput {
  monthKey: string
  monthLabel: string
  byAtv: FinanceByAtvRow[]
  total: FinanceTotalRow | null
  recentSessions: RideSession[]
  brincaTotal: FinanceTotalRow | null
  brincaRecentSessions: BrincaSession[]
  comboFinance: ComboFinanceSummary | null
  atvs: Atv[]
}

function escapeCsvValue(value: string | number | boolean | null | undefined): string {
  const raw = value == null ? '' : String(value)

  if (/[",\r\n]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`
  }

  return raw
}

function toCsv(rows: Array<Array<string | number | boolean | null | undefined>>): string {
  return rows.map((row) => row.map((cell) => escapeCsvValue(cell)).join(',')).join('\r\n')
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return ''
  }

  return new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value))
}

export function downloadFinanceCsv(input: ExportFinanceCsvInput): void {
  const { monthKey, monthLabel, byAtv, total, recentSessions, brincaTotal, brincaRecentSessions, comboFinance, atvs } = input
  const atvNameById = new Map(atvs.map((atv) => [atv.id, atv.name]))
  const generatedAt = new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(new Date())

  const rows: Array<Array<string | number | boolean | null | undefined>> = []

  rows.push(['Reporte financiero CuatriGo'])
  rows.push(['Mes', monthLabel, monthKey])
  rows.push(['Generado', generatedAt])
  rows.push([])

  rows.push(['Resumen por cuatrimoto'])
  rows.push(['Cuatrimoto', 'Sesiones', 'Minutos', 'Total COP'])
  if (byAtv.length === 0) {
    rows.push(['Sin registros', 0, 0, 0])
  } else {
    for (const row of byAtv) {
      rows.push([row.atv_name, row.session_count, row.minutes_total, row.amount_total_cop])
    }
  }

  rows.push([])
  rows.push(['Total global'])
  rows.push(['Sesiones', 'Minutos', 'Total COP'])
  rows.push([total?.session_count ?? 0, total?.minutes_total ?? 0, total?.amount_total_cop ?? 0])

  rows.push([])
  rows.push(['Resumen Brinca Brinca'])
  rows.push(['Sesiones', 'Minutos cobrados', 'Total COP'])
  rows.push([brincaTotal?.session_count ?? 0, brincaTotal?.minutes_total ?? 0, brincaTotal?.amount_total_cop ?? 0])

  rows.push([])
  rows.push(['Resumen Combos'])
  rows.push(['Combos cobrados', 'Sesiones de combo', 'Total COP'])
  rows.push([comboFinance?.combo_count ?? 0, comboFinance?.session_count ?? 0, comboFinance?.amount_total_cop ?? 0])

  rows.push([])
  rows.push(['Sesiones cerradas del mes'])
  rows.push(['Moto', 'Inicio', 'Fin', 'Minutos', 'Valor COP', 'Estado'])
  if (recentSessions.length === 0) {
    rows.push(['Sin sesiones cerradas en este mes', '', '', '', '', ''])
  } else {
    for (const session of recentSessions) {
      rows.push([
        atvNameById.get(session.atv_id) ?? session.atv_id,
        formatDateTime(session.started_at),
        formatDateTime(session.ended_at),
        session.minutes_billed ?? 0,
        session.amount_cop ?? 0,
        session.status,
      ])
    }
  }

  rows.push([])
  rows.push(['Sesiones Brinca cerradas del mes'])
  rows.push(['Nino', 'Inicio', 'Fin', 'Minutos', 'Valor COP', 'Estado'])
  if (brincaRecentSessions.length === 0) {
    rows.push(['Sin sesiones Brinca cerradas en este mes', '', '', '', '', ''])
  } else {
    for (const session of brincaRecentSessions) {
      rows.push([
        session.child_name,
        formatDateTime(session.started_at),
        formatDateTime(session.ended_at),
        session.minutes_billed ?? 0,
        session.amount_cop ?? 0,
        session.status,
      ])
    }
  }

  const csv = toCsv(rows)
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `cuatrigo_finanzas_${monthKey.replace('-', '_')}.csv`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}
