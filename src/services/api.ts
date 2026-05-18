import { supabase } from '../lib/supabase'
import type {
  Atv,
  BrincaSession,
  BrincaSettings,
  Combo,
  ComboFinanceRow,
  ComboFinanceSummary,
  FinanceByAtvRow,
  FinanceTotalRow,
  Profile,
  RideSession,
} from '../types/domain'

const profileColumns = 'id,email,role,created_at,updated_at'
const atvColumns = 'id,name,plate,active,color_hex,base_minutes,base_price_cop,created_at,updated_at'
const sessionColumns =
  'id,atv_id,started_by,started_at,target_end_at,paused_at,ended_at,status,payment_status,payment_method,minutes_billed,amount_cop,created_at,updated_at'
const brincaSettingsColumns = 'id,base_minutes,base_price_cop,created_at,updated_at'
const brincaSessionColumns =
  'id,child_name,started_by,started_at,target_end_at,paused_at,ended_at,status,payment_status,payment_method,base_minutes,base_price_cop,minutes_billed,amount_cop,created_at,updated_at'
const comboColumns =
  'id,child_name,start_mode,status,atv_id,moto_duration_minutes,brinca_duration_minutes,moto_session_id,brinca_session_id,moto_completed_at,brinca_completed_at,completed_at,started_by,created_at,updated_at'

export async function fetchMyProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select(profileColumns)
    .eq('id', userId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return (data as Profile | null) ?? null
}

export async function fetchAtvs(): Promise<Atv[]> {
  const { data, error } = await supabase.from('atvs').select(atvColumns).is('deleted_at', null).order('name')

  if (error) {
    throw error
  }

  return (data ?? []) as Atv[]
}

export async function createAtv(input: {
  name: string
  colorHex?: string
  baseMinutes: number
  basePriceCop: number
}): Promise<Atv> {
  const { data, error } = await supabase
    .from('atvs')
    .insert({
      name: input.name,
      color_hex: input.colorHex ?? '#3b82f6',
      base_minutes: input.baseMinutes,
      base_price_cop: input.basePriceCop,
      active: true,
    })
    .select(atvColumns)
    .single()

  if (error) {
    throw error
  }

  return data as Atv
}

export async function updateAtvRates(
  atvId: string,
  input: { baseMinutes: number; basePriceCop: number; colorHex?: string },
): Promise<void> {
  const payload: { base_minutes: number; base_price_cop: number; color_hex?: string } = {
    base_minutes: input.baseMinutes,
    base_price_cop: input.basePriceCop,
  }

  if (input.colorHex) {
    payload.color_hex = input.colorHex
  }

  const { error } = await supabase
    .from('atvs')
    .update(payload)
    .eq('id', atvId)

  if (error) {
    throw error
  }
}

export async function toggleAtvActive(atvId: string, active: boolean): Promise<void> {
  const { error } = await supabase.from('atvs').update({ active }).eq('id', atvId)

  if (error) {
    throw error
  }
}

export async function deleteAtv(atvId: string): Promise<void> {
  const { error } = await supabase.rpc('delete_atv', {
    p_atv_id: atvId,
  })

  if (error) {
    throw error
  }
}

export async function fetchOpenSessions(): Promise<RideSession[]> {
  const { data, error } = await supabase
    .from('sessions')
    .select(sessionColumns)
    .in('status', ['active', 'paused'])
    .order('started_at', { ascending: false })

  if (error) {
    throw error
  }

  return (data ?? []) as RideSession[]
}

export async function fetchRecentSessions(limit = 20): Promise<RideSession[]> {
  const { data, error } = await supabase
    .from('sessions')
    .select(sessionColumns)
    .in('status', ['completed', 'cancelled'])
    .order('ended_at', { ascending: false, nullsFirst: false })
    .limit(limit)

  if (error) {
    throw error
  }

  return (data ?? []) as RideSession[]
}

export async function startSession(atvId: string, durationMinutes: number): Promise<string> {
  const { data, error } = await supabase.rpc('start_session', {
    p_atv_id: atvId,
    p_duration_minutes: durationMinutes,
  })

  if (error) {
    throw error
  }

  return String(data)
}

export async function stopSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('stop_session', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }
}

export async function cancelSession(sessionId: string, annulKey: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_session', {
    p_session_id: sessionId,
    p_annul_key: annulKey,
  })

  if (error) {
    throw error
  }
}

