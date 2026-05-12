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

Puedes hacerlo desde SQL Editor o con Supabase CLI.

Si usas SQL Editor, ejecuta el paso 3 y el paso 4 en corridas separadas.

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
