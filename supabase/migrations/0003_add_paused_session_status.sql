-- Paso separado para compatibilidad con SQL Editor de Supabase:
-- el nuevo valor de enum debe confirmarse en una transaccion previa
-- antes de poder usarse en indices/funciones.
alter type public.session_status add value if not exists 'paused';