export async function setSessionPayment(
  sessionId: string,
  paymentStatus: 'pending' | 'paid',
  paymentMethod: 'cash' | 'nequi' | null,
): Promise<void> {
  const { error } = await supabase.rpc('set_session_payment', {
    p_session_id: sessionId,
    p_payment_status: paymentStatus,
    p_payment_method: paymentMethod,
  })

  if (error) {
    throw error
  }
}

export async function refreshExpiredSessions(): Promise<number> {
  const { data, error } = await supabase.rpc('refresh_expired_sessions')

  if (error) {
    throw error
  }

  return Number(data ?? 0)
}

export async function pauseSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('pause_session', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }
}

export async function resumeSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('resume_session', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }
}

export async function restartSession(sessionId: string, durationMinutes: number): Promise<void> {
  const { error } = await supabase.rpc('restart_session', {
    p_session_id: sessionId,
    p_duration_minutes: durationMinutes,
  })

  if (error) {
    throw error
  }
}

export async function extendSession(sessionId: string, extraMinutes: number): Promise<void> {
  const { error } = await supabase.rpc('extend_session', {
    p_session_id: sessionId,
    p_extra_minutes: extraMinutes,
  })

  if (error) {
    throw error
  }
}

export async function fetchCompletedSessionsByRange(startIso: string, endIso: string): Promise<RideSession[]> {
  const { data, error } = await supabase
    .from('sessions')
    .select(sessionColumns)
    .eq('status', 'completed')
    .gte('ended_at', startIso)
    .lt('ended_at', endIso)
    .order('ended_at', { ascending: false, nullsFirst: false })

  if (error) {
    throw error
  }

  return (data ?? []) as RideSession[]
}

export async function fetchClosedSessionsByRange(startIso: string, endIso: string): Promise<RideSession[]> {
  const { data, error } = await supabase
    .from('sessions')
    .select(sessionColumns)
    .in('status', ['completed', 'cancelled'])
    .gte('ended_at', startIso)
    .lt('ended_at', endIso)
    .order('ended_at', { ascending: false, nullsFirst: false })

  if (error) {
    throw error
  }

  return (data ?? []) as RideSession[]
}

export function computeFinance(
  atvs: Atv[],
  completedSessions: RideSession[],
): { byAtv: FinanceByAtvRow[]; total: FinanceTotalRow } {
  const atvById = new Map(atvs.map((atv) => [atv.id, atv]))
  const byAtvMap = new Map<string, FinanceByAtvRow>()

  for (const atv of atvs) {
    byAtvMap.set(atv.id, {
      atv_id: atv.id,
      atv_name: atv.name,
      session_count: 0,
      minutes_total: 0,
      amount_total_cop: 0,
    })
  }

  let totalSessions = 0
  let totalMinutes = 0
  let totalAmount = 0

  for (const session of completedSessions) {
    const atv = atvById.get(session.atv_id)
    if (!atv) {
      continue
    }

    const row = byAtvMap.get(session.atv_id)
    if (!row) {
      continue
    }

    const minutes = session.minutes_billed ?? 0
    const amount = session.amount_cop ?? 0

    row.session_count += 1
    row.minutes_total += minutes
    row.amount_total_cop += amount

    totalSessions += 1
    totalMinutes += minutes
    totalAmount += amount
  }

  const byAtv = Array.from(byAtvMap.values()).sort((a, b) => a.atv_name.localeCompare(b.atv_name))
  const total: FinanceTotalRow = {
    session_count: totalSessions,
    minutes_total: totalMinutes,
    amount_total_cop: totalAmount,
  }

  return { byAtv, total }
}

export async function resetFinanceData(): Promise<number> {
  const { data, error } = await supabase.rpc('reset_finance_data')

  if (error) {
    throw error
  }

  return Number(data ?? 0)
}

export async function fetchBrincaSettings(): Promise<BrincaSettings | null> {
  const { data, error } = await supabase.from('brinca_settings').select(brincaSettingsColumns).maybeSingle()

  if (error) {
    throw error
  }

  return (data as BrincaSettings | null) ?? null
}

export async function updateBrincaSettings(input: { baseMinutes: number; basePriceCop: number }): Promise<void> {
  const { error } = await supabase.rpc('update_brinca_settings', {
    p_base_minutes: input.baseMinutes,
    p_base_price_cop: input.basePriceCop,
  })

  if (error) {
    throw error
  }
}

export async function fetchOpenBrincaSessions(): Promise<BrincaSession[]> {
  const { data, error } = await supabase
    .from('brinca_sessions')
    .select(brincaSessionColumns)
    .in('status', ['active', 'paused'])
    .order('started_at', { ascending: false })

  if (error) {
    throw error
  }

  return (data ?? []) as BrincaSession[]
}

