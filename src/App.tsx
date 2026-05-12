import type { FormEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import {
  cancelCombo,
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
  Profile,
  RideSession,
} from './types/domain'

function monthRangeFromKey(monthKey: string): { startIso: string; endIso: string } {
  const [yearStr, monthStr] = monthKey.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)

  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    const now = new Date()
    const fallback = monthKeyFromDate(now)
    return monthRangeFromKey(fallback)
  }

  const nextMonthYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1

  // Rango mensual alineado a America/Bogota (UTC-5) para que cierre contable coincida con la operacion local.
  const start = new Date(`${yearStr}-${monthStr.padStart(2, '0')}-01T00:00:00-05:00`)
  const end = new Date(
    `${String(nextMonthYear)}-${String(nextMonth).padStart(2, '0')}-01T00:00:00-05:00`,
  )

  return { startIso: start.toISOString(), endIso: end.toISOString() }
}

function monthKeyFromDate(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  return `${year}-${month}`
}

function monthLabelFromKey(monthKey: string): string {
  const [yearStr, monthStr] = monthKey.split('-')
  const year = Number(yearStr)
  const month = Number(monthStr)
  const date = new Date(Date.UTC(year, month - 1, 1))

  return new Intl.DateTimeFormat('es-CO', { month: 'long', year: 'numeric' }).format(date)
}

type Tab = 'operations' | 'brinca' | 'combos' | 'atvs' | 'finance'
type ToastType = 'error' | 'success'
const RECENT_FINISH_SIGNAL_MS = 15 * 60 * 1000

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

