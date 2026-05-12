import { supabase } from '../lib/supabase'
import type {
  Atv,
  BrincaSession,
  BrincaSettings,
  FinanceByAtvRow,
  FinanceTotalRow,
  Profile,
  RideSession,
} from '../types/domain'

const profileColumns = 'id,email,role,created_at,updated_at'
const atvColumns = 'id,name,plate,active,color_hex,base_minutes,base_price_cop,created_at,updated_at'
const sessionColumns =
  'id,atv_id,started_by,started_at,target_end_at,paused_at,ended_at,status,minutes_billed,amount_cop,created_at,updated_at'
const brincaSettingsColumns = 'id,base_minutes,base_price_cop,created_at,updated_at'
const brincaSessionColumns =
  'id,child_name,started_by,started_at,target_end_at,paused_at,ended_at,status,base_minutes,base_price_cop,minutes_billed,amount_cop,created_at,updated_at'

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
  plate?: string
  colorHex?: string
  baseMinutes: number
  basePriceCop: number
}): Promise<Atv> {
  const { data, error } = await supabase
    .from('atvs')
    .insert({
      name: input.name,
      plate: input.plate?.trim() ? input.plate.trim() : null,
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

export async function startSession(atvId: string, durationMinutes: number): Promise<void> {
  const { error } = await supabase.rpc('start_session', {
    p_atv_id: atvId,
    p_duration_minutes: durationMinutes,
  })

  if (error) {
    throw error
  }
}

export async function stopSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('stop_session', {
    p_session_id: sessionId,
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

export async function startBrincaSession(input: { childName: string; durationMinutes: number }): Promise<void> {
  const { error } = await supabase.rpc('start_brinca_session', {
    p_child_name: input.childName,
    p_duration_minutes: input.durationMinutes,
  })

  if (error) {
    throw error
  }
}

export async function stopBrincaSession(sessionId: string): Promise<void> {
  const { error } = await supabase.rpc('stop_brinca_session', {
    p_session_id: sessionId,
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