export async function fetchCompletedBrincaSessionsByRange(startIso: string, endIso: string): Promise<BrincaSession[]> {
  const { data, error } = await supabase
    .from('brinca_sessions')
    .select(brincaSessionColumns)
    .eq('status', 'completed')
    .gte('ended_at', startIso)
    .lt('ended_at', endIso)
    .order('ended_at', { ascending: false, nullsFirst: false })

  if (error) {
    throw error
  }

  return (data ?? []) as BrincaSession[]
}

export async function fetchClosedBrincaSessionsByRange(startIso: string, endIso: string): Promise<BrincaSession[]> {
  const { data, error } = await supabase
    .from('brinca_sessions')
    .select(brincaSessionColumns)
    .in('status', ['completed', 'cancelled'])
    .gte('ended_at', startIso)
    .lt('ended_at', endIso)
    .order('ended_at', { ascending: false, nullsFirst: false })

  if (error) {
    throw error
  }

  return (data ?? []) as BrincaSession[]
}

export async function startBrincaSession(input: {
  childName: string
  durationMinutes: number
}): Promise<string> {
  const { data, error } = await supabase.rpc('start_brinca_session', {
    p_child_name: input.childName,
    p_duration_minutes: input.durationMinutes,
  })

  if (error) {
    throw error
  }

  return String(data)
}

export async function stopBrincaSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('stop_brinca_session', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }
}

export async function cancelBrincaSession(sessionId: string, annulKey: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_brinca_session', {
    p_session_id: sessionId,
    p_annul_key: annulKey,
  })

  if (error) {
    throw error
  }
}

export async function setBrincaPayment(
  sessionId: string,
  paymentStatus: 'pending' | 'paid',
  paymentMethod: 'cash' | 'nequi' | null,
): Promise<void> {
  const { error } = await supabase.rpc('set_brinca_payment', {
    p_session_id: sessionId,
    p_payment_status: paymentStatus,
    p_payment_method: paymentMethod,
  })

  if (error) {
    throw error
  }
}

export async function pauseBrincaSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('pause_brinca_session', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }
}

export async function resumeBrincaSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('resume_brinca_session', {
    p_session_id: sessionId,
  })

  if (error) {
    throw error
  }
}

export async function extendBrincaSession(sessionId: string, extraMinutes: number): Promise<void> {
  const { error } = await supabase.rpc('extend_brinca_session', {
    p_session_id: sessionId,
    p_extra_minutes: extraMinutes,
  })

  if (error) {
    throw error
  }
}

export async function refreshExpiredBrincaSessions(): Promise<number> {
  const { data, error } = await supabase.rpc('refresh_expired_brinca_sessions')

  if (error) {
    throw error
  }

  return Number(data ?? 0)
}

export async function fetchCombos(limit = 80): Promise<Combo[]> {
  const { data, error } = await supabase
    .from('combos')
    .select(comboColumns)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    throw error
  }

  return (data ?? []) as Combo[]
}

export async function createCombo(input: {
  childName: string
  startMode: 'moto_first' | 'brinca_first' | 'either'
  motoDurationMinutes: number
  brincaDurationMinutes: number
  atvId?: string | null
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_combo', {
    p_child_name: input.childName,
    p_start_mode: input.startMode,
    p_moto_duration_minutes: input.motoDurationMinutes,
    p_brinca_duration_minutes: input.brincaDurationMinutes,
    p_atv_id: input.atvId ?? null,
  })

  if (error) {
    throw error
  }

  return String(data)
}

export async function startComboMotoLeg(comboId: string, atvId?: string | null): Promise<string> {
  const { data, error } = await supabase.rpc('start_combo_moto_leg', {
    p_combo_id: comboId,
    p_atv_id: atvId ?? null,
  })

  if (error) {
    throw error
  }

  return String(data)
}

export async function startComboBrincaLeg(comboId: string): Promise<string> {
  const { data, error } = await supabase.rpc('start_combo_brinca_leg', {
    p_combo_id: comboId,
  })

  if (error) {
    throw error
  }

  return String(data)
}

export async function cancelCombo(comboId: string, annulKey: string): Promise<string> {
  const { data, error } = await supabase.rpc('cancel_combo', {
    p_combo_id: comboId,
    p_annul_key: annulKey,
  })

  if (error) {
    throw error
  }

  return String(data)
}