async function playExpirySound(): Promise<void> {
  const webkitWindow = window as Window & { webkitAudioContext?: typeof AudioContext }
  const AudioContextCtor = window.AudioContext ?? webkitWindow.webkitAudioContext
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
  const [selectedMonth, setSelectedMonth] = useState(() => monthKeyFromDate(new Date()))

  const [tickMs, setTickMs] = useState(() => Date.now())
  const notifiedExpiryRef = useRef<Set<string>>(new Set())
  const notifiedBrincaExpiryRef = useRef<Set<string>>(new Set())
  const autoClosingRef = useRef<Set<string>>(new Set())
  const autoClosingBrincaRef = useRef<Set<string>>(new Set())

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
  const { startIso: monthStartIso, endIso: monthEndIso } = useMemo(
    () => monthRangeFromKey(selectedMonth),
    [selectedMonth],
  )
  const selectedMonthLabel = useMemo(() => monthLabelFromKey(selectedMonth), [selectedMonth])

  const notify = useCallback((type: ToastType, message: string) => {
    setToast({ type, message })
  }, [])

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
        closedSessionsRecent,
        nextBrincaSettings,
        nextBrincaOpenSessions,
        nextBrincaCompletedSessions,
        nextCombos,
      ] =
        await Promise.all([
          fetchMyProfile(userId),
          fetchAtvs(),
          fetchOpenSessions(),
          fetchCompletedSessionsByRange(monthStartIso, monthEndIso),
          fetchRecentSessions(200),
          fetchBrincaSettings(),
          fetchOpenBrincaSessions(),
          fetchCompletedBrincaSessionsByRange(monthStartIso, monthEndIso),
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
      setBrincaRecentSessions(nextBrincaCompletedSessions.slice(0, 80))
      setBrincaFinanceTotal(brincaTotal)
      setComboFinanceTotal(comboTotal)
      setCombos(nextCombos)
      setRecentSessions(completedSessions.slice(0, 60))
      setFinanceByAtv(byAtv)
      setFinanceTotal(total)
    } catch (error) {
      notify('error', getErrorMessage(error))
    } finally {
      setLoading(false)
    }
  }, [monthEndIso, monthStartIso, notify, userId])

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
      void playExpirySound().catch(() => {
        window.setTimeout(() => {
          notify('error', 'No se pudo reproducir el sonido de alerta en este navegador.')
        }, 0)
      })
    }
  }, [openSessions, atvs, tickMs, notify])

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
      void playExpirySound().catch(() => {
        window.setTimeout(() => {
          notify('error', 'No se pudo reproducir el sonido de alerta en este navegador.')
        }, 0)
      })
    }
  }, [brincaOpenSessions, tickMs, notify])

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
      await startSession(atvId, durationMinutes)
      notify('success', 'Tiempo iniciado')
      await loadData()
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
      await startBrincaSession({ childName, durationMinutes })
      notify('success', 'Sesion de Brinca iniciada')
      await loadData()
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
    async (comboId: string) => {
      await cancelCombo(comboId)
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

  const handleExportFinanceCsv = useCallback(() => {
    downloadFinanceCsv({
      monthKey: selectedMonth,
      monthLabel: selectedMonthLabel,
      byAtv: financeByAtv,
      total: financeTotal,
      recentSessions,
      brincaTotal: brincaFinanceTotal,
      brincaRecentSessions,
      comboFinance: comboFinanceTotal,
      atvs,
    })
    notify('success', `Reporte CSV descargado (${selectedMonthLabel}).`)
  }, [
    atvs,
    brincaFinanceTotal,
    brincaRecentSessions,
    comboFinanceTotal,
    financeByAtv,
    financeTotal,
    notify,
    recentSessions,
    selectedMonth,
    selectedMonthLabel,
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
          <p className="brand">CuatriGo MVP</p>
          <h1>Operacion diaria</h1>
          <p className="muted">
            Usuario: {user.email ?? user.id} | Rol: {profile?.role ?? 'cargando...'}
          </p>
        </div>

        <div className="topbar-actions">
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
          monthKey={selectedMonth}
          monthLabel={selectedMonthLabel}
          onMonthChange={setSelectedMonth}
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
  onStartSession: (atvId: string, durationMinutes: number) => Promise<void>
  onStopSession: (sessionId: string) => Promise<void>
  onPauseSession: (sessionId: string) => Promise<void>
  onResumeSession: (sessionId: string) => Promise<void>
  onRestartSession: (sessionId: string, durationMinutes: number) => Promise<void>
  onExtendSession: (sessionId: string, extraMinutes: number) => Promise<void>
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
  } = props
  const [startingFor, setStartingFor] = useState<string | null>(null)
  const [durationByAtv, setDurationByAtv] = useState<Record<string, number>>({})

  async function handleStart(atv: Atv): Promise<void> {
    const duration = Math.max(1, Math.floor(durationByAtv[atv.id] ?? atv.base_minutes))
    setStartingFor(atv.id)
    try {
      await onStartSession(atv.id, duration)
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

          const availabilityLabel = !atv.active
            ? 'Fuera de servicio'
            : isExpired
              ? 'Cerrando...'
              : isRecentlyFinished
                ? 'Tiempo finalizado'
                : isRunning
                  ? 'En uso'
                  : isPaused
                    ? 'Pausada'
                    : 'Disponible'

          const availabilityClass = !atv.active
            ? 'inactive'
            : isExpired
              ? 'paused'
              : isRecentlyFinished
                ? 'finished'
                : isRunning
                  ? 'busy'
                  : isPaused
                    ? 'paused'
                    : 'ok'

          return (
            <article key={atv.id} className={`atv-card ${isExpired ? 'expired' : ''} ${isRecentlyFinished ? 'recent-finished' : ''}`}>
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
                  <p className="meta">Inicio: {formatDateTime(openSession.started_at)}</p>
                  <p className="meta">Fin objetivo: {formatDateTime(openSession.target_end_at)}</p>
                  {isPaused ? <p className="meta">Pausa desde: {formatDateTime(openSession.paused_at)}</p> : null}
                  <p className={`clock ${isExpired ? 'danger-text' : ''}`}>
                    {isExpired ? 'Vencido' : isPaused ? 'Tiempo restante (pausado)' : 'Tiempo restante'}:{' '}
                    {formatRemainingClock(remainingMs)}
                  </p>
                  {isComboSession ? <p className="meta">Sesion de combo: no permite agregar tiempo.</p> : null}
                  {isExpired ? <p className="meta danger-text">Vencido {formatTimeAgo(openSession.target_end_at, tickMs)}.</p> : null}

                  <div className="button-row">
                    {isRunning ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={startingFor === openSession.id || isExpired}
                        onClick={() => void handlePause(openSession.id)}
                      >
                        Pausar
                      </button>
                    ) : null}
                    {isPaused ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={startingFor === openSession.id || isExpired}
                        onClick={() => void handleResume(openSession.id)}
                      >
                        Reanudar
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="secondary"
                      disabled={startingFor === openSession.id || isExpired || isComboSession}
                      onClick={() => void handleExtend(openSession.id)}
                    >
                      + Minutos
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={startingFor === openSession.id || isExpired}
                      onClick={() => void handleRestart(openSession.id, atv.base_minutes)}
                    >
                      Reiniciar
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={startingFor === openSession.id || isExpired}
                      onClick={() => void handleStop(openSession.id)}
                    >
                      Detener
                    </button>
                  </div>
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

                  <button
                    type="button"
                    disabled={!atv.active || startingFor === atv.id}
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
  onStartSession: (childName: string, durationMinutes: number) => Promise<void>
  onPauseSession: (sessionId: string) => Promise<void>
  onResumeSession: (sessionId: string) => Promise<void>
  onExtendSession: (sessionId: string, extraMinutes: number) => Promise<void>
  onStopSession: (sessionId: string) => Promise<void>
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
    onError,
  } = props

  const [childName, setChildName] = useState('')
  const [durationMinutes, setDurationMinutes] = useState(15)
  const [baseMinutesDraft, setBaseMinutesDraft] = useState<number | null>(null)
  const [basePriceDraft, setBasePriceDraft] = useState<number | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [busySessionId, setBusySessionId] = useState<string | null>(null)
  const [startingSession, setStartingSession] = useState(false)

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

    setStartingSession(true)
    try {
      await onStartSession(name, duration)
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

                <p className="meta">Inicio: {formatDateTime(session.started_at)}</p>
                <p className="meta">Fin objetivo: {formatDateTime(session.target_end_at)}</p>
                <p className="meta">
                  Tarifa aplicada: {formatMinutes(session.base_minutes)} = {formatCurrencyCop(session.base_price_cop)}
                </p>
                <p className={`clock ${isExpired ? 'danger-text' : ''}`}>
                  {isExpired ? 'Vencido' : isPaused ? 'Tiempo restante (pausado)' : 'Tiempo restante'}:{' '}
                  {formatRemainingClock(remainingMs)}
                </p>
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
  onCancelCombo: (comboId: string) => Promise<void>
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
    const confirmed = window.confirm('Seguro que deseas cancelar este combo?')
    if (!confirmed) {
      return
    }

    setBusyComboId(comboId)
    try {
      await onCancelCombo(comboId)
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
        {combos.length === 0 ? (
          <article className="atv-card">
            <p className="meta">Todavia no hay combos creados.</p>
          </article>
        ) : (
          combos.map((combo) => {
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
  monthKey: string
  monthLabel: string
  onMonthChange: (value: string) => void
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
    monthKey,
    monthLabel,
    onMonthChange,
    onExportCsv,
    onResetFinance,
    onError,
  } = props
  const globalSessionCount = (total?.session_count ?? 0) + (brincaTotal?.session_count ?? 0)
  const globalMinutes = (total?.minutes_total ?? 0) + (brincaTotal?.minutes_total ?? 0)
  const globalAmountCop = (total?.amount_total_cop ?? 0) + (brincaTotal?.amount_total_cop ?? 0)

  function getAtvName(atvId: string): string {
    return atvs.find((item) => item.id === atvId)?.name ?? atvId
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
        <h2>Resumen financiero por mes</h2>
        <p className="muted">Consolidado de motos + Brinca y total global de {monthLabel}.</p>
        <div className="finance-controls">
          <label>
            Mes
            <input
              type="month"
              value={monthKey}
              onChange={(event) => {
                if (event.target.value) {
                  onMonthChange(event.target.value)
                }
              }}
            />
          </label>
          <button type="button" className="secondary" onClick={onExportCsv}>
            Descargar CSV
          </button>
          <button type="button" className="danger" disabled={!canReset} onClick={() => void handleResetFinance()}>
            Reiniciar finanzas
          </button>
        </div>
      </header>

      <section className="summary-grid finance">
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

      <section className="summary-grid finance">
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

      <section className="summary-grid finance">
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

      <section className="summary-grid finance">
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
              <th>Moto</th>
              <th>Inicio</th>
              <th>Fin</th>
              <th>Minutos</th>
              <th>Valor</th>
            </tr>
          </thead>
          <tbody>
            {recentSessions.length === 0 ? (
              <tr>
                <td colSpan={5}>No hay sesiones cerradas en este mes.</td>
              </tr>
            ) : (
              recentSessions.map((session) => (
                <tr key={session.id}>
                  <td>{getAtvName(session.atv_id)}</td>
                  <td>{formatDateTime(session.started_at)}</td>
                  <td>{formatDateTime(session.ended_at)}</td>
                  <td>{session.minutes_billed ?? 0}</td>
                  <td>{formatCurrencyCop(session.amount_cop ?? 0)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <h3>Ultimas sesiones Brinca cerradas</h3>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Nino</th>
              <th>Inicio</th>
              <th>Fin</th>
              <th>Minutos</th>
              <th>Valor</th>
            </tr>
          </thead>
          <tbody>
            {brincaRecentSessions.length === 0 ? (
              <tr>
                <td colSpan={5}>No hay sesiones Brinca cerradas en este mes.</td>
              </tr>
            ) : (
              brincaRecentSessions.map((session) => (
                <tr key={session.id}>
                  <td>{session.child_name}</td>
                  <td>{formatDateTime(session.started_at)}</td>
                  <td>{formatDateTime(session.ended_at)}</td>
                  <td>{session.minutes_billed ?? 0}</td>
                  <td>{formatCurrencyCop(session.amount_cop ?? 0)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default App
