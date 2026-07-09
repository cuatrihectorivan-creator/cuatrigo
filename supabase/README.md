# Supabase setup (MVP CuatriGo)

## 1) Crear proyecto en Supabase

1. Crea un proyecto nuevo.
2. En `Project Settings > API`, copia:
- Project URL
- Publishable key (`sb_publishable_...`)

## 2) Configurar frontend

Crea `.env.local` usando `.env.example`.

## 3) Ejecutar migraciones SQL

Aplica en orden:

1. `supabase/migrations/0001_init.sql`
2. `supabase/migrations/0002_cron_and_notifications.sql`
3. `supabase/migrations/0003_add_paused_session_status.sql`
4. `supabase/migrations/0003_sessions_pause_restart_and_finance_reset.sql`
5. `supabase/migrations/0004_expiry_precision_soft_delete_and_colors.sql`
6. `supabase/migrations/0005_brinca_sessions.sql`
7. `supabase/migrations/0006_closed_block_pricing.sql`
8. `supabase/migrations/0007_combos.sql`
9. `supabase/migrations/0008_minimum_price_floors.sql`
10. `supabase/migrations/0009_combo_discount_and_finance.sql`
11. `supabase/migrations/0010_reset_finance_all_modules.sql`
12. `supabase/migrations/0011_block_combo_extension_rpc.sql`
13. `supabase/migrations/0012_annulment_key_and_cancel_rpc.sql`
14. `supabase/migrations/0013_payment_status_and_method.sql`
15. `supabase/migrations/0014_hard_cap_stop_and_self_heal_start.sql`
16. `supabase/migrations/0015_combo_payment_sync.sql`
17. `supabase/migrations/0016_brinca_start_idempotency.sql`
18. `supabase/migrations/0017_combo_moto_block_15_min.sql`

Puedes hacerlo desde SQL Editor o con Supabase CLI.

Si usas SQL Editor, ejecuta el paso 3 y el paso 4 en corridas separadas.

La migracion `0012` deja configurada una clave inicial de anulacion (`5784`) en hash.
Si quieres rotarla despues, ejecuta como admin:

```sql
select public.set_annulment_key('NUEVA_CLAVE');
```

## 4) Configurar Auth

En `Authentication > Providers`, habilita Email/Password.

Nota: el primer usuario que se registre se crea automaticamente como `admin`.

## 5) Realtime

Asegura que `atvs`, `sessions` y `payments` tengan realtime habilitado:

- `Database > Replication > Enable`

## 6) Edge Function opcional para notificaciones

Deploy:

```bash
supabase functions deploy process-notification-queue
```

Si usas cron para invocarla, actualiza URL/token en `0002_cron_and_notifications.sql`.