export async function setComboPayment(
  comboId: string,
  paymentStatus: 'pending' | 'paid',
  paymentMethod: 'cash' | 'nequi' | null,
): Promise<string> {
  const { data, error } = await supabase.rpc('set_combo_payment', {
    p_combo_id: comboId,
    p_payment_status: paymentStatus,
    p_payment_method: paymentMethod,
  })

  if (error) {
    throw error
  }

  return String(data)
}

export function computeBrincaFinance(completedSessions: BrincaSession[]): FinanceTotalRow {
  let totalSessions = 0
  let totalMinutes = 0
  let totalAmount = 0

  for (const session of completedSessions) {
    totalSessions += 1
    totalMinutes += session.minutes_billed ?? 0
    totalAmount += session.amount_cop ?? 0
  }

  return {
    session_count: totalSessions,
    minutes_total: totalMinutes,
    amount_total_cop: totalAmount,
  }
}

export function computeComboFinance(
  combos: Combo[],
  completedMotoSessions: RideSession[],
  completedBrincaSessions: BrincaSession[],
): ComboFinanceSummary {
  const comboIdByMotoSession = new Map<string, string>()
  const comboIdByBrincaSession = new Map<string, string>()

  for (const combo of combos) {
    if (combo.status === 'cancelled') {
      continue
    }
    if (combo.moto_session_id) {
      comboIdByMotoSession.set(combo.moto_session_id, combo.id)
    }
    if (combo.brinca_session_id) {
      comboIdByBrincaSession.set(combo.brinca_session_id, combo.id)
    }
  }

  const comboIds = new Set<string>()
  let sessionCount = 0
  let minutesTotal = 0
  let amountTotal = 0

  for (const session of completedMotoSessions) {
    const comboId = comboIdByMotoSession.get(session.id)
    if (!comboId) {
      continue
    }

    comboIds.add(comboId)
    sessionCount += 1
    minutesTotal += session.minutes_billed ?? 0
    amountTotal += session.amount_cop ?? 0
  }

  for (const session of completedBrincaSessions) {
    const comboId = comboIdByBrincaSession.get(session.id)
    if (!comboId) {
      continue
    }

    comboIds.add(comboId)
    sessionCount += 1
    minutesTotal += session.minutes_billed ?? 0
    amountTotal += session.amount_cop ?? 0
  }

  return {
    combo_count: comboIds.size,
    session_count: sessionCount,
    minutes_total: minutesTotal,
    amount_total_cop: amountTotal,
  }
}

export function computeComboFinanceRows(
  combos: Combo[],
  motoSessions: RideSession[],
  brincaSessions: BrincaSession[],
): ComboFinanceRow[] {
  const motoById = new Map(motoSessions.map((session) => [session.id, session]))
  const brincaById = new Map(brincaSessions.map((session) => [session.id, session]))
  const rows: ComboFinanceRow[] = []

  for (const combo of combos) {
    if (combo.status === 'cancelled') {
      continue
    }

    const moto = combo.moto_session_id ? motoById.get(combo.moto_session_id) : undefined
    const brinca = combo.brinca_session_id ? brincaById.get(combo.brinca_session_id) : undefined

    if (!moto && !brinca) {
      continue
    }

    const motoAmount = moto?.amount_cop ?? 0
    const brincaAmount = brinca?.amount_cop ?? 0
    const motoStatus = moto?.payment_status ?? 'pending'
    const brincaStatus = brinca?.payment_status ?? 'pending'
    const comboStatus: 'pending' | 'paid' = motoStatus === 'paid' && brincaStatus === 'paid' ? 'paid' : 'pending'
    const comboMethod =
      comboStatus === 'paid' && moto?.payment_method && brinca?.payment_method && moto.payment_method === brinca.payment_method
        ? moto.payment_method
        : comboStatus === 'paid'
          ? moto?.payment_method ?? brinca?.payment_method ?? null
          : null

    rows.push({
      combo_id: combo.id,
      child_name: combo.child_name,
      moto_session_id: combo.moto_session_id,
      brinca_session_id: combo.brinca_session_id,
      moto_amount_cop: motoAmount,
      brinca_amount_cop: brincaAmount,
      amount_total_cop: motoAmount + brincaAmount,
      moto_payment_status: motoStatus,
      brinca_payment_status: brincaStatus,
      combo_payment_status: comboStatus,
      combo_payment_method: comboMethod,
    })
  }

  rows.sort((a, b) => b.amount_total_cop - a.amount_total_cop)
  return rows
}
