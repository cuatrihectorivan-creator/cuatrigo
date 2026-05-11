# process-notification-queue

Edge Function base para consumir `notification_queue` y enviar notificaciones.

## Deploy

```bash
supabase functions deploy process-notification-queue
```

## Variables requeridas

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Nota

Esta version MVP solo marca notificaciones como entregadas. En la siguiente iteracion puedes conectar:

- OneSignal
- Expo push
- Firebase Cloud Messaging
- Web Push directo (VAPID)
