-- Programa un job para cerrar sesiones vencidas cada minuto.
-- Este script es idempotente y requiere que pg_cron este disponible.

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if not exists (
      select 1
      from cron.job
      where jobname = 'cuatrigo-refresh-expired-sessions-every-minute'
    ) then
      perform cron.schedule(
        'cuatrigo-refresh-expired-sessions-every-minute',
        '* * * * *',
        $job$select public.refresh_expired_sessions();$job$
      );
    end if;
  else
    raise notice 'pg_cron no esta habilitado; se omite programacion de jobs.';
  end if;
exception
  when undefined_table then
    raise notice 'Catalogo de pg_cron no disponible; se omite programacion.';
end;
$$;

-- Opcional: si habilitas una Edge Function para enviar push/notificaciones externas,
-- puedes activar un segundo job que drene la cola:
--
-- do $$
-- begin
--   if exists (select 1 from pg_extension where extname = 'pg_cron') then
--     if not exists (
--       select 1
--       from cron.job
--       where jobname = 'cuatrigo-process-notification-queue-every-minute'
--     ) then
--       perform cron.schedule(
--         'cuatrigo-process-notification-queue-every-minute',
--         '* * * * *',
--         $job$
--           select net.http_post(
--             url := 'https://YOUR_PROJECT_REF.functions.supabase.co/process-notification-queue',
--             headers := jsonb_build_object(
--               'Content-Type', 'application/json',
--               'Authorization', 'Bearer YOUR_SERVICE_ROLE_TOKEN'
--             ),
--             body := jsonb_build_object('source', 'cron')
--           );
--         $job$
--       );
--     end if;
--   end if;
-- end;
-- $$;
