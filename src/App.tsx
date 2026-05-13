import type { FormEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import {
  cancelBrincaSession,
  cancelCombo,
  cancelSession,
  computeComboFinance,
  computeBrincaFinance,
  computeFinance,
  createCombo,
  createAtv,
  deleteAtv,
  extendBrincaSession,
  extendSession,
  fetchAtvs,
  fetchBrincaSettings,
  fetchClosedBrincaSessionsByRange,
  fetchClosedSessionsByRange,
  fetchCombos,
  fetchCompletedBrincaSessionsByRange,
  fetchOpenBrincaSessions,
  fetchCompletedSessionsByRange,
  fetchMyProfile,
  fetchOpenSessions,
  fetchRecentSessions,
  pauseBrincaSession,
  pauseSession,
  refreshExpiredBrincaSessions,
  refreshExpiredSessions,
  resetFinanceData,
  resumeBrincaSession,
  restartSession,
  resumeSession,
  setBrincaPayment,
  setSessionPayment,
  startComboBrincaLeg,
  startComboMotoLeg,
  startBrincaSession,
  stopBrincaSession,
  startSession,
  stopSession,
  toggleAtvActive,
  updateBrincaSettings,
  updateAtvRates,
} from './services/api'
import {
  formatCurrencyCop,
  formatDateTime,
  formatMinutes,
  formatRemainingClock,
  formatTimeAgo,
  getRemainingMs,
} from './lib/format'
import { downloadFinanceCsv } from './lib/exportFinanceCsv'
import { supabase } from './lib/supabase'
import type {
  Atv,
  BrincaSession,
  BrincaSettings,
  Combo,
  ComboFinanceSummary,
  ComboStartMode,
  FinanceByAtvRow,
  FinanceTotalRow,
  PaymentMethod,
  PaymentStatus,
  Profile,
  RideSession,
  SessionStatus,
} from './types/domain'

const BOGOTA_UTC_OFFSET = '-05:00'

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function toBogotaDateKey(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)

  const year = Number(parts.find((part) => part.type === 'year')?.value ?? '0')
  const month = Number(parts.find((part) => part.type === 'month')?.value ?? '1')
  const day = Number(parts.find((part) => part.type === 'day')?.value ?? '1')
  return `${year}-${pad2(month)}-${pad2(day)}`
}

function toBogotaMonthKey(date: Date): string {
  const dayKey = toBogotaDateKey(date)
  return dayKey.slice(0, 7)
}

function parseDayKey(dayKey: string): { year: number; month: number; day: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    return null
  }

  const [yearStr, monthStr, dayStr] = dayKey.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const day = Number(dayStr)

  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null
  }

  return { year, month, day }
}

function dayRangeFromKey(dayKey: string): { startIso: string; endIso: string } {
  const parsed = parseDayKey(dayKey)
  const fallbackKey = toBogotaDateKey(new Date())
  const safeParsed = parsed ?? parseDayKey(fallbackKey)

  if (!safeParsed) {
    const now = new Date()
    const start = now.toISOString()
    return { startIso: start, endIso: start }
  }

  const start = new Date(
    `${safeParsed.year}-${pad2(safeParsed.month)}-${pad2(safeParsed.day)}T00:00:00${BOGOTA_UTC_OFFSET}`,
  )
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

function monthRangeFromKey(monthKey: string): { startIso: string; endIso: string } {
  const [yearStr, monthStr] = monthKey.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    const now = new Date()
    const fallback = toBogotaMonthKey(now)
    return monthRangeFromKey(fallback)
  }

  const nextMonthYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1

  // Rango mensual alineado a America/Bogota (UTC-5) para que cierre contable coincida con la operacion local.
  const start = new Date(`${yearStr}-${monthStr.padStart(2, '0')}-01T00:00:00${BOGOTA_UTC_OFFSET}`)
  const end = new Date(
    `${String(nextMonthYear)}-${String(nextMonth).padStart(2, '0')}-01T00:00:00${BOGOTA_UTC_OFFSET}`,
  )

  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

function monthLabelFromKey(monthKey: string): string {
  const [yearStr, monthStr] = monthKey.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const date = new Date(Date.UTC(year, month - 1, 1))

  return new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(date)
}

function dayLabelFromKey(dayKey: string): string {
  const parsed = parseDayKey(dayKey)
  if (!parsed) {
    return dayKey
  }
  const dayDate = new Date(
    `${parsed.year}-${pad2(parsed.month)}-${pad2(parsed.day)}T00:00:00${BOGOTA_UTC_OFFSET}`,
  )
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'long' }).format(dayDate)
}

function shiftMonthKey(monthKey: string, deltaMonths: number): string {
  const [yearStr, monthStr] = monthKey.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return toBogotaMonthKey(new Date())
  }
  const base = new Date(Date.UTC(year, month - 1, 1))
  base.setUTCMonth(base.getUTCMonth() + deltaMonths)
  const shiftedYear = base.getUTCFullYear()
  const shiftedMonth = base.getUTCMonth() + 1
  return `${shiftedYear}-${pad2(shiftedMonth)}`
}

type FinanceRangeMode = 'today' | 'day' | 'month' | 'range'

type Tab = 'operations' | 'brinca' | 'combos' | 'atvs' | 'finance'
type ToastType = 'error' | 'success'
const RECENT_FINISH_SIGNAL_MS = 15 * 60 * 1000
const COMBO_HISTORY_VISIBILITY_MS = 5 * 60 * 1000

interface ToastState {
  type: ToastType
  message: string
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(error.message)
  }

  return 'Ocurrio un error inesperado.'
}

function shortTransactionId(id: string): string {
  const firstBlock = id.split('-')[0]
  return firstBlock.toUpperCase()
}

function paymentStatusLabel(status: PaymentStatus): string {
  return status === 'paid' ? 'Pagado' : 'Pendiente'
}

function paymentMethodLabel(method: PaymentMethod): string {
  if (method === 'cash') {
    return 'Efectivo'
  }
  if (method === 'nequi') {
    return 'Nequi'
  }
  return '-'
}

function closedStatusLabel(status: SessionStatus): string {
  if (status === 'cancelled') {
    return 'Anulada'
  }
  if (status === 'completed') {
    return 'Completada'
  }
  if (status === 'paused') {
    return 'Pausada'
  }
  return 'Activa'
}

async function maybeNotifyExpiry(message: string): Promise<void> {
  if (!('Notification' in window)) {
    return
  }

  if (Notification.permission === 'granted') {
    new Notification('Tiempo finalizado', {
      body: message,
    })
    return
  }

  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission()
    if (permission === 'granted') {
      new Notification('Tiempo finalizado', {
        body: message,
      })
    }
  }
}

let expiryAudioContext: AudioContext | null = null

function getAudioContextCtor(): typeof AudioContext | undefined {
  const webkitWindow = window as Window & { webkitAudioContext?: typeof AudioContext }
  return window.AudioContext ?? webkitWindow.webkitAudioContext
}

async function armExpirySound(): Promise<boolean> {
  const AudioContextCtor = getAudioContextCtor()
  if (!AudioContextCtor) {
    return false
  }

  if (!expiryAudioContext) {
    expiryAudioContext = new AudioContextCtor()
  }

  const context = expiryAudioContext
  if (context.state === 'suspended') {
    await context.resume()
  }

  // Pulso silencioso para terminar de desbloquear audio en navegadores moviles.
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  gain.gain.setValueAtTime(0.0001, context.currentTime)
  oscillator.connect(gain)
  gain.connect(context.destination)
  oscillator.start(context.currentTime)
  oscillator.stop(context.currentTime + 0.03)

  return context.state === 'running'
}

function triggerExpiryVibration(): boolean {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
    return false
  }

  try {
    return navigator.vibrate([220, 110, 220, 110, 420])
  } catch {
    return false
  }
}

async function playExpirySound(): Promise<void> {
  const AudioContextCtor = getAudioContextCtor()
  if (!AudioContextCtor) {
    return
  }

  if (!expiryAudioContext) {
    expiryAudioContext = new AudioContextCtor()
  }

  const context = expiryAudioContext
  if (context.state === 'suspended') {
    await context.resume()
  }

  const now = context.currentTime
  const scheduleTone = (frequency: number, offsetSeconds: number, durationSeconds: number): void => {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'triangle'
    oscillator.frequency.setValueAtTime(frequency, now + offsetSeconds)

    gain.gain.setValueAtTime(0.0001, now + offsetSeconds)
    gain.gain.exponentialRampToValueAtTime(0.28, now + offsetSeconds + 0.03)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offsetSeconds + durationSeconds)

    oscillator.connect(gain)
    gain.connect(context.destination)

    oscillator.start(now + offsetSeconds)
    oscillator.stop(now + offsetSeconds + durationSeconds + 0.02)
  }

  for (let repetition = 0; repetition < 4; repetition += 1) {
    const offset = repetition * 0.72
    scheduleTone(860, offset, 0.24)
    scheduleTone(620, offset + 0.3, 0.28)
  }
}

function LoginPanel(props: {
  pending: boolean
  error: string | null
  onSignIn: (email: string, password: string) => Promise<void>
  onSignUp: (email: string, password: string) => Promise<void>
}): ReactElement {
  const { pending, error, onSignIn, onSignUp } = props
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    await onSignIn(email, password)
  }

  async function handleSignUp(): Promise<void> {
    await onSignUp(email, password)
  }

  return (
    <main className="auth-layout">
      <section className="auth-card">
        <div className="auth-brand">
          <span className="brand-mark" aria-hidden="true">
            <img src="/atv-kid-blue.png" alt="" className="brand-mark-img" loading="lazy" />
          </span>
          <div>
            <h1>CuatriGo</h1>
            <p className="muted">Control de tiempos, cobros y finanzas para cuatrimotos.</p>
          </div>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            Correo
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="admin@empresa.com"
              required
            />
          </label>

          <label>
            Contrasena
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Minimo 6 caracteres"
              minLength={6}
              required
            />
          </label>

          {error ? <p className="error-text">{error}</p> : null}

          <div className="button-row">
            <button type="submit" disabled={pending}>
              {pending ? 'Ingresando...' : 'Ingresar'}
            </button>
            <button type="button" className="secondary" disabled={pending} onClick={handleSignUp}>
              {pending ? 'Creando...' : 'Crear usuario'}
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}

