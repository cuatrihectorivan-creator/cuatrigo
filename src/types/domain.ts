export type UserRole = 'admin' | 'operator'
export type SessionStatus = 'active' | 'paused' | 'completed' | 'cancelled'
export type ComboStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'
export type ComboStartMode = 'moto_first' | 'brinca_first' | 'either'

export interface Profile {
  id: string
  email: string | null
  role: UserRole
  created_at: string
  updated_at: string
}

export interface Atv {
  id: string
  name: string
  plate: string | null
  active: boolean
  color_hex: string | null
  base_minutes: number
  base_price_cop: number
  created_at: string
  updated_at: string
}

export interface RideSession {
  id: string
  atv_id: string
  started_by: string
  started_at: string
  target_end_at: string
  paused_at: string | null
  ended_at: string | null
  status: SessionStatus
  minutes_billed: number | null
  amount_cop: number | null
  created_at: string
  updated_at: string
}

export interface FinanceByAtvRow {
  atv_id: string
  atv_name: string
  session_count: number
  minutes_total: number
  amount_total_cop: number
}

export interface FinanceTotalRow {
  session_count: number
  minutes_total: number
  amount_total_cop: number
}

export interface BrincaSettings {
  id: boolean
  base_minutes: number
  base_price_cop: number
  created_at: string
  updated_at: string
}

export interface BrincaSession {
  id: string
  child_name: string
  started_by: string
  started_at: string
  target_end_at: string
  paused_at: string | null
  ended_at: string | null
  status: SessionStatus
  base_minutes: number
  base_price_cop: number
  minutes_billed: number | null
  amount_cop: number | null
  created_at: string
  updated_at: string
}

export interface Combo {
  id: string
  child_name: string
  start_mode: ComboStartMode
  status: ComboStatus
  atv_id: string | null
  moto_duration_minutes: number
  brinca_duration_minutes: number
  moto_session_id: string | null
  brinca_session_id: string | null
  moto_completed_at: string | null
  brinca_completed_at: string | null
  completed_at: string | null
  started_by: string
  created_at: string
  updated_at: string
}
