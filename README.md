# CuatriGo MVP

MVP web (PWA) para operar alquiler de cuatrimotos con temporizador robusto por servidor, cobro por minuto y resumen financiero.

## Stack

- React + TypeScript + Vite
- Supabase (Auth + Postgres + Realtime + Functions + Cron)
- Cloudflare Pages (hosting frontend)

## Requisitos

- Node 20+
- Cuenta de Supabase

## Ejecutar local

```bash
npm install
cp .env.example .env.local
npm run dev
```

## Variables

```bash
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

## Flujo de negocio

- Se configuran cuatrimotos con tarifa base (minutos + COP).
- El operador inicia una sesion por moto.
- Se puede pausar, reanudar y reiniciar tiempo de una sesion en curso.
- El conteo no depende del reloj del telefono: usa timestamps de servidor.
- Al detener o vencer una sesion, se calcula cobro por minuto.
- Finanzas se consolidan por moto y total del mes seleccionado.

## SQL y backend

Revisa:

- `supabase/migrations/0001_init.sql`
- `supabase/migrations/0002_cron_and_notifications.sql`
- `supabase/migrations/0003_add_paused_session_status.sql`
- `supabase/migrations/0003_sessions_pause_restart_and_finance_reset.sql`
- `supabase/migrations/0004_expiry_precision_soft_delete_and_colors.sql`
- `supabase/migrations/0005_brinca_sessions.sql`
- `supabase/migrations/0006_closed_block_pricing.sql`
- `supabase/migrations/0007_combos.sql`
- `supabase/migrations/0008_minimum_price_floors.sql`
- `supabase/migrations/0009_combo_discount_and_finance.sql`
- `supabase/migrations/0010_reset_finance_all_modules.sql`
- `supabase/migrations/0011_block_combo_extension_rpc.sql`
- `supabase/migrations/0012_annulment_key_and_cancel_rpc.sql`
- `supabase/migrations/0013_payment_status_and_method.sql`
- `supabase/migrations/0014_hard_cap_stop_and_self_heal_start.sql`
- `supabase/migrations/0015_combo_payment_sync.sql`
- `supabase/README.md`

## Deploy en Cloudflare Pages

1. Crear repo y subir proyecto.
2. En Cloudflare Pages:
- Build command: `npm run build`
- Build output: `dist`
3. Configurar variables `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY`.
