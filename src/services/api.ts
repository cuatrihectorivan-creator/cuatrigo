import { supabase } from '../lib/supabase'
import type { Atv, FinanceByAtvRow, FinanceTotalRow, Profile, RideSession } from '../types/domain'

const profileColumns = 'id,email,role,created_at,updated_at'
const atvColumns = 'id,name,plate,active,base_minutes,base_price_cop,created_at,updated_at'
const sessionColumns =
  'id,atv_id,started_by,started_at,target_end_at,paused_at,ended_at,status,minutes_billed,amount_cop,created_at,updated_at'

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
  const { data, error } = await supabase.from('atvs').select(atvColumns).order('name')

  if (error) {
    throw error
  }

  return (data ?? []) as Atv[]
}

export async function createAtv(input: {
  name: string
  plate?: string
  baseMinutes: number
  basePriceCop: number
}): Promise<Atv> {
  const { data, error } = await supabase
    .from('atvs')
    .insert({
      name: input.name,
      plate: input.plate?.trim() ? input.plate.trim() : null,
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
  input: { baseMinutes: number; basePriceCop: number },
): Promise<void> {
  const { error } = await supabase
    .from('atvs')
    .update({
      base_minutes: input.baseMinutes,
      base_price_cop: input.basePriceCop,
    })
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