function App(): ReactElement {
  const [authReady, setAuthReady] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)

  const [tab, setTab] = useState<Tab>('operations')
  const [loading, setLoading] = useState(false)
  const [authPending, setAuthPending] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [soundArmed, setSoundArmed] = useState(false)
  const [soundActivating, setSoundActivating] = useState(false)

  const [atvs, setAtvs] = useState<Atv[]>([])
  const [openSessions, setOpenSessions] = useState<RideSession[]>([])
  const [lastClosedSessionByAtv, setLastClosedSessionByAtv] = useState<Record<string, RideSession>>({})
  const [brincaSettings, setBrincaSettings] = useState<BrincaSettings | null>(null)
  const [brincaOpenSessions, setBrincaOpenSessions] = useState<BrincaSession[]>([])
  const [brincaRecentSessions, setBrincaRecentSessions] = useState<BrincaSession[]>([])
  const [brincaFinanceTotal, setBrincaFinanceTotal] = useState<FinanceTotalRow | null>(null)
  const [comboFinanceTotal, setComboFinanceTotal] = useState<ComboFinanceSummary | null>(null)
  const [combos, setCombos] = useState<Combo[]>([])
  const [recentSessions, setRecentSessions] = useState<RideSession[]>([])
  const [financeByAtv, setFinanceByAtv] = useState<FinanceByAtvRow[]>([])
  const [financeTotal, setFinanceTotal] = useState<FinanceTotalRow | null>(null)
  const [financeRangeMode, setFinanceRangeMode] = useState<FinanceRangeMode>('today')
  const [selectedDay, setSelectedDay] = useState(() => toBogotaDateKey(new Date()))
  const [selectedMonth, setSelectedMonth] = useState(() => toBogotaMonthKey(new Date()))
  const [rangeStartDay, setRangeStartDay] = useState(() => {
    const today = new Date()
    const start = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000)
    return toBogotaDateKey(start)
  })
  const [rangeEndDay, setRangeEndDay] = useState(() => toBogotaDateKey(new Date()))
  const [rangeMonthsBack, setRangeMonthsBack] = useState(1)

  const [tickMs, setTickMs] = useState(() => Date.now())
  const notifiedExpiryRef = useRef<Set<string>>(new Set())
  const notifiedBrincaExpiryRef = useRef<Set<string>>(new Set())
  const autoClosingRef = useRef<Set<string>>(new Set())
  const autoClosingBrincaRef = useRef<Set<string>>(new Set())
  const warnedSoundRef = useRef(false)

  const userId = user?.id ?? null
  const isAdmin = profile?.role === 'admin'

  const openSessionByAtv = useMemo(() => {
    return new Map(openSessions.map((session) => [session.atv_id, session]))
  }, [openSessions])
  const openMotoSessionById = useMemo(() => {
    return new Map(openSessions.map((session) => [session.id, session]))
  }, [openSessions])
  const openBrincaSessionById = useMemo(() => {
    return new Map(brincaOpenSessions.map((session) => [session.id, session]))
  }, [brincaOpenSessions])
  const comboMotoSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const combo of combos) {
      if (combo.status === 'cancelled' || !combo.moto_session_id) {
        continue
      }
      ids.add(combo.moto_session_id)
    }
    return ids
  }, [combos])
  const comboBrincaSessionIds = useMemo(() => {
    const ids = new Set<string>()
    for (const combo of combos) {
      if (combo.status === 'cancelled' || !combo.brinca_session_id) {
        continue
      }
      ids.add(combo.brinca_session_id)
    }
    return ids
  }, [combos])

  const activeAtvCount = openSessions.filter((session) => session.status === 'active').length
  const activeBrincaCount = brincaOpenSessions.filter((session) => session.status === 'active').length
  const inactiveAtvCount = atvs.filter((atv) => !atv.active).length
  const financeRange = useMemo(() => {
    const todayKey = toBogotaDateKey(new Date())

    if (financeRangeMode === 'today') {
      const { startIso, endIso } = dayRangeFromKey(todayKey)
      return {
        startIso,
        endIso,
        label: `Hoy (${dayLabelFromKey(todayKey)})`,
        fileSuffix: todayKey,
      }
    }

    if (financeRangeMode === 'day') {
      const key = parseDayKey(selectedDay) ? selectedDay : todayKey
      const { startIso, endIso } = dayRangeFromKey(key)
      return {
        startIso,
        endIso,
        label: dayLabelFromKey(key),
        fileSuffix: key,
      }
    }

    if (financeRangeMode === 'month') {
      const key = /^\d{4}-\d{2}$/.test(selectedMonth) ? selectedMonth : toBogotaMonthKey(new Date())
      const { startIso, endIso } = monthRangeFromKey(key)
      return {
        startIso,
        endIso,
        label: monthLabelFromKey(key),
        fileSuffix: key,
      }
    }

    const validStart = parseDayKey(rangeStartDay) ? rangeStartDay : todayKey
    const validEnd = parseDayKey(rangeEndDay) ? rangeEndDay : todayKey
    const orderedStart = validStart <= validEnd ? validStart : validEnd
    const orderedEnd = validStart <= validEnd ? validEnd : validStart
    const start = dayRangeFromKey(orderedStart)
    const end = dayRangeFromKey(orderedEnd)
    return {
      startIso: start.startIso,
      endIso: end.endIso,
      label: `${dayLabelFromKey(orderedStart)} - ${dayLabelFromKey(orderedEnd)}`,
      fileSuffix: `${orderedStart}_${orderedEnd}`,
    }
  }, [financeRangeMode, rangeEndDay, rangeStartDay, selectedDay, selectedMonth])
  const vibrationSupported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function'

  const notify = useCallback((type: ToastType, message: string) => {
    setToast({ type, message })
  }, [])

  const triggerAlarmFeedback = useCallback(() => {
    const vibrated = triggerExpiryVibration()

    if (!soundArmed) {
      if (!warnedSoundRef.current) {
        warnedSoundRef.current = true
        window.setTimeout(() => {
          notify(
            'error',
            vibrated
              ? 'Sonido no activado. Pulsa "Activar sonido" para alerta completa.'
              : 'Sonido no activado y vibracion no disponible. Pulsa "Activar sonido".',
          )
        }, 0)
      }
      return
    }

    void playExpirySound().catch(() => {
      if (!warnedSoundRef.current) {
        warnedSoundRef.current = true
        window.setTimeout(() => {
          notify('error', 'No se pudo reproducir el sonido de alerta en este navegador.')
        }, 0)
      }
    })
  }, [notify, soundArmed])

  const clearDashboardState = useCallback(() => {
    setProfile(null)
    setAtvs([])
    setOpenSessions([])
    setLastClosedSessionByAtv({})
    setBrincaSettings(null)
    setBrincaOpenSessions([])
    setBrincaRecentSessions([])
    setBrincaFinanceTotal(null)
    setComboFinanceTotal(null)
    setCombos([])
    setRecentSessions([])
    setFinanceByAtv([])
    setFinanceTotal(null)
  }, [])

  const loadData = useCallback(async () => {
    if (!userId) {
      return
    }

    setLoading(true)

    try {
      const [
        nextProfile,
        nextAtvs,
        nextOpenSessions,
        completedSessions,
        closedSessionsByRange,
        closedSessionsRecent,
        nextBrincaSettings,
        nextBrincaOpenSessions,
        nextBrincaCompletedSessions,
        nextBrincaClosedSessions,
        nextCombos,
      ] =
        await Promise.all([
          fetchMyProfile(userId),
          fetchAtvs(),
          fetchOpenSessions(),
          fetchCompletedSessionsByRange(financeRange.startIso, financeRange.endIso),
          fetchClosedSessionsByRange(financeRange.startIso, financeRange.endIso),
          fetchRecentSessions(200),
          fetchBrincaSettings(),
          fetchOpenBrincaSessions(),
          fetchCompletedBrincaSessionsByRange(financeRange.startIso, financeRange.endIso),
          fetchClosedBrincaSessionsByRange(financeRange.startIso, financeRange.endIso),
          fetchCombos(500),
        ])

      const { byAtv, total } = computeFinance(nextAtvs, completedSessions)
      const brincaTotal = computeBrincaFinance(nextBrincaCompletedSessions)
      const comboTotal = computeComboFinance(nextCombos, completedSessions, nextBrincaCompletedSessions)
      const nextLastClosedByAtv: Record<string, RideSession> = {}
      for (const session of closedSessionsRecent) {
        if (session.status !== 'completed') {
          continue
        }
        if (!session.ended_at) {
          continue
        }
        if (!nextLastClosedByAtv[session.atv_id]) {
          nextLastClosedByAtv[session.atv_id] = session
        }
      }

      setProfile(nextProfile)
      setAtvs(nextAtvs)
      setOpenSessions(nextOpenSessions)
      setLastClosedSessionByAtv(nextLastClosedByAtv)
      setBrincaSettings(nextBrincaSettings)
      setBrincaOpenSessions(nextBrincaOpenSessions)
      setBrincaRecentSessions(nextBrincaClosedSessions.slice(0, 120))
      setBrincaFinanceTotal(brincaTotal)
      setComboFinanceTotal(comboTotal)
      setCombos(nextCombos)
      setRecentSessions(closedSessionsByRange.slice(0, 120))
      setFinanceByAtv(byAtv)
      setFinanceTotal(total)
    } catch (error) {
      notify('error', getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [financeRange.endIso, financeRange.startIso, notify, userId])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setToast(null)
    }, toast?.type === 'error' ? 7000 : 3000)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [toast])

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null)
      if (!data.session?.user) {
        clearDashboardState()
      }
      setAuthReady(true)
    })

    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null)
      if (!session?.user) {
        clearDashboardState()
      }
      setAuthReady(true)
    })

    return () => {
      data.subscription.unsubscribe()
    }
  }, [clearDashboardState])

  useEffect(() => {
    if (userId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void loadData()
    }
  }, [loadData, userId])

  useEffect(() => {
    if (!userId) {
      return
    }

    const channel = supabase
      .channel(`cuatrigo-live-${userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, () => {
        void loadData()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'atvs' }, () => {
        void loadData()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, () => {
        void loadData()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brinca_sessions' }, () => {
        void loadData()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brinca_settings' }, () => {
        void loadData()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'combos' }, () => {
        void loadData()
      })
      .subscribe()

    const interval = window.setInterval(() => {
      setTickMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(interval)
      void supabase.removeChannel(channel)
    }
  }, [loadData, userId])

  useEffect(() => {
    const justExpiredAtvNames: string[] = []

    for (const session of openSessions) {
      if (session.status !== 'active') {
        continue
      }
      const remainingMs = getRemainingMs(session.target_end_at, tickMs)
      if (remainingMs > 0 || notifiedExpiryRef.current.has(session.id)) {
        continue
      }

      const atvName = atvs.find((atv) => atv.id === session.atv_id)?.name ?? 'cuatrimoto'
      notifiedExpiryRef.current.add(session.id)
      justExpiredAtvNames.push(atvName)
      void maybeNotifyExpiry(`La cuatrimoto ${atvName} ya supero su tiempo de uso.`)
    }

    if (justExpiredAtvNames.length > 0) {
      const label =
        justExpiredAtvNames.length === 1
          ? `Tiempo finalizado: ${justExpiredAtvNames[0]}.`
          : `Tiempo finalizado en ${justExpiredAtvNames.length} cuatrimotos.`
      window.setTimeout(() => {
        notify('error', label)
      }, 0)
      triggerAlarmFeedback()
    }
  }, [openSessions, atvs, tickMs, notify, triggerAlarmFeedback])

  useEffect(() => {
    const justExpiredKids: string[] = []

    for (const session of brincaOpenSessions) {
      if (session.status !== 'active') {
        continue
      }
      const remainingMs = getRemainingMs(session.target_end_at, tickMs)
      if (remainingMs > 0 || notifiedBrincaExpiryRef.current.has(session.id)) {
        continue
      }

      notifiedBrincaExpiryRef.current.add(session.id)
      justExpiredKids.push(session.child_name)
      void maybeNotifyExpiry(`La sesion de ${session.child_name} en Brinca finalizo.`)
    }

    if (justExpiredKids.length > 0) {
      const label =
        justExpiredKids.length === 1
          ? `Brinca finalizado: ${justExpiredKids[0]}.`
          : `Brinca finalizado en ${justExpiredKids.length} sesiones de ninos.`
      window.setTimeout(() => {
        notify('error', label)
      }, 0)
      triggerAlarmFeedback()
    }
  }, [brincaOpenSessions, tickMs, notify, triggerAlarmFeedback])

  useEffect(() => {
    const sessionsToClose = openSessions.filter(
      (session) =>
        session.status === 'active' &&
        getRemainingMs(session.target_end_at, tickMs) <= 0 &&
        !autoClosingRef.current.has(session.id),
    )

    if (sessionsToClose.length === 0) {
      return
    }

    for (const session of sessionsToClose) {
      autoClosingRef.current.add(session.id)
    }

    void (async () => {
      try {
        await refreshExpiredSessions()
        await loadData()
      } catch (error) {
        notify('error', `No se pudo cerrar una sesion vencida automaticamente: ${getErrorMessage(error)}`)
      } finally {
        for (const session of sessionsToClose) {
          autoClosingRef.current.delete(session.id)
        }
      }
    })()
  }, [loadData, notify, openSessions, tickMs])

  useEffect(() => {
    const sessionsToClose = brincaOpenSessions.filter(
      (session) =>
        session.status === 'active' &&
        getRemainingMs(session.target_end_at, tickMs) <= 0 &&
        !autoClosingBrincaRef.current.has(session.id),
    )

    if (sessionsToClose.length === 0) {
      return
    }

    for (const session of sessionsToClose) {
      autoClosingBrincaRef.current.add(session.id)
    }

    void (async () => {
      try {
        await refreshExpiredBrincaSessions()
        await loadData()
      } catch (error) {
        notify('error', `No se pudo cerrar una sesion de Brinca vencida automaticamente: ${getErrorMessage(error)}`)
      } finally {
        for (const session of sessionsToClose) {
          autoClosingBrincaRef.current.delete(session.id)
        }
      }
    })()
  }, [brincaOpenSessions, loadData, notify, tickMs])

  const handleSignIn = useCallback(async (email: string, password: string) => {
    setAuthPending(true)
    setAuthError(null)

    const { error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setAuthError(error.message)
      setAuthPending(false)
      return
    }

    notify('success', 'Sesion iniciada')
    setAuthPending(false)
  }, [notify])

  const handleSignUp = useCallback(async (email: string, password: string) => {
    setAuthPending(true)
    setAuthError(null)

    const { error } = await supabase.auth.signUp({ email, password })

    if (error) {
      setAuthError(error.message)
      setAuthPending(false)
      return
    }

    notify('success', 'Usuario creado. Si aplica, confirma el correo para ingresar.')
    setAuthPending(false)
  }, [notify])

  const handleLogout = useCallback(async () => {
    const { error } = await supabase.auth.signOut()
    if (error) {
      notify('error', error.message)
      return
    }

    notify('success', 'Sesion finalizada')
  }, [notify])

  const handleActivateSound = useCallback(async () => {
    setSoundActivating(true)
    try {
      const ready = await armExpirySound()
      if (!ready) {
        notify('error', 'No se pudo activar el sonido en este navegador.')
        return
      }

      setSoundArmed(true)
      warnedSoundRef.current = false
      notify(
        'success',
        vibrationSupported
          ? 'Sonido activado. Vibracion lista como respaldo.'
          : 'Sonido activado. Vibracion no disponible en este dispositivo.',
      )
    } catch {
      notify('error', 'No se pudo activar el sonido en este navegador.')
    } finally {
      setSoundActivating(false)
    }
  }, [notify, vibrationSupported])

  const handleAddAtv = useCallback(
    async (input: { name: string; colorHex?: string; baseMinutes: number; basePriceCop: number }) => {
      await createAtv(input)
      notify('success', 'Cuatrimoto creada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleUpdateRates = useCallback(
    async (atvId: string, input: { baseMinutes: number; basePriceCop: number; colorHex?: string }) => {
      await updateAtvRates(atvId, input)
      notify('success', 'Tarifa actualizada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleToggleActive = useCallback(
    async (atvId: string, active: boolean) => {
      await toggleAtvActive(atvId, active)
      notify('success', active ? 'Cuatrimoto habilitada' : 'Cuatrimoto deshabilitada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleDeleteAtv = useCallback(
    async (atvId: string) => {
      await deleteAtv(atvId)
      notify('success', 'Cuatrimoto eliminada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleStartSession = useCallback(
    async (atvId: string, durationMinutes: number) => {
      const sessionId = await startSession(atvId, durationMinutes)
      notify('success', 'Tiempo iniciado')
      await loadData()
      return sessionId
    },
    [loadData, notify],
  )

  const handleStopSession = useCallback(
    async (sessionId: string) => {
      await stopSession(sessionId)
      notify('success', 'Sesion cerrada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleSetSessionPayment = useCallback(
    async (sessionId: string, paymentStatus: PaymentStatus, paymentMethod: PaymentMethod) => {
      await setSessionPayment(sessionId, paymentStatus, paymentMethod)
      notify('success', 'Pago de moto actualizado')
      await loadData()
    },
    [loadData, notify],
  )

  const handleCancelSession = useCallback(
    async (sessionId: string, annulKey: string) => {
      await cancelSession(sessionId, annulKey)
      notify('success', 'Sesion anulada')
      await loadData()
    },
    [loadData, notify],
  )

  const handlePauseSession = useCallback(
    async (sessionId: string) => {
      await pauseSession(sessionId)
      notify('success', 'Sesion pausada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleResumeSession = useCallback(
    async (sessionId: string) => {
      await resumeSession(sessionId)
      notify('success', 'Sesion reanudada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleRestartSession = useCallback(
    async (sessionId: string, durationMinutes: number) => {
      await restartSession(sessionId, durationMinutes)
      notify('success', 'Tiempo reiniciado')
      await loadData()
    },
    [loadData, notify],
  )

  const handleExtendSession = useCallback(
    async (sessionId: string, extraMinutes: number) => {
      await extendSession(sessionId, extraMinutes)
      notify('success', 'Tiempo extendido')
      await loadData()
    },
    [loadData, notify],
  )

  const handleUpdateBrincaSettings = useCallback(
    async (baseMinutes: number, basePriceCop: number) => {
      await updateBrincaSettings({ baseMinutes, basePriceCop })
      notify('success', 'Tarifa de Brinca actualizada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleStartBrincaSession = useCallback(
    async (childName: string, durationMinutes: number) => {
      const sessionId = await startBrincaSession({ childName, durationMinutes })
      notify('success', 'Sesion de Brinca iniciada')
      await loadData()
      return sessionId
    },
    [loadData, notify],
  )

  const handlePauseBrincaSession = useCallback(
    async (sessionId: string) => {
      await pauseBrincaSession(sessionId)
      notify('success', 'Sesion de Brinca pausada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleResumeBrincaSession = useCallback(
    async (sessionId: string) => {
      await resumeBrincaSession(sessionId)
      notify('success', 'Sesion de Brinca reanudada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleExtendBrincaSession = useCallback(
    async (sessionId: string, extraMinutes: number) => {
      await extendBrincaSession(sessionId, extraMinutes)
      notify('success', 'Tiempo de Brinca extendido')
      await loadData()
    },
    [loadData, notify],
  )

  const handleStopBrincaSession = useCallback(
    async (sessionId: string) => {
      await stopBrincaSession(sessionId)
      notify('success', 'Sesion de Brinca cerrada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleSetBrincaPayment = useCallback(
    async (sessionId: string, paymentStatus: PaymentStatus, paymentMethod: PaymentMethod) => {
      await setBrincaPayment(sessionId, paymentStatus, paymentMethod)
      notify('success', 'Pago de Brinca actualizado')
      await loadData()
    },
    [loadData, notify],
  )

  const handleCancelBrincaSession = useCallback(
    async (sessionId: string, annulKey: string) => {
      await cancelBrincaSession(sessionId, annulKey)
      notify('success', 'Sesion de Brinca anulada')
      await loadData()
    },
    [loadData, notify],
  )

  const handleCreateCombo = useCallback(
    async (input: {
      childName: string
      startMode: ComboStartMode
      motoDurationMinutes: number
      brincaDurationMinutes: number
      atvId?: string | null
    }) => {
      await createCombo(input)
      notify('success', 'Combo creado')
      await loadData()
    },
    [loadData, notify],
  )

  const handleStartComboMotoLeg = useCallback(
    async (comboId: string, atvId?: string | null) => {
      await startComboMotoLeg(comboId, atvId)
      notify('success', 'Sesion de moto iniciada para el combo')
      await loadData()
    },
    [loadData, notify],
  )

  const handleStartComboBrincaLeg = useCallback(
    async (comboId: string) => {
      await startComboBrincaLeg(comboId)
      notify('success', 'Sesion de Brinca iniciada para el combo')
      await loadData()
    },
    [loadData, notify],
  )

  const handleCancelCombo = useCallback(
    async (comboId: string, annulKey: string) => {
      await cancelCombo(comboId, annulKey)
      notify('success', 'Combo cancelado')
      await loadData()
    },
    [loadData, notify],
  )

  const handleResetFinance = useCallback(async () => {
    const deleted = await resetFinanceData()
    notify('success', `Finanzas reiniciadas. Registros historicos eliminados: ${deleted}`)
    await loadData()
  }, [loadData, notify])

  const handleApplyLastMonthsRange = useCallback(() => {
    const months = Number.isFinite(rangeMonthsBack) ? Math.floor(rangeMonthsBack) : 1
    const safeMonths = Math.min(24, Math.max(1, months))
    const todayKey = toBogotaDateKey(new Date())
    const currentMonthKey = todayKey.slice(0, 7)
    const startMonthKey = shiftMonthKey(currentMonthKey, -(safeMonths - 1))
    setRangeStartDay(`${startMonthKey}-01`)
    setRangeEndDay(todayKey)
    setFinanceRangeMode('range')
  }, [rangeMonthsBack])

  const handleExportFinanceCsv = useCallback(() => {
    downloadFinanceCsv({
      periodKey: financeRange.fileSuffix,
      periodLabel: financeRange.label,
      byAtv: financeByAtv,
      total: financeTotal,
      recentSessions,
      brincaTotal: brincaFinanceTotal,
      brincaRecentSessions,
      comboFinance: comboFinanceTotal,
      atvs,
    })
    notify('success', `Reporte CSV descargado (${financeRange.label}).`)
  }, [
    atvs,
    brincaFinanceTotal,
    brincaRecentSessions,
    comboFinanceTotal,
    financeRange.fileSuffix,
    financeRange.label,
    financeByAtv,
    financeTotal,
    notify,
    recentSessions,
  ])

  if (!authReady) {
    return (
      <main className="splash">
        <p>Cargando autenticacion...</p>
      </main>
    )
  }

  if (!userId || !user) {
    return <LoginPanel pending={authPending} error={authError} onSignIn={handleSignIn} onSignUp={handleSignUp} />
  }

  return (
    <main className="app-layout">
      <header className="topbar">
        <div>
          <p className="brand">CuatriGo</p>
          <h1>Operacion diaria</h1>
          <p className="muted">
            Usuario: {user.email ?? user.id} | Rol: {profile?.role ?? 'cargando...'}
          </p>
        </div>

        <div className="topbar-actions">
          <button
            type="button"
            className={`secondary ${soundArmed ? 'is-armed' : ''}`}
            onClick={() => void handleActivateSound()}
            disabled={soundActivating}
          >
            {soundActivating ? 'Activando sonido...' : soundArmed ? 'Sonido activado' : 'Activar sonido'}
          </button>
          <button type="button" className="secondary" onClick={() => void loadData()} disabled={loading}>
            {loading ? 'Actualizando...' : 'Actualizar'}
          </button>
          <button type="button" className="danger" onClick={() => void handleLogout()}>
            Salir
          </button>
        </div>
      </header>

      <section className="summary-grid">
        <article className="summary-card">
          <span>Motos registradas</span>
          <strong>{atvs.length}</strong>
        </article>
        <article className="summary-card">
          <span>Sesiones activas</span>
          <strong>{activeAtvCount}</strong>
        </article>
        <article className="summary-card">
          <span>Brinca activas</span>
          <strong>{activeBrincaCount}</strong>
        </article>
        <article className="summary-card">
          <span>Motos inactivas</span>
          <strong>{inactiveAtvCount}</strong>
        </article>
        <article className="summary-card">
          <span>Total del mes</span>
          <strong>
            {formatCurrencyCop((financeTotal?.amount_total_cop ?? 0) + (brincaFinanceTotal?.amount_total_cop ?? 0))}
          </strong>
        </article>
      </section>

      <nav className="tabs" aria-label="Secciones de trabajo">
        <button type="button" className={tab === 'operations' ? 'active' : ''} onClick={() => setTab('operations')}>
          Operacion
        </button>
        <button type="button" className={tab === 'brinca' ? 'active' : ''} onClick={() => setTab('brinca')}>
          Brinca
        </button>
        <button type="button" className={tab === 'combos' ? 'active' : ''} onClick={() => setTab('combos')}>
          Combos
        </button>
        <button type="button" className={tab === 'atvs' ? 'active' : ''} onClick={() => setTab('atvs')}>
          Cuatrimotos
        </button>
        <button type="button" className={tab === 'finance' ? 'active' : ''} onClick={() => setTab('finance')}>
          Finanzas
        </button>
      </nav>

      {tab === 'operations' ? (
        <OperationsTab
          atvs={atvs}
          lastClosedSessionByAtv={lastClosedSessionByAtv}
          openSessionByAtv={openSessionByAtv}
          comboMotoSessionIds={comboMotoSessionIds}
          tickMs={tickMs}
          onStartSession={handleStartSession}
          onStopSession={handleStopSession}
          onPauseSession={handlePauseSession}
          onResumeSession={handleResumeSession}
          onRestartSession={handleRestartSession}
          onExtendSession={handleExtendSession}
          onCancelSession={handleCancelSession}
          onSetSessionPayment={handleSetSessionPayment}
          onError={(message) => notify('error', message)}
        />
      ) : null}

      {tab === 'brinca' ? (
        <BrincaTab
          canEdit={isAdmin}
          settings={brincaSettings}
          openSessions={brincaOpenSessions}
          comboBrincaSessionIds={comboBrincaSessionIds}
          tickMs={tickMs}
          onUpdateSettings={handleUpdateBrincaSettings}
          onStartSession={handleStartBrincaSession}
          onPauseSession={handlePauseBrincaSession}
          onResumeSession={handleResumeBrincaSession}
          onExtendSession={handleExtendBrincaSession}
          onStopSession={handleStopBrincaSession}
          onCancelSession={handleCancelBrincaSession}
          onSetSessionPayment={handleSetBrincaPayment}
          onError={(message) => notify('error', message)}
        />
      ) : null}

      {tab === 'atvs' ? (
        <AtvAdminTab
          atvs={atvs}
          canEdit={isAdmin}
          onAddAtv={handleAddAtv}
          onUpdateRates={handleUpdateRates}
          onToggleActive={handleToggleActive}
          onDeleteAtv={handleDeleteAtv}
          onError={(message) => notify('error', message)}
        />
      ) : null}

      {tab === 'combos' ? (
        <CombosTab
          combos={combos}
          atvs={atvs}
          openSessionByAtv={openSessionByAtv}
          openMotoSessionById={openMotoSessionById}
          openBrincaSessionById={openBrincaSessionById}
          brincaSettings={brincaSettings}
          tickMs={tickMs}
          onCreateCombo={handleCreateCombo}
          onStartMotoLeg={handleStartComboMotoLeg}
          onStartBrincaLeg={handleStartComboBrincaLeg}
          onCancelCombo={handleCancelCombo}
          onError={(message) => notify('error', message)}
        />
      ) : null}

      {tab === 'finance' ? (
        <FinanceTab
          byAtv={financeByAtv}
          total={financeTotal}
          recentSessions={recentSessions}
          brincaTotal={brincaFinanceTotal}
          brincaRecentSessions={brincaRecentSessions}
          comboFinance={comboFinanceTotal}
          atvs={atvs}
          canReset={isAdmin}
          rangeMode={financeRangeMode}
          rangeLabel={financeRange.label}
          selectedDay={selectedDay}
          selectedMonth={selectedMonth}
          rangeStartDay={rangeStartDay}
          rangeEndDay={rangeEndDay}
          rangeMonthsBack={rangeMonthsBack}
          onRangeModeChange={setFinanceRangeMode}
          onDayChange={setSelectedDay}
          onMonthChange={setSelectedMonth}
          onRangeStartDayChange={setRangeStartDay}
          onRangeEndDayChange={setRangeEndDay}
          onRangeMonthsBackChange={setRangeMonthsBack}
          onApplyLastMonths={handleApplyLastMonthsRange}
          onSetSessionPayment={handleSetSessionPayment}
          onSetBrincaPayment={handleSetBrincaPayment}
          onExportCsv={handleExportFinanceCsv}
          onResetFinance={handleResetFinance}
          onError={(message) => notify('error', message)}
        />
      ) : null}

      {toast ? <aside className={`toast ${toast.type}`}>{toast.message}</aside> : null}
    </main>
  )
}

function OperationsTab(props: {
  atvs: Atv[]
  lastClosedSessionByAtv: Record<string, RideSession>
  openSessionByAtv: Map<string, RideSession>
  comboMotoSessionIds: ReadonlySet<string>
  tickMs: number
  onStartSession: (atvId: string, durationMinutes: number) => Promise<string>
  onStopSession: (sessionId: string) => Promise<void>
  onPauseSession: (sessionId: string) => Promise<void>
  onResumeSession: (sessionId: string) => Promise<void>
  onRestartSession: (sessionId: string, durationMinutes: number) => Promise<void>
  onExtendSession: (sessionId: string, extraMinutes: number) => Promise<void>
  onCancelSession: (sessionId: string, annulKey: string) => Promise<void>
  onSetSessionPayment: (sessionId: string, paymentStatus: PaymentStatus, paymentMethod: PaymentMethod) => Promise<void>
  onError: (message: string) => void
}): ReactElement {
  const {
    atvs,
    lastClosedSessionByAtv,
    openSessionByAtv,
    comboMotoSessionIds,
    tickMs,
    onStartSession,
    onStopSession,
    onPauseSession,
    onResumeSession,
    onRestartSession,
    onExtendSession,
    onCancelSession,
    onSetSessionPayment,
    onError,
  } = props
  const [startingFor, setStartingFor] = useState<string | null>(null)
  const [durationByAtv, setDurationByAtv] = useState<Record<string, number>>({})
  const [startPaymentByAtv, setStartPaymentByAtv] = useState<
    Record<string, { status: PaymentStatus; method: PaymentMethod }>
  >({})
  const [paymentDraftBySessionId, setPaymentDraftBySessionId] = useState<
    Record<string, { status: PaymentStatus; method: PaymentMethod }>
  >({})

  function getStartPaymentDraft(atvId: string): { status: PaymentStatus; method: PaymentMethod } {
    return startPaymentByAtv[atvId] ?? { status: 'pending', method: null }
  }

  function getSessionPaymentDraft(session: RideSession): { status: PaymentStatus; method: PaymentMethod } {
    return paymentDraftBySessionId[session.id] ?? { status: session.payment_status, method: session.payment_method }
  }

  async function handleStart(atv: Atv): Promise<void> {
    const duration = Math.max(1, Math.floor(durationByAtv[atv.id] ?? atv.base_minutes))
    const paymentDraft = getStartPaymentDraft(atv.id)
    const paymentMethod = paymentDraft.status === 'paid' ? paymentDraft.method : null
    if (paymentDraft.status === 'paid' && !paymentMethod) {
      return
    }

    setStartingFor(atv.id)
    try {
      const sessionId = await onStartSession(atv.id, duration)
      await onSetSessionPayment(sessionId, paymentDraft.status, paymentMethod)
    } finally {
      setStartingFor(null)
    }
  }

  async function handleStop(sessionId: string): Promise<void> {
    const confirmed = window.confirm('Seguro que deseas detener esta sesion? Se cerrara y quedara cobrada.')
    if (!confirmed) {
      return
    }

    setStartingFor(sessionId)
    try {
      await onStopSession(sessionId)
    } finally {
      setStartingFor(null)
    }
  }

  async function handlePause(sessionId: string): Promise<void> {
    setStartingFor(sessionId)
    try {
      await onPauseSession(sessionId)
    } finally {
      setStartingFor(null)
    }
  }

  async function handleResume(sessionId: string): Promise<void> {
    setStartingFor(sessionId)
    try {
      await onResumeSession(sessionId)
    } finally {
      setStartingFor(null)
    }
  }

  async function handleExtend(sessionId: string): Promise<void> {
    const value = window.prompt('Cuantos minutos adicionales?', '5')
    if (!value) {
      return
    }

    const extraMinutes = Number(value)
    if (!Number.isFinite(extraMinutes) || extraMinutes <= 0) {
      return
    }

    const confirmed = window.confirm(`Confirmas agregar ${Math.floor(extraMinutes)} minutos a esta sesion?`)
    if (!confirmed) {
      return
    }

    setStartingFor(sessionId)
    try {
      await onExtendSession(sessionId, Math.floor(extraMinutes))
    } finally {
      setStartingFor(null)
    }
  }

  async function handleRestart(sessionId: string, defaultMinutes: number): Promise<void> {
    const value = window.prompt('Reiniciar con cuantos minutos?', String(defaultMinutes))
    if (!value) {
      return
    }

    const durationMinutes = Number(value)
    if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
      return
    }

    setStartingFor(sessionId)
    try {
      await onRestartSession(sessionId, Math.floor(durationMinutes))
    } finally {
      setStartingFor(null)
    }
  }

  async function handleCancel(sessionId: string): Promise<void> {
    const annulKey = window.prompt('Ingresa la clave de anulacion para esta sesion')
    if (!annulKey) {
      return
    }

    const confirmed = window.confirm('Confirmas anular esta sesion? No se cobrara en finanzas.')
    if (!confirmed) {
      return
    }

    setStartingFor(sessionId)
    try {
      await onCancelSession(sessionId, annulKey)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setStartingFor(null)
    }
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Operacion y tiempo de uso</h2>
        <p className="muted">El contador se calcula con hora de servidor para no depender del celular.</p>
      </header>

      <div className="card-grid">
        {atvs.map((atv) => {
          const openSession = openSessionByAtv.get(atv.id)
          const isComboSession = openSession ? comboMotoSessionIds.has(openSession.id) : false
          const lastClosedSession = lastClosedSessionByAtv[atv.id]
          const atvColor = atv.color_hex ?? '#3b82f6'
          const lastClosedEndedMs = lastClosedSession?.ended_at ? new Date(lastClosedSession.ended_at).getTime() : null
          const nowForSession =
            openSession?.status === 'paused'
              ? new Date(openSession.paused_at ?? openSession.updated_at).getTime()
              : tickMs
          const remainingMs = openSession ? getRemainingMs(openSession.target_end_at, nowForSession) : 0
          const isExpired = Boolean(openSession && remainingMs <= 0)
          const isRunning = openSession?.status === 'active'
          const isPaused = openSession?.status === 'paused'
          const isRecentlyFinished = Boolean(
            !openSession && lastClosedEndedMs !== null && tickMs - lastClosedEndedMs <= RECENT_FINISH_SIGNAL_MS,
          )
          const hasRecentFinishSignal = isExpired || isRecentlyFinished

          const availabilityLabel = !atv.active
            ? 'Fuera de servicio'
            : isRunning
              ? 'En uso'
              : isPaused
                ? 'Pausada'
                : 'Disponible'

          const availabilityClass = !atv.active
            ? 'inactive'
            : isRunning
              ? 'busy'
              : isPaused
                ? 'paused'
                : 'ok'

          return (
            <article key={atv.id} className={`atv-card ${isExpired ? 'expired' : ''} ${hasRecentFinishSignal ? 'recent-finished' : ''}`}>
              <header>
                <h3>{atv.name}</h3>
                <span className={`badge ${availabilityClass}`}>{availabilityLabel}</span>
              </header>

              <div className="atv-image-wrap" style={{ boxShadow: `inset 0 0 0 1px ${atvColor}4a, 0 14px 28px ${atvColor}2e` }}>
                <img src="/atv-kid-blue.png" alt={`Cuatrimoto infantil de referencia para ${atv.name}`} className="atv-image" loading="lazy" />
                <span className="atv-image-shade" style={{ backgroundColor: atvColor }} aria-hidden="true" />
                <span className="atv-image-tint" style={{ backgroundColor: atvColor }} aria-hidden="true" />
              </div>

              <p className="meta">
                Color: <span className="color-chip" style={{ backgroundColor: atvColor }} aria-hidden="true" /> {atvColor.toUpperCase()}
              </p>
              <p className="meta">
                Tarifa base: {formatMinutes(atv.base_minutes)} = {formatCurrencyCop(atv.base_price_cop)}
              </p>

              {openSession ? (
                <>
                  <p className="meta">ID transaccion: {shortTransactionId(openSession.id)}</p>
                  <p className="meta">Inicio: {formatDateTime(openSession.started_at)}</p>
                  <p className="meta">Fin objetivo: {formatDateTime(openSession.target_end_at)}</p>
                  {isPaused ? <p className="meta">Pausa desde: {formatDateTime(openSession.paused_at)}</p> : null}
                  <p className={`clock ${isExpired ? 'danger-text' : ''}`}>
                    {isExpired ? 'Vencido' : isPaused ? 'Tiempo restante (pausado)' : 'Tiempo restante'}:{' '}
                    {formatRemainingClock(remainingMs)}
                  </p>
                  <p className="meta">
                    Pago: {paymentStatusLabel(openSession.payment_status)} | Medio: {paymentMethodLabel(openSession.payment_method)}
                  </p>
                  {!isExpired ? (
                    <div className="button-row">
                      {(() => {
                        const paymentDraft = getSessionPaymentDraft(openSession)
                        return (
                          <>
                            <label>
                              Estado pago
                              <select
                                value={paymentDraft.status}
                                onChange={(event) => {
                                  const status = event.target.value as PaymentStatus
                                  setPaymentDraftBySessionId((current) => ({
                                    ...current,
                                    [openSession.id]: {
                                      status,
                                      method:
                                        status === 'pending'
                                          ? null
                                          : current[openSession.id]?.method ?? openSession.payment_method ?? 'cash',
                                    },
                                  }))
                                }}
                              >
                                <option value="pending">Pendiente</option>
                                <option value="paid">Pagado</option>
                              </select>
                            </label>
                            <label>
                              Medio pago
                              <select
                                value={paymentDraft.method ?? ''}
                                disabled={paymentDraft.status !== 'paid' || startingFor === openSession.id}
                                onChange={(event) => {
                                  const value = event.target.value as 'cash' | 'nequi' | ''
                                  setPaymentDraftBySessionId((current) => ({
                                    ...current,
                                    [openSession.id]: {
                                      status: paymentDraft.status,
                                      method: value ? value : null,
                                    },
                                  }))
                                }}
                              >
                                <option value="">Seleccionar</option>
                                <option value="cash">Efectivo</option>
                                <option value="nequi">Nequi</option>
                              </select>
                            </label>
                            <button
                              type="button"
                              className="secondary"
                              disabled={
                                startingFor === openSession.id ||
                                (paymentDraft.status === 'paid' && !paymentDraft.method)
                              }
                              onClick={() =>
                                void (async () => {
                                  setStartingFor(openSession.id)
                                  try {
                                    await onSetSessionPayment(
                                      openSession.id,
                                      paymentDraft.status,
                                      paymentDraft.status === 'paid' ? paymentDraft.method : null,
                                    )
                                  } finally {
                                    setStartingFor(null)
                                  }
                                })()
                              }
                            >
                              Guardar pago
                            </button>
                          </>
                        )
                      })()}
                    </div>
                  ) : null}
                  {isComboSession ? <p className="meta">Sesion de combo: no permite agregar tiempo.</p> : null}
                  {isExpired ? <p className="meta danger-text">Vencido {formatTimeAgo(openSession.target_end_at, tickMs)}.</p> : null}
                  {hasRecentFinishSignal ? <p className="recent-finish-indicator">Tiempo finalizado recientemente</p> : null}

                  {!isExpired ? (
                    <div className="button-row">
                      {isRunning ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={startingFor === openSession.id}
                          onClick={() => void handlePause(openSession.id)}
                        >
                          Pausar
                        </button>
                      ) : null}
                      {isPaused ? (
                        <button
                          type="button"
                          className="secondary"
                          disabled={startingFor === openSession.id}
                          onClick={() => void handleResume(openSession.id)}
                        >
                          Reanudar
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="secondary"
                        disabled={startingFor === openSession.id || isComboSession}
                        onClick={() => void handleExtend(openSession.id)}
                      >
                        + Minutos
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        disabled={startingFor === openSession.id}
                        onClick={() => void handleRestart(openSession.id, atv.base_minutes)}
                      >
                        Reiniciar
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={startingFor === openSession.id}
                        onClick={() => void handleStop(openSession.id)}
                      >
                        Detener
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={startingFor === openSession.id}
                        onClick={() => void handleCancel(openSession.id)}
                      >
                        Anular
                      </button>
                    </div>
                  ) : null}
                  {isExpired ? <p className="meta danger-text">Cierre automatico en proceso...</p> : null}
                </>
              ) : (
                <>
                  {lastClosedSession?.ended_at ? (
                    <p className="meta">
                      Ultima sesion: termino {formatTimeAgo(lastClosedSession.ended_at, tickMs)} (
                      {formatDateTime(lastClosedSession.ended_at)})
                    </p>
                  ) : null}
                  {lastClosedSession ? <p className="meta">ID transaccion: {shortTransactionId(lastClosedSession.id)}</p> : null}
                  {lastClosedSession ? (
                    <p className="meta">
                      Pago: {paymentStatusLabel(lastClosedSession.payment_status)} | Medio:{' '}
                      {paymentMethodLabel(lastClosedSession.payment_method)}
                    </p>
                  ) : null}
                  {isRecentlyFinished ? <p className="recent-finish-indicator">Tiempo finalizado recientemente</p> : null}
                  <label>
                    Duracion (minutos)
                    <input
                      type="number"
                      min={1}
                      value={durationByAtv[atv.id] ?? atv.base_minutes}
                      onChange={(event) => {
                        setDurationByAtv((current) => ({
                          ...current,
                          [atv.id]: Number(event.target.value),
                        }))
                      }}
                    />
                  </label>
                  <label>
                    Estado pago inicial
                    <select
                      value={getStartPaymentDraft(atv.id).status}
                      onChange={(event) => {
                        const status = event.target.value as PaymentStatus
                        setStartPaymentByAtv((current) => ({
                          ...current,
                          [atv.id]: {
                            status,
                            method: status === 'pending' ? null : current[atv.id]?.method ?? 'cash',
                          },
                        }))
                      }}
                    >
                      <option value="pending">Pendiente</option>
                      <option value="paid">Pagado</option>
                    </select>
                  </label>
                  <label>
                    Medio pago
                    <select
                      value={getStartPaymentDraft(atv.id).method ?? ''}
                      disabled={getStartPaymentDraft(atv.id).status !== 'paid' || startingFor === atv.id}
                      onChange={(event) => {
                        const value = event.target.value as 'cash' | 'nequi' | ''
                        setStartPaymentByAtv((current) => ({
                          ...current,
                          [atv.id]: {
                            status: getStartPaymentDraft(atv.id).status,
                            method: value ? value : null,
                          },
                        }))
                      }}
                    >
                      <option value="">Seleccionar</option>
                      <option value="cash">Efectivo</option>
                      <option value="nequi">Nequi</option>
                    </select>
                  </label>

                  <button
                    type="button"
                    disabled={
                      !atv.active ||
                      startingFor === atv.id ||
                      (getStartPaymentDraft(atv.id).status === 'paid' && !getStartPaymentDraft(atv.id).method)
                    }
                    onClick={() => void handleStart(atv)}
                  >
                    {startingFor === atv.id ? 'Iniciando...' : 'Iniciar tiempo'}
                  </button>
                </>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}

function BrincaTab(props: {
  canEdit: boolean
  settings: BrincaSettings | null
  openSessions: BrincaSession[]
  comboBrincaSessionIds: ReadonlySet<string>
  tickMs: number
  onUpdateSettings: (baseMinutes: number, basePriceCop: number) => Promise<void>
  onStartSession: (childName: string, durationMinutes: number) => Promise<string>
  onPauseSession: (sessionId: string) => Promise<void>
  onResumeSession: (sessionId: string) => Promise<void>
  onExtendSession: (sessionId: string, extraMinutes: number) => Promise<void>
  onStopSession: (sessionId: string) => Promise<void>
  onCancelSession: (sessionId: string, annulKey: string) => Promise<void>
  onSetSessionPayment: (sessionId: string, paymentStatus: PaymentStatus, paymentMethod: PaymentMethod) => Promise<void>
  onError: (message: string) => void
}): ReactElement {
  const {
    canEdit,
    settings,
    openSessions,
    comboBrincaSessionIds,
    tickMs,
    onUpdateSettings,
    onStartSession,
    onPauseSession,
    onResumeSession,
    onExtendSession,
    onStopSession,
    onCancelSession,
    onSetSessionPayment,
    onError,
  } = props

  const [childName, setChildName] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(15)
  const [startPaymentStatus, setStartPaymentStatus] = useState<PaymentStatus>('pending')
  const [startPaymentMethod, setStartPaymentMethod] = useState<PaymentMethod>(null)
  const [baseMinutesDraft, setBaseMinutesDraft] = useState<number | null>(null)
  const [basePriceDraft, setBasePriceDraft] = useState<number | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [busySessionId, setBusySessionId] = useState<string | null>(null)
  const [startingSession, setStartingSession] = useState(false)
  const [paymentDraftBySessionId, setPaymentDraftBySessionId] = useState<
    Record<string, { status: PaymentStatus; method: PaymentMethod }>
  >({})

  function getPaymentDraft(session: BrincaSession): { status: PaymentStatus; method: PaymentMethod } {
    return paymentDraftBySessionId[session.id] ?? { status: session.payment_status, method: session.payment_method }
  }

  async function handleSaveSettings(): Promise<void> {
    if (!canEdit) {
      onError('Solo admin puede actualizar tarifa de Brinca.')
      return
    }

    setSavingSettings(true)
    try {
      const nextBaseMinutes = Math.max(1, Math.floor(baseMinutesDraft ?? settings?.base_minutes ?? 15))
      const nextBasePrice = Math.max(5000, Math.floor(basePriceDraft ?? settings?.base_price_cop ?? 5000))
      await onUpdateSettings(nextBaseMinutes, nextBasePrice)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setSavingSettings(false)
    }
  }

  async function handleStartSession(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const name = childName.trim()
    if (!name) {
      onError('Debes escribir el nombre del nino.')
      return
    }

    const fallback = settings?.base_minutes ?? 15
    const duration = Math.max(1, Math.floor(durationMinutes || fallback))
    if (startPaymentStatus === 'paid' && !startPaymentMethod) {
      onError('Si el pago inicial es Pagado, debes elegir Efectivo o Nequi.')
      return
    }

    setStartingSession(true)
    try {
      const sessionId = await onStartSession(name, duration)
      await onSetSessionPayment(sessionId, startPaymentStatus, startPaymentStatus === 'paid' ? startPaymentMethod : null)
      setChildName('')
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setStartingSession(false)
    }
  }

  async function handleStopSession(sessionId: string): Promise<void> {
    const confirmed = window.confirm('Seguro que deseas detener esta sesion de Brinca? Se cerrara y quedara cobrada.')
    if (!confirmed) {
      return
    }

    setBusySessionId(sessionId)
    try {
      await onStopSession(sessionId)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setBusySessionId(null)
    }
  }

  async function handlePauseSession(sessionId: string): Promise<void> {
    setBusySessionId(sessionId)
    try {
      await onPauseSession(sessionId)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setBusySessionId(null)
    }
  }

  async function handleResumeSession(sessionId: string): Promise<void> {
    setBusySessionId(sessionId)
    try {
      await onResumeSession(sessionId)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setBusySessionId(null)
    }
  }

  async function handleExtendSession(sessionId: string): Promise<void> {
    const value = window.prompt('Cuantos minutos adicionales para esta sesion de Brinca?', '5')
    if (!value) {
      return
    }

    const extraMinutes = Number(value)
    if (!Number.isFinite(extraMinutes) || extraMinutes <= 0) {
      onError('Debes ingresar minutos validos.')
      return
    }

    const confirmed = window.confirm(`Confirmas agregar ${Math.floor(extraMinutes)} minutos a esta sesion?`)
    if (!confirmed) {
      return
    }

    setBusySessionId(sessionId)
    try {
      await onExtendSession(sessionId, Math.floor(extraMinutes))
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setBusySessionId(null)
    }
  }

  async function handleCancelSession(sessionId: string): Promise<void> {
    const annulKey = window.prompt('Ingresa la clave de anulacion para esta sesion de Brinca')
    if (!annulKey) {
      return
    }

    const confirmed = window.confirm('Confirmas anular esta sesion? No se cobrara en finanzas.')
    if (!confirmed) {
      return
    }

    setBusySessionId(sessionId)
    try {
      await onCancelSession(sessionId, annulKey)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setBusySessionId(null)
    }
  }

  async function handleSaveSessionPayment(session: BrincaSession): Promise<void> {
    const draft = getPaymentDraft(session)
    if (draft.status === 'paid' && !draft.method) {
      onError('Para marcar pagado debes elegir Efectivo o Nequi.')
      return
    }

    setBusySessionId(session.id)
    try {
      await onSetSessionPayment(session.id, draft.status, draft.status === 'paid' ? draft.method : null)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setBusySessionId(null)
    }
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Operacion Brinca</h2>
        <p className="muted">Sesiones por nino para cama elastica, con cobro automatico por tiempo.</p>
      </header>

      <div className="brinca-hero">
        <div className="atv-image-wrap brinca-image-wrap">
          <img
            src="/brinca-trampolin.png"
            alt="Trampolin de cama elastica para sesiones de Brinca"
            className="atv-image brinca-image"
            loading="lazy"
          />
        </div>
        <div className="brinca-rate-card">
          <h3>Tarifa Brinca</h3>
          <p className="meta">
            Base actual: {formatMinutes(settings?.base_minutes ?? 15)} = {formatCurrencyCop(settings?.base_price_cop ?? 5000)}
          </p>
          <div className="button-row">
            <label>
              Base minutos
              <input
                type="number"
                min={1}
                value={baseMinutesDraft ?? settings?.base_minutes ?? 15}
                disabled={!canEdit}
                onChange={(event) => setBaseMinutesDraft(Number(event.target.value))}
              />
            </label>
            <label>
              Base precio (COP)
              <input
                type="number"
                min={5000}
                value={basePriceDraft ?? settings?.base_price_cop ?? 5000}
                disabled={!canEdit}
                onChange={(event) => setBasePriceDraft(Number(event.target.value))}
              />
            </label>
            <button type="button" className="secondary" disabled={!canEdit || savingSettings} onClick={() => void handleSaveSettings()}>
              {savingSettings ? 'Guardando...' : 'Guardar tarifa'}
            </button>
          </div>
        </div>
      </div>

      <form className="inline-form brinca-start-form" onSubmit={handleStartSession}>
        <label>
          Nombre del nino
          <input
            required
            value={childName}
            onChange={(event) => setChildName(event.target.value)}
            placeholder="Ej: Samuel"
          />
        </label>
        <label>
          Duracion (minutos)
          <input
            type="number"
            min={1}
            value={durationMinutes}
            onChange={(event) => setDurationMinutes(Number(event.target.value))}
          />
        </label>
        <label>
          Estado pago inicial
          <select
            value={startPaymentStatus}
            onChange={(event) => {
              const status = event.target.value as PaymentStatus
              setStartPaymentStatus(status)
              if (status === 'pending') {
                setStartPaymentMethod(null)
              }
            }}
          >
            <option value="pending">Pendiente</option>
            <option value="paid">Pagado</option>
          </select>
        </label>
        <label>
          Medio pago
          <select
            value={startPaymentMethod ?? ''}
            disabled={startPaymentStatus !== 'paid' || startingSession}
            onChange={(event) => {
              const value = event.target.value as 'cash' | 'nequi' | ''
              setStartPaymentMethod(value ? value : null)
            }}
          >
            <option value="">Seleccionar</option>
            <option value="cash">Efectivo</option>
            <option value="nequi">Nequi</option>
          </select>
        </label>
        <button type="submit" disabled={startingSession}>
          {startingSession ? 'Iniciando...' : 'Iniciar sesion Brinca'}
        </button>
      </form>

      <div className="card-grid">
        {openSessions.length === 0 ? (
          <article className="atv-card">
            <p className="meta">No hay sesiones de Brinca abiertas.</p>
          </article>
        ) : (
          openSessions.map((session) => {
            const isComboSession = comboBrincaSessionIds.has(session.id)
            const nowForSession =
              session.status === 'paused'
                ? new Date(session.paused_at ?? session.updated_at).getTime()
                : tickMs
            const remainingMs = getRemainingMs(session.target_end_at, nowForSession)
            const isExpired = remainingMs <= 0
            const isPaused = session.status === 'paused'
            const isRunning = session.status === 'active'

            return (
              <article key={session.id} className={`atv-card ${isExpired ? 'expired' : ''}`}>
                <header>
                  <h3>{session.child_name}</h3>
                  <span className={`badge ${isPaused ? 'paused' : isRunning ? 'busy' : 'inactive'}`}>
                    {isPaused ? 'Pausada' : isRunning ? 'En uso' : 'Cerrando...'}
                  </span>
                </header>

                <p className="meta">ID transaccion: {shortTransactionId(session.id)}</p>
                <p className="meta">Inicio: {formatDateTime(session.started_at)}</p>
                <p className="meta">Fin objetivo: {formatDateTime(session.target_end_at)}</p>
                <p className="meta">
                  Tarifa aplicada: {formatMinutes(session.base_minutes)} = {formatCurrencyCop(session.base_price_cop)}
                </p>
                <p className={`clock ${isExpired ? 'danger-text' : ''}`}>
                  {isExpired ? 'Vencido' : isPaused ? 'Tiempo restante (pausado)' : 'Tiempo restante'}:{' '}
                  {formatRemainingClock(remainingMs)}
                </p>
                <p className="meta">
                  Pago: {paymentStatusLabel(session.payment_status)} | Medio: {paymentMethodLabel(session.payment_method)}
                </p>
                {!isExpired ? (
                  <div className="button-row">
                    {(() => {
                      const paymentDraft = getPaymentDraft(session)
                      return (
                        <>
                          <label>
                            Estado pago
                            <select
                              value={paymentDraft.status}
                              onChange={(event) => {
                                const status = event.target.value as PaymentStatus
                                setPaymentDraftBySessionId((current) => ({
                                  ...current,
                                  [session.id]: {
                                    status,
                                    method: status === 'pending' ? null : current[session.id]?.method ?? session.payment_method ?? 'cash',
                                  },
                                }))
                              }}
                            >
                              <option value="pending">Pendiente</option>
                              <option value="paid">Pagado</option>
                            </select>
                          </label>
                          <label>
                            Medio pago
                            <select
                              value={paymentDraft.method ?? ''}
                              disabled={paymentDraft.status !== 'paid' || busySessionId === session.id}
                              onChange={(event) => {
                                const value = event.target.value as 'cash' | 'nequi' | ''
                                setPaymentDraftBySessionId((current) => ({
                                  ...current,
                                  [session.id]: {
                                    status: paymentDraft.status,
                                    method: value ? value : null,
                                  },
                                }))
                              }}
                            >
                              <option value="">Seleccionar</option>
                              <option value="cash">Efectivo</option>
                              <option value="nequi">Nequi</option>
                            </select>
                          </label>
                          <button
                            type="button"
                            className="secondary"
                            disabled={busySessionId === session.id || (paymentDraft.status === 'paid' && !paymentDraft.method)}
                            onClick={() => void handleSaveSessionPayment(session)}
                          >
                            Guardar pago
                          </button>
                        </>
                      )
                    })()}
                  </div>
                ) : null}
                {isComboSession ? <p className="meta">Sesion de combo: no permite agregar tiempo.</p> : null}

                <div className="button-row">
                  {isRunning ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busySessionId === session.id || isExpired}
                      onClick={() => void handlePauseSession(session.id)}
                    >
                      Pausar
                    </button>
                  ) : null}
                  {isPaused ? (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busySessionId === session.id || isExpired}
                      onClick={() => void handleResumeSession(session.id)}
                    >
                      Reanudar
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="secondary"
                    disabled={busySessionId === session.id || isExpired || isComboSession}
                    onClick={() => void handleExtendSession(session.id)}
                  >
                    + Minutos
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busySessionId === session.id || isExpired}
                    onClick={() => void handleStopSession(session.id)}
                  >
                    Detener
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busySessionId === session.id || isExpired}
                    onClick={() => void handleCancelSession(session.id)}
                  >
                    Anular
                  </button>
                </div>
              </article>
            )
          })
        )}
      </div>

    </section>
  )
}

function CombosTab(props: {
  combos: Combo[]
  atvs: Atv[]
  openSessionByAtv: Map<string, RideSession>
  openMotoSessionById: Map<string, RideSession>
  openBrincaSessionById: Map<string, BrincaSession>
  brincaSettings: BrincaSettings | null
  tickMs: number
  onCreateCombo: (input: {
    childName: string
    startMode: ComboStartMode
    motoDurationMinutes: number
    brincaDurationMinutes: number
    atvId?: string | null
  }) => Promise<void>
  onStartMotoLeg: (comboId: string, atvId?: string | null) => Promise<void>
  onStartBrincaLeg: (comboId: string) => Promise<void>
  onCancelCombo: (comboId: string, annulKey: string) => Promise<void>
  onError: (message: string) => void
}): ReactElement {
  const {
    combos,
    atvs,
    openSessionByAtv,
    openMotoSessionById,
    openBrincaSessionById,
    brincaSettings,
    tickMs,
    onCreateCombo,
    onStartMotoLeg,
    onStartBrincaLeg,
    onCancelCombo,
    onError,
  } = props

  const [childName, setChildName] = useState('')
  const [startMode, setStartMode] = useState<ComboStartMode>('either')
  const [selectedAtvId, setSelectedAtvId] = useState('')
  const [motoDurationMinutes, setMotoDurationMinutes] = useState(10)
  const [brincaDurationMinutes, setBrincaDurationMinutes] = useState(15)
  const [creating, setCreating] = useState(false)
  const [busyComboId, setBusyComboId] = useState<string | null>(null)
  const [atvDraftByCombo, setAtvDraftByCombo] = useState<Record<string, string>>({})

  const availableAtvs = useMemo(() => {
    return atvs.filter((atv) => atv.active && !openSessionByAtv.has(atv.id))
  }, [atvs, openSessionByAtv])

  const availableAtvIds = useMemo(() => new Set(availableAtvs.map((atv) => atv.id)), [availableAtvs])
  const visibleCombos = useMemo(() => {
    return combos.filter((combo) => {
      if (combo.status !== 'completed' && combo.status !== 'cancelled') {
        return true
      }

      const referenceAt = combo.completed_at ?? combo.updated_at
      const referenceMs = new Date(referenceAt).getTime()
      if (!Number.isFinite(referenceMs)) {
        return false
      }

      return tickMs - referenceMs <= COMBO_HISTORY_VISIBILITY_MS
    })
  }, [combos, tickMs])

  function comboStatusBadge(status: Combo['status']): { label: string; className: string } {
    if (status === 'completed') {
      return { label: 'Completado', className: 'finished' }
    }
    if (status === 'cancelled') {
      return { label: 'Cancelado', className: 'inactive' }
    }
    if (status === 'in_progress') {
      return { label: 'En curso', className: 'busy' }
    }
    return { label: 'Pendiente', className: 'ok' }
  }

  function legStatusBadge(
    hasSession: boolean,
    completedAt: string | null,
    openStatus: 'active' | 'paused' | null,
  ): { label: string; className: string } {
    if (!hasSession) {
      return { label: 'Pendiente', className: 'ok' }
    }
    if (completedAt) {
      return { label: 'Completada', className: 'finished' }
    }
    if (openStatus === 'paused') {
      return { label: 'Pausada', className: 'paused' }
    }
    return { label: 'En uso', className: 'busy' }
  }

  function startModeLabel(mode: ComboStartMode): string {
    if (mode === 'moto_first') {
      return 'Moto primero'
    }
    if (mode === 'brinca_first') {
      return 'Brinca primero'
    }
    return 'Cualquiera primero'
  }

  async function handleCreateCombo(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const name = childName.trim()
    if (!name) {
      onError('Debes ingresar el nombre del nino.')
      return
    }

    setCreating(true)
    try {
      await onCreateCombo({
        childName: name,
        startMode,
        motoDurationMinutes: Math.max(1, Math.floor(motoDurationMinutes || 10)),
        brincaDurationMinutes: Math.max(1, Math.floor(brincaDurationMinutes || brincaSettings?.base_minutes || 15)),
        atvId: selectedAtvId || null,
      })
      setChildName('')
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setCreating(false)
    }
  }

  async function handleStartMoto(combo: Combo): Promise<void> {
    const atvId = atvDraftByCombo[combo.id] ?? combo.atv_id ?? ''
    if (!atvId) {
      onError('Selecciona una cuatrimoto disponible para iniciar la parte de moto.')
      return
    }

    setBusyComboId(combo.id)
    try {
      await onStartMotoLeg(combo.id, atvId)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setBusyComboId(null)
    }
  }

  async function handleStartBrinca(combo: Combo): Promise<void> {
    setBusyComboId(combo.id)
    try {
      await onStartBrincaLeg(combo.id)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setBusyComboId(null)
    }
  }

  async function handleCancel(comboId: string): Promise<void> {
    const annulKey = window.prompt('Ingresa la clave de anulacion para este combo')
    if (!annulKey) {
      return
    }

    const confirmed = window.confirm('Seguro que deseas cancelar este combo?')
    if (!confirmed) {
      return
    }

    setBusyComboId(comboId)
    try {
      await onCancelCombo(comboId, annulKey)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setBusyComboId(null)
    }
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Combos</h2>
        <p className="muted">
          Crea combos para un nino (Moto + Brinca), elige que inicia primero y dispara cada parte cuando toque.
        </p>
        <p className="muted">Tarifa combo: Moto 10 min = 8000 COP, Brinca 15 min = 5000 COP.</p>
        <p className="muted">Los combos completados o cancelados se ocultan automaticamente despues de 5 minutos.</p>
      </header>

      <form className="inline-form combo-create-form" onSubmit={handleCreateCombo}>
        <label>
          Nombre del nino
          <input
            required
            value={childName}
            onChange={(event) => setChildName(event.target.value)}
            placeholder="Ej: Mateo"
          />
        </label>
        <label>
          Orden del combo
          <select value={startMode} onChange={(event) => setStartMode(event.target.value as ComboStartMode)}>
            <option value="either">Cualquiera primero</option>
            <option value="moto_first">Moto primero</option>
            <option value="brinca_first">Brinca primero</option>
          </select>
        </label>
        <label>
          Moto (minutos)
          <input
            type="number"
            min={1}
            value={motoDurationMinutes}
            onChange={(event) => setMotoDurationMinutes(Number(event.target.value))}
          />
        </label>
        <label>
          Brinca (minutos)
          <input
            type="number"
            min={1}
            value={brincaDurationMinutes}
            onChange={(event) => setBrincaDurationMinutes(Number(event.target.value))}
          />
        </label>
        <label>
          Cuatrimoto (opcional)
          <select value={selectedAtvId} onChange={(event) => setSelectedAtvId(event.target.value)}>
            <option value="">Elegir al iniciar moto</option>
            {availableAtvs.map((atv) => (
              <option key={atv.id} value={atv.id}>
                {atv.name}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={creating}>
          {creating ? 'Creando...' : 'Crear combo'}
        </button>
      </form>

      <div className="card-grid">
        {visibleCombos.length === 0 ? (
          <article className="atv-card">
            <p className="meta">Todavia no hay combos creados.</p>
          </article>
        ) : (
          visibleCombos.map((combo) => {
            const statusBadge = comboStatusBadge(combo.status)
            const motoOpen = combo.moto_session_id ? openMotoSessionById.get(combo.moto_session_id) : undefined
            const brincaOpen = combo.brinca_session_id ? openBrincaSessionById.get(combo.brinca_session_id) : undefined
            const motoOpenStatus = motoOpen ? (motoOpen.status === 'paused' ? 'paused' : 'active') : null
            const brincaOpenStatus = brincaOpen ? (brincaOpen.status === 'paused' ? 'paused' : 'active') : null
            const motoBadge = legStatusBadge(Boolean(combo.moto_session_id), combo.moto_completed_at, motoOpenStatus)
            const brincaBadge = legStatusBadge(Boolean(combo.brinca_session_id), combo.brinca_completed_at, brincaOpenStatus)
            const motoRemaining = motoOpen ? getRemainingMs(motoOpen.target_end_at, tickMs) : null
            const brincaRemaining = brincaOpen ? getRemainingMs(brincaOpen.target_end_at, tickMs) : null
            const comboAtvValue = atvDraftByCombo[combo.id] ?? combo.atv_id ?? ''

            return (
              <article key={combo.id} className="atv-card combo-card">
                <header>
                  <h3>{combo.child_name}</h3>
                  <span className={`badge ${statusBadge.className}`}>{statusBadge.label}</span>
                </header>

                <p className="meta">ID combo: {shortTransactionId(combo.id)}</p>
                <p className="meta">Orden: {startModeLabel(combo.start_mode)}</p>
                <p className="meta">Creado: {formatDateTime(combo.created_at)}</p>
                <p className="meta">
                  Moto asignada:{' '}
                  {combo.atv_id ? atvs.find((atv) => atv.id === combo.atv_id)?.name ?? 'Moto no encontrada' : 'Sin seleccionar'}
                </p>

                <section className="combo-leg">
                  <div className="combo-leg-row">
                    <strong>Moto</strong>
                    <span className={`badge ${motoBadge.className}`}>{motoBadge.label}</span>
                  </div>
                  {combo.moto_session_id ? <p className="meta">ID transaccion moto: {shortTransactionId(combo.moto_session_id)}</p> : null}
                  <p className="meta">Duracion: {formatMinutes(combo.moto_duration_minutes)}</p>
                  {combo.moto_completed_at ? (
                    <p className="meta">
                      Cerrada: {formatTimeAgo(combo.moto_completed_at, tickMs)} ({formatDateTime(combo.moto_completed_at)})
                    </p>
                  ) : null}
                  {motoRemaining !== null ? (
                    <p className={`clock ${motoRemaining <= 0 ? 'danger-text' : ''}`}>Tiempo restante: {formatRemainingClock(motoRemaining)}</p>
                  ) : null}

                  {!combo.moto_session_id && combo.status !== 'cancelled' ? (
                    <div className="button-row">
                      <label className="combo-atv-select">
                        Cuatrimoto
                        <select
                          value={comboAtvValue}
                          onChange={(event) =>
                            setAtvDraftByCombo((current) => ({
                              ...current,
                              [combo.id]: event.target.value,
                            }))
                          }
                        >
                          <option value="">Seleccionar</option>
                          {atvs
                            .filter((atv) => atv.active)
                            .map((atv) => {
                              const isBusy = openSessionByAtv.has(atv.id)
                              const isSelected = comboAtvValue === atv.id
                              return (
                                <option key={atv.id} value={atv.id} disabled={isBusy && !isSelected}>
                                  {atv.name}
                                  {isBusy && !isSelected ? ' (ocupada)' : ''}
                                </option>
                              )
                            })}
                        </select>
                      </label>
                      <button
                        type="button"
                        disabled={busyComboId === combo.id || !comboAtvValue || !availableAtvIds.has(comboAtvValue)}
                        onClick={() => void handleStartMoto(combo)}
                      >
                        Iniciar moto
                      </button>
                    </div>
                  ) : null}
                </section>

                <section className="combo-leg">
                  <div className="combo-leg-row">
                    <strong>Brinca</strong>
                    <span className={`badge ${brincaBadge.className}`}>{brincaBadge.label}</span>
                  </div>
                  {combo.brinca_session_id ? <p className="meta">ID transaccion brinca: {shortTransactionId(combo.brinca_session_id)}</p> : null}
                  <p className="meta">Duracion: {formatMinutes(combo.brinca_duration_minutes)}</p>
                  {combo.brinca_completed_at ? (
                    <p className="meta">
                      Cerrada: {formatTimeAgo(combo.brinca_completed_at, tickMs)} ({formatDateTime(combo.brinca_completed_at)})
                    </p>
                  ) : null}
                  {brincaRemaining !== null ? (
                    <p className={`clock ${brincaRemaining <= 0 ? 'danger-text' : ''}`}>
                      Tiempo restante: {formatRemainingClock(brincaRemaining)}
                    </p>
                  ) : null}

                  {!combo.brinca_session_id && combo.status !== 'cancelled' ? (
                    <button
                      type="button"
                      disabled={busyComboId === combo.id}
                      onClick={() => void handleStartBrinca(combo)}
                    >
                      Iniciar Brinca
                    </button>
                  ) : null}
                </section>

                {combo.status !== 'cancelled' && combo.status !== 'completed' ? (
                  <button type="button" className="danger" disabled={busyComboId === combo.id} onClick={() => void handleCancel(combo.id)}>
                    Cancelar combo
                  </button>
                ) : null}
              </article>
            )
          })
        )}
      </div>
    </section>
  )
}

function AtvAdminTab(props: {
  atvs: Atv[]
  canEdit: boolean
  onAddAtv: (input: { name: string; colorHex?: string; baseMinutes: number; basePriceCop: number }) => Promise<void>
  onUpdateRates: (atvId: string, input: { baseMinutes: number; basePriceCop: number; colorHex?: string }) => Promise<void>
  onToggleActive: (atvId: string, active: boolean) => Promise<void>
  onDeleteAtv: (atvId: string) => Promise<void>
  onError: (message: string) => void
}): ReactElement {
  const { atvs, canEdit, onAddAtv, onUpdateRates, onToggleActive, onDeleteAtv, onError } = props
  const [name, setName] = useState('')
  const [colorHex, setColorHex] = useState('#3b82f6')
  const [baseMinutes, setBaseMinutes] = useState(10)
  const [basePriceCop, setBasePriceCop] = useState(10000)
  const [saving, setSaving] = useState(false)

  const [rateDrafts, setRateDrafts] = useState<Record<string, { baseMinutes: number; basePriceCop: number; colorHex: string }>>(
    {},
  )

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    if (!canEdit) {
      onError('Solo un admin puede crear cuatrimotos.')
      return
    }

    if (basePriceCop < 10000) {
      onError('La tarifa base de una moto no puede ser menor a 10000 COP.')
      return
    }

    setSaving(true)
    try {
      await onAddAtv({
        name,
        colorHex,
        baseMinutes,
        basePriceCop: Math.max(10000, Math.floor(basePriceCop)),
      })
      setName('')
      setColorHex('#3b82f6')
      setBaseMinutes(10)
      setBasePriceCop(10000)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setSaving(false)
    }
  }

  async function handleRateSave(atvId: string): Promise<void> {
    if (!canEdit) {
      onError('Solo un admin puede editar tarifas.')
      return
    }

    const atv = atvs.find((item) => item.id === atvId)
    if (!atv) {
      return
    }

    const draft = rateDrafts[atvId] ?? {
      baseMinutes: atv.base_minutes,
      basePriceCop: atv.base_price_cop,
      colorHex: atv.color_hex ?? '#3b82f6',
    }

    try {
      await onUpdateRates(atvId, {
        baseMinutes: Math.max(1, Math.floor(draft.baseMinutes)),
        basePriceCop: Math.max(10000, Math.floor(draft.basePriceCop)),
        colorHex: draft.colorHex,
      })
    } catch (error) {
      onError(getErrorMessage(error))
    }
  }

  async function handleToggle(atvId: string, active: boolean): Promise<void> {
    if (!canEdit) {
      onError('Solo un admin puede activar o desactivar cuatrimotos.')
      return
    }

    try {
      await onToggleActive(atvId, active)
    } catch (error) {
      onError(getErrorMessage(error))
    }
  }

  async function handleDelete(atvId: string): Promise<void> {
    if (!canEdit) {
      onError('Solo un admin puede eliminar cuatrimotos.')
      return
    }

    const confirmed = window.confirm(
      'Seguro que deseas eliminar esta cuatrimoto? Su historial financiero se conserva, pero ya no aparecera en operacion.',
    )
    if (!confirmed) {
      return
    }

    try {
      await onDeleteAtv(atvId)
    } catch (error) {
      onError(getErrorMessage(error))
    }
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Configuracion de cuatrimotos</h2>
        <p className="muted">Crea y configura tarifas base. Rol actual: {canEdit ? 'admin' : 'operator'}.</p>
      </header>

      <form className="inline-form" onSubmit={handleCreate}>
        <label>
          Nombre
          <input required value={name} onChange={(event) => setName(event.target.value)} placeholder="Yamaha 450" />
        </label>

        <label>
          Color
          <input type="color" value={colorHex} onChange={(event) => setColorHex(event.target.value)} />
        </label>

        <label>
          Base minutos
          <input
            required
            type="number"
            min={1}
            value={baseMinutes}
            onChange={(event) => setBaseMinutes(Number(event.target.value))}
          />
        </label>

        <label>
          Base precio (COP)
          <input
            required
            type="number"
            min={10000}
            value={basePriceCop}
            onChange={(event) => setBasePriceCop(Number(event.target.value))}
          />
        </label>

        <button type="submit" disabled={saving || !canEdit}>
          {saving ? 'Guardando...' : 'Agregar'}
        </button>
      </form>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Moto</th>
              <th>Color</th>
              <th>Base min</th>
              <th>Base COP</th>
              <th>Estado</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {atvs.map((atv) => {
              const draft = rateDrafts[atv.id]
              const effectiveColor = draft?.colorHex ?? atv.color_hex ?? '#3b82f6'
              return (
                <tr key={atv.id}>
                  <td>{atv.name}</td>
                  <td>
                    <div className="color-editor">
                      <span className="color-preview-square" style={{ backgroundColor: effectiveColor }} aria-hidden="true" />
                      <input
                        type="color"
                        value={effectiveColor}
                        disabled={!canEdit}
                        aria-label={`Color de ${atv.name}`}
                        onChange={(event) => {
                          const value = event.target.value
                          setRateDrafts((current) => ({
                            ...current,
                            [atv.id]: {
                              baseMinutes: current[atv.id]?.baseMinutes ?? atv.base_minutes,
                              basePriceCop: current[atv.id]?.basePriceCop ?? atv.base_price_cop,
                              colorHex: value,
                            },
                          }))
                        }}
                      />
                    </div>
                  </td>
                  <td>
                    <input
                      type="number"
                      min={1}
                      value={draft?.baseMinutes ?? atv.base_minutes}
                      disabled={!canEdit}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setRateDrafts((current) => ({
                          ...current,
                          [atv.id]: {
                            baseMinutes: value,
                            basePriceCop: current[atv.id]?.basePriceCop ?? atv.base_price_cop,
                            colorHex: current[atv.id]?.colorHex ?? atv.color_hex ?? '#3b82f6',
                          },
                        }))
                      }}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={10000}
                      value={draft?.basePriceCop ?? atv.base_price_cop}
                      disabled={!canEdit}
                      onChange={(event) => {
                        const value = Number(event.target.value)
                        setRateDrafts((current) => ({
                          ...current,
                          [atv.id]: {
                            baseMinutes: current[atv.id]?.baseMinutes ?? atv.base_minutes,
                            basePriceCop: value,
                            colorHex: current[atv.id]?.colorHex ?? atv.color_hex ?? '#3b82f6',
                          },
                        }))
                      }}
                    />
                  </td>
                  <td>
                    <span className={`badge ${atv.active ? 'ok' : 'inactive'}`}>
                      {atv.active ? 'Activa' : 'Inactiva'}
                    </span>
                  </td>
                  <td>
                    <div className="button-row compact">
                      <button type="button" className="secondary" disabled={!canEdit} onClick={() => void handleRateSave(atv.id)}>
                        Guardar
                      </button>
                      <button
                        type="button"
                        className={atv.active ? 'danger' : 'secondary'}
                        disabled={!canEdit}
                        onClick={() => void handleToggle(atv.id, !atv.active)}
                      >
                        {atv.active ? 'Desactivar' : 'Activar'}
                      </button>
                      <button type="button" className="danger" disabled={!canEdit} onClick={() => void handleDelete(atv.id)}>
                        Eliminar
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function FinanceTab(props: {
  byAtv: FinanceByAtvRow[]
  total: FinanceTotalRow | null
  recentSessions: RideSession[]
  brincaTotal: FinanceTotalRow | null
  brincaRecentSessions: BrincaSession[]
  comboFinance: ComboFinanceSummary | null
  atvs: Atv[]
  canReset: boolean
  rangeMode: FinanceRangeMode
  rangeLabel: string
  selectedDay: string
  selectedMonth: string
  rangeStartDay: string
  rangeEndDay: string
  rangeMonthsBack: number
  onRangeModeChange: (value: FinanceRangeMode) => void
  onDayChange: (value: string) => void
  onMonthChange: (value: string) => void
  onRangeStartDayChange: (value: string) => void
  onRangeEndDayChange: (value: string) => void
  onRangeMonthsBackChange: (value: number) => void
  onApplyLastMonths: () => void
  onSetSessionPayment: (sessionId: string, paymentStatus: PaymentStatus, paymentMethod: PaymentMethod) => Promise<void>
  onSetBrincaPayment: (sessionId: string, paymentStatus: PaymentStatus, paymentMethod: PaymentMethod) => Promise<void>
  onExportCsv: () => void
  onResetFinance: () => Promise<void>
  onError: (message: string) => void
}): ReactElement {
  const {
    byAtv,
    total,
    recentSessions,
    brincaTotal,
    brincaRecentSessions,
    comboFinance,
    atvs,
    canReset,
    rangeMode,
    rangeLabel,
    selectedDay,
    selectedMonth,
    rangeStartDay,
    rangeEndDay,
    rangeMonthsBack,
    onRangeModeChange,
    onDayChange,
    onMonthChange,
    onRangeStartDayChange,
    onRangeEndDayChange,
    onRangeMonthsBackChange,
    onApplyLastMonths,
    onSetSessionPayment,
    onSetBrincaPayment,
    onExportCsv,
    onResetFinance,
    onError,
  } = props
  const globalSessionCount = (total?.session_count ?? 0) + (brincaTotal?.session_count ?? 0)
  const globalMinutes = (total?.minutes_total ?? 0) + (brincaTotal?.minutes_total ?? 0)
  const globalAmountCop = (total?.amount_total_cop ?? 0) + (brincaTotal?.amount_total_cop ?? 0)
  const [motoPaymentDrafts, setMotoPaymentDrafts] = useState<Record<string, { status: PaymentStatus; method: PaymentMethod }>>({})
  const [brincaPaymentDrafts, setBrincaPaymentDrafts] = useState<Record<string, { status: PaymentStatus; method: PaymentMethod }>>({})
  const [savingMotoPaymentId, setSavingMotoPaymentId] = useState<string | null>(null)
  const [savingBrincaPaymentId, setSavingBrincaPaymentId] = useState<string | null>(null)

  function getAtvName(atvId: string): string {
    return atvs.find((item) => item.id === atvId)?.name ?? atvId
  }

  function getMotoPaymentDraft(session: RideSession): { status: PaymentStatus; method: PaymentMethod } {
    return (
      motoPaymentDrafts[session.id] ?? {
        status: session.payment_status,
        method: session.payment_method,
      }
    )
  }

  function getBrincaPaymentDraft(session: BrincaSession): { status: PaymentStatus; method: PaymentMethod } {
    return (
      brincaPaymentDrafts[session.id] ?? {
        status: session.payment_status,
        method: session.payment_method,
      }
    )
  }

  async function handleSaveMotoPayment(session: RideSession): Promise<void> {
    const draft = getMotoPaymentDraft(session)
    const method = draft.status === 'paid' ? draft.method : null
    if (draft.status === 'paid' && !method) {
      onError('Para marcar pagado debes elegir medio de pago (Efectivo o Nequi).')
      return
    }

    setSavingMotoPaymentId(session.id)
    try {
      await onSetSessionPayment(session.id, draft.status, method)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setSavingMotoPaymentId(null)
    }
  }

  async function handleSaveBrincaPayment(session: BrincaSession): Promise<void> {
    const draft = getBrincaPaymentDraft(session)
    const method = draft.status === 'paid' ? draft.method : null
    if (draft.status === 'paid' && !method) {
      onError('Para marcar pagado debes elegir medio de pago (Efectivo o Nequi).')
      return
    }

    setSavingBrincaPaymentId(session.id)
    try {
      await onSetBrincaPayment(session.id, draft.status, method)
    } catch (error) {
      onError(getErrorMessage(error))
    } finally {
      setSavingBrincaPaymentId(null)
    }
  }

  async function handleResetFinance(): Promise<void> {
    if (!canReset) {
      onError('Solo un admin puede reiniciar finanzas.')
      return
    }

    const confirmed = window.confirm(
      'Esto eliminara historial financiero cerrado de Motos, Brinca y Combos. Esta seguro?',
    )
    if (!confirmed) {
      return
    }

    try {
      await onResetFinance()
    } catch (error) {
      onError(getErrorMessage(error))
    }
  }

  return (
    <section className="panel">
      <header className="panel-header">
        <h2>Resumen financiero</h2>
        <p className="muted">Consolidado de motos + Brinca + combos para: {rangeLabel}.</p>
        <div className="finance-controls">
          <label>
            Corte
            <select value={rangeMode} onChange={(event) => onRangeModeChange(event.target.value as FinanceRangeMode)}>
              <option value="today">Hoy</option>
              <option value="day">Dia</option>
              <option value="month">Mes</option>
              <option value="range">Rango</option>
            </select>
          </label>
          {rangeMode === 'day' ? (
            <label>
              Dia
              <input
                type="date"
                value={selectedDay}
                onChange={(event) => {
                  if (event.target.value) {
                    onDayChange(event.target.value)
                  }
                }}
              />
            </label>
          ) : null}
          {rangeMode === 'month' ? (
            <label>
              Mes
              <input
                type="month"
                value={selectedMonth}
                onChange={(event) => {
                  if (event.target.value) {
                    onMonthChange(event.target.value)
                  }
                }}
              />
            </label>
          ) : null}
          {rangeMode === 'range' ? (
            <>
              <label>
                Desde
                <input
                  type="date"
                  value={rangeStartDay}
                  onChange={(event) => {
                    if (event.target.value) {
                      onRangeStartDayChange(event.target.value)
                    }
                  }}
                />
              </label>
              <label>
                Hasta
                <input
                  type="date"
                  value={rangeEndDay}
                  onChange={(event) => {
                    if (event.target.value) {
                      onRangeEndDayChange(event.target.value)
                    }
                  }}
                />
              </label>
              <label>
                Ultimos meses
                <input
                  type="number"
                  min={1}
                  max={24}
                  step={1}
                  value={rangeMonthsBack}
                  onChange={(event) => {
                    const nextValue = Number(event.target.value)
                    onRangeMonthsBackChange(Number.isFinite(nextValue) ? nextValue : 1)
                  }}
                />
              </label>
              <button type="button" className="secondary" onClick={onApplyLastMonths}>
                Aplicar X meses
              </button>
            </>
          ) : null}
          <button type="button" className="secondary" onClick={onExportCsv}>
            Descargar CSV
          </button>
          <button type="button" className="danger" disabled={!canReset} onClick={() => void handleResetFinance()}>
            Reiniciar finanzas
          </button>
        </div>
      </header>

      <section className="summary-grid finance finance-block finance-block-motos">
        <article className="summary-card">
          <span>Sesiones motos</span>
          <strong>{total?.session_count ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span>Minutos motos</span>
          <strong>{total?.minutes_total ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span>Total motos</span>
          <strong>{formatCurrencyCop(total?.amount_total_cop ?? 0)}</strong>
        </article>
      </section>

      <section className="summary-grid finance finance-block finance-block-brinca">
        <article className="summary-card">
          <span>Sesiones brinca</span>
          <strong>{brincaTotal?.session_count ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span>Minutos brinca</span>
          <strong>{brincaTotal?.minutes_total ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span>Total brinca</span>
          <strong>{formatCurrencyCop(brincaTotal?.amount_total_cop ?? 0)}</strong>
        </article>
      </section>

      <section className="summary-grid finance finance-block finance-block-combos">
        <article className="summary-card">
          <span>Combos cobrados</span>
          <strong>{comboFinance?.combo_count ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span>Sesiones de combo</span>
          <strong>{comboFinance?.session_count ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span>Ingresos combos</span>
          <strong>{formatCurrencyCop(comboFinance?.amount_total_cop ?? 0)}</strong>
        </article>
      </section>

      <section className="summary-grid finance finance-block">
        <article className="summary-card">
          <span>Sesiones global</span>
          <strong>{globalSessionCount}</strong>
        </article>
        <article className="summary-card">
          <span>Minutos global</span>
          <strong>{globalMinutes}</strong>
        </article>
        <article className="summary-card">
          <span>Total global</span>
          <strong>{formatCurrencyCop(globalAmountCop)}</strong>
        </article>
      </section>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cuatrimoto</th>
              <th>Sesiones</th>
              <th>Minutos</th>
              <th>Total COP</th>
            </tr>
          </thead>
          <tbody>
            {byAtv.map((row) => (
              <tr key={row.atv_id}>
                <td>{row.atv_name}</td>
                <td>{row.session_count}</td>
                <td>{row.minutes_total}</td>
                <td>{formatCurrencyCop(row.amount_total_cop)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Ultimas sesiones cerradas</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Moto</th>
              <th>Inicio</th>
              <th>Fin</th>
              <th>Minutos</th>
              <th>Valor</th>
              <th>Estado</th>
              <th>Estado pago</th>
              <th>Medio</th>
              <th>Accion</th>
            </tr>
          </thead>
          <tbody>
            {recentSessions.length === 0 ? (
              <tr>
                <td colSpan={10}>No hay sesiones cerradas en este periodo.</td>
              </tr>
            ) : (
              recentSessions.map((session) => {
                const draft = getMotoPaymentDraft(session)
                const isCancelled = session.status === 'cancelled'
                return (
                  <tr key={session.id}>
                    <td>{shortTransactionId(session.id)}</td>
                    <td>{getAtvName(session.atv_id)}</td>
                    <td>{formatDateTime(session.started_at)}</td>
                    <td>{formatDateTime(session.ended_at)}</td>
                    <td>{session.minutes_billed ?? 0}</td>
                    <td>{formatCurrencyCop(session.amount_cop ?? 0)}</td>
                    <td>
                      <span className={`badge ${isCancelled ? 'inactive' : 'finished'}`}>
                        {closedStatusLabel(session.status)}
                      </span>
                    </td>
                    <td>
                      <select
                        value={draft.status}
                        disabled={isCancelled}
                        onChange={(event) => {
                          const status = event.target.value as PaymentStatus
                          setMotoPaymentDrafts((current) => ({
                            ...current,
                            [session.id]: {
                              status,
                              method: status === 'pending' ? null : current[session.id]?.method ?? session.payment_method ?? 'cash',
                            },
                          }))
                        }}
                      >
                        <option value="pending">Pendiente</option>
                        <option value="paid">Pagado</option>
                      </select>
                    </td>
                    <td>
                      <select
                        value={draft.method ?? ''}
                        disabled={isCancelled || draft.status !== 'paid'}
                        onChange={(event) => {
                          const value = event.target.value as 'cash' | 'nequi' | ''
                          setMotoPaymentDrafts((current) => ({
                            ...current,
                            [session.id]: {
                              status: draft.status,
                              method: value ? value : null,
                            },
                          }))
                        }}
                      >
                        <option value="">Seleccionar</option>
                        <option value="cash">Efectivo</option>
                        <option value="nequi">Nequi</option>
                      </select>
                    </td>
                    <td>
                      {isCancelled ? (
                        <span className="muted">No aplica</span>
                      ) : (
                        <button
                          type="button"
                          className="secondary"
                          disabled={savingMotoPaymentId === session.id}
                          onClick={() => void handleSaveMotoPayment(session)}
                        >
                          {savingMotoPaymentId === session.id ? 'Guardando...' : 'Guardar'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <h3>Ultimas sesiones Brinca cerradas</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>Nino</th>
              <th>Inicio</th>
              <th>Fin</th>
              <th>Minutos</th>
              <th>Valor</th>
              <th>Estado</th>
              <th>Estado pago</th>
              <th>Medio</th>
              <th>Accion</th>
            </tr>
          </thead>
          <tbody>
            {brincaRecentSessions.length === 0 ? (
              <tr>
                <td colSpan={10}>No hay sesiones Brinca cerradas en este periodo.</td>
              </tr>
            ) : (
              brincaRecentSessions.map((session) => {
                const draft = getBrincaPaymentDraft(session)
                const isCancelled = session.status === 'cancelled'
                return (
                  <tr key={session.id}>
                    <td>{shortTransactionId(session.id)}</td>
                    <td>{session.child_name}</td>
                    <td>{formatDateTime(session.started_at)}</td>
                    <td>{formatDateTime(session.ended_at)}</td>
                    <td>{session.minutes_billed ?? 0}</td>
                    <td>{formatCurrencyCop(session.amount_cop ?? 0)}</td>
                    <td>
                      <span className={`badge ${isCancelled ? 'inactive' : 'finished'}`}>
                        {closedStatusLabel(session.status)}
                      </span>
                    </td>
                    <td>
                      <select
                        value={draft.status}
                        disabled={isCancelled}
                        onChange={(event) => {
                          const status = event.target.value as PaymentStatus
                          setBrincaPaymentDrafts((current) => ({
                            ...current,
                            [session.id]: {
                              status,
                              method: status === 'pending' ? null : current[session.id]?.method ?? session.payment_method ?? 'cash',
                            },
                          }))
                        }}
                      >
                        <option value="pending">Pendiente</option>
                        <option value="paid">Pagado</option>
                      </select>
                    </td>
                    <td>
                      <select
                        value={draft.method ?? ''}
                        disabled={isCancelled || draft.status !== 'paid'}
                        onChange={(event) => {
                          const value = event.target.value as 'cash' | 'nequi' | ''
                          setBrincaPaymentDrafts((current) => ({
                            ...current,
                            [session.id]: {
                              status: draft.status,
                              method: value ? value : null,
                            },
                          }))
                        }}
                      >
                        <option value="">Seleccionar</option>
                        <option value="cash">Efectivo</option>
                        <option value="nequi">Nequi</option>
                      </select>
                    </td>
                    <td>
                      {isCancelled ? (
                        <span className="muted">No aplica</span>
                      ) : (
                        <button
                          type="button"
                          className="secondary"
                          disabled={savingBrincaPaymentId === session.id}
                          onClick={() => void handleSaveBrincaPayment(session)}
                        >
                          {savingBrincaPaymentId === session.id ? 'Guardando...' : 'Guardar'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default App
