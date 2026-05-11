import type { FormEvent, ReactElement } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import {
  computeFinance,
  createAtv,
  deleteAtv,
  extendSession,
  fetchAtvs,
  fetchCompletedSessionsByRange,
  fetchMyProfile,
  fetchOpenSessions,
  fetchRecentSessions,
  pauseSession,
  refreshExpiredSessions,
  resetFinanceData,
  restartSession,
  resumeSession,
  startSession,
  stopSession,
  toggleAtvActive,
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
import { supabase } from './lib/supabase'
import type { Atv, FinanceByAtvRow, FinanceTotalRow, Profile, RideSession } from './types/domain'

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

type Tab = 'operations' | 'atvs' | 'finance'
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

async function maybeNotifyExpiry(atvName: string): Promise<void> {
  if (!('Notification' in window)) {
    return
  }

  if (Notification.permission === 'granted') {
    new Notification('Tiempo finalizado', {
      body: `La cuatrimoto ${atvName} ya supero su tiempo de uso.`,
    })
    return
  }

  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission()
    if (permission === 'granted') {
      new Notification('Tiempo finalizado', {
        body: `La cuatrimoto ${atvName} ya supero su tiempo de uso.`,
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
  const scheduleTone = (frequency: number, offsetSeconds: number): void => {
    const oscillator = context.createOscillator()
    const gain = context.createGain()
    oscillator.type = 'square'
    oscillator.frequency.setValueAtTime(frequency, now + offsetSeconds)

    gain.gain.setValueAtTime(0.0001, now + offsetSeconds)
    gain.gain.exponentialRampToValueAtTime(0.22, now + offsetSeconds + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offsetSeconds + 0.22)

    oscillator.connect(gain)
    gain.connect(context.destination)

    oscillator.start(now + offsetSeconds)
    oscillator.stop(now + offsetSeconds + 0.24)
  }

  scheduleTone(820, 0)
  scheduleTone(620, 0.28)
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
  const [recentSessions, setRecentSessions] = useState<RideSession[]>([])
  const [financeByAtv, setFinanceByAtv] = useState<FinanceByAtvRow[]>([])
  const [financeTotal, setFinanceTotal] = useState<FinanceTotalRow | null>(null)
  const [selectedMonth, setSelectedMonth] = useState(() => monthKeyFromDate(new Date()))

  const [tickMs, setTickMs] = useState(() => Date.now())
  const notifiedExpiryRef = useRef<Set<string>>(new Set())
  const autoClosingRef = useRef<Set<string>>(new Set())

  const userId = user?.id ?? null
  const isAdmin = profile?.role === 'admin'

  const openSessionByAtv = useMemo(() => {
    return new Map(openSessions.map((session) => [session.atv_id, session]))
  }, [openSessions])

  const activeAtvCount = openSessions.filter((session) => session.status === 'active').length
  const inactiveAtvCount = atvs.filter((atv) => !atv.active).length
  const { startIso: monthStartIso, endIso: monthEndIso } = useMemo(
    () => monthRangeFromKey(selectedMonth),
    [selectedMonth],
  )

  const notify = useCallback((type: ToastType, message: string) => {
    setToast({ type, message })
  }, [])

  const clearDashboardState = useCallback(() => {
    setProfile(null)
    setAtvs([])
    setOpenSessions([])
    setLastClosedSessionByAtv({})
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
      const [nextProfile, nextAtvs, nextOpenSessions, completedSessions, closedSessionsRecent] =
        await Promise.all([
          fetchMyProfile(userId),
          fetchAtvs(),
          fetchOpenSessions(),
          fetchCompletedSessionsByRange(monthStartIso, monthEndIso),
          fetchRecentSessions(200),
        ])

      const { byAtv, total } = computeFinance(nextAtvs, completedSessions)
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
      void maybeNotifyExpiry(atvName)
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
    async (input: { name: string; plate?: string; colorHex?: string; baseMinutes: number; basePriceCop: number }) => {
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

  const handleResetFinance = useCallback(async () => {
    const deleted = await resetFinanceData()
    notify('success', `Finanzas reiniciadas. Sesiones eliminadas: ${deleted}`)
    await loadData()
  }, [loadData, notify])

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
          <span>Motos inactivas</span>
          <strong>{inactiveAtvCount}</strong>
        </article>
        <article className="summary-card">
          <span>Total del mes</span>
          <strong>{formatCurrencyCop(financeTotal?.amount_total_cop ?? 0)}</strong>
        </article>
      </section>

      <nav className="tabs" aria-label="Secciones de trabajo">
        <button type="button" className={tab === 'operations' ? 'active' : ''} onClick={() => setTab('operations')}>
          Operacion
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
          tickMs={tickMs}
          onStartSession={handleStartSession}
          onStopSession={handleStopSession}
          onPauseSession={handlePauseSession}
          onResumeSession={handleResumeSession}
          onRestartSession={handleRestartSession}
          onExtendSession={handleExtendSession}
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

      {tab === 'finance' ? (
        <FinanceTab
          byAtv={financeByAtv}
          total={financeTotal}
          recentSessions={recentSessions}
          atvs={atvs}
          canReset={isAdmin}
          monthKey={selectedMonth}
          monthLabel={monthLabelFromKey(selectedMonth)}
          onMonthChange={setSelectedMonth}
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
                <span className="atv-image-tint" style={{ backgroundColor: atvColor }} aria-hidden="true" />
              </div>

              <p className="meta">Placa: {atv.plate ?? 'sin placa'}</p>
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
                      disabled={startingFor === openSession.id || isExpired}
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

function AtvAdminTab(props: {
  atvs: Atv[]
  canEdit: boolean
  onAddAtv: (input: { name: string; plate?: string; colorHex?: string; baseMinutes: number; basePriceCop: number }) => Promise<void>
  onUpdateRates: (atvId: string, input: { baseMinutes: number; basePriceCop: number; colorHex?: string }) => Promise<void>
  onToggleActive: (atvId: string, active: boolean) => Promise<void>
  onDeleteAtv: (atvId: string) => Promise<void>
  onError: (message: string) => void
}): ReactElement {
  const { atvs, canEdit, onAddAtv, onUpdateRates, onToggleActive, onDeleteAtv, onError } = props
  const [name, setName] = useState('')
  const [plate, setPlate] = useState('')
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

    setSaving(true)
    try {
      await onAddAtv({
        name,
        plate,
        colorHex,
        baseMinutes,
        basePriceCop,
      })
      setName('')
      setPlate('')
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
        basePriceCop: Math.max(1, Math.floor(draft.basePriceCop)),
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
          Placa
          <input value={plate} onChange={(event) => setPlate(event.target.value)} placeholder="ABC123" />
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
            min={1}
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
              <th>Placa</th>
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
              return (
                <tr key={atv.id}>
                  <td>{atv.name}</td>
                  <td>{atv.plate ?? '-'}</td>
                  <td>
                    <input
                      type="color"
                      value={draft?.colorHex ?? atv.color_hex ?? '#3b82f6'}
                      disabled={!canEdit}
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
                      min={1}
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
  atvs: Atv[]
  canReset: boolean
  monthKey: string
  monthLabel: string
  onMonthChange: (value: string) => void
  onResetFinance: () => Promise<void>
  onError: (message: string) => void
}): ReactElement {
  const { byAtv, total, recentSessions, atvs, canReset, monthKey, monthLabel, onMonthChange, onResetFinance, onError } = props

  function getAtvName(atvId: string): string {
    return atvs.find((item) => item.id === atvId)?.name ?? atvId
  }

  async function handleResetFinance(): Promise<void> {
    if (!canReset) {
      onError('Solo un admin puede reiniciar finanzas.')
      return
    }

    const confirmed = window.confirm(
      'Esto eliminara sesiones cerradas y sus cobros historicos para reiniciar finanzas. Esta seguro?',
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
        <p className="muted">Consolidado por moto y total global de {monthLabel}.</p>
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
          <button type="button" className="danger" disabled={!canReset} onClick={() => void handleResetFinance()}>
            Reiniciar finanzas
          </button>
        </div>
      </header>

      <section className="summary-grid finance">
        <article className="summary-card">
          <span>Sesiones</span>
          <strong>{total?.session_count ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span>Minutos cobrados</span>
          <strong>{total?.minutes_total ?? 0}</strong>
        </article>
        <article className="summary-card">
          <span>Total facturado</span>
          <strong>{formatCurrencyCop(total?.amount_total_cop ?? 0)}</strong>
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
    </section>
  )
}

export default App
