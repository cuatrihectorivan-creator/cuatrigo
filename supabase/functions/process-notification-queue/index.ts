import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')
const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

if (!supabaseUrl || !serviceRole) {
  throw new Error('SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY son requeridas')
}

const admin = createClient(supabaseUrl, serviceRole)

Deno.serve(async () => {
  const { data: queueRows, error } = await admin
    .from('notification_queue')
    .select('id, session_id, payload')
    .is('delivered_at', null)
    .order('created_at', { ascending: true })
    .limit(50)

  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    })
  }

  // TODO: Integrar proveedor real de notificaciones.
  // Por ahora marca la cola como entregada para validar el flujo end-to-end.
  const ids = (queueRows ?? []).map((row) => row.id)

  if (ids.length > 0) {
    const { error: markError } = await admin
      .from('notification_queue')
      .update({ delivered_at: new Date().toISOString() })
      .in('id', ids)

    if (markError) {
      return new Response(JSON.stringify({ ok: false, error: markError.message }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      processed: ids.length,
      sessions: (queueRows ?? []).map((row) => row.session_id),
    }),
    {
      headers: { 'content-type': 'application/json' },
    },
  )
})
