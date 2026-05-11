export type UserRole = 'admin' | 'operator'
export type SessionStatus = 'active' | 'paused' | 'completed' | 'cancelled'

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
