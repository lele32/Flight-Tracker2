# Flight Tracker API - Configuración y Mejoras

## Estado de Arquitectura (Actual)

- Producción API: `api/lookupFlight.js` en Vercel.
- Flujo de deploy: `git push` a `main` -> Vercel auto-deploy.
- Firebase se usa para Auth/Firestore.
- `functions/lookupFlight` en Firebase es opcional y actualmente no forma parte del flujo (en plan Spark no se puede desplegar Functions v2 con build APIs).
- El endpoint productivo exige Firebase ID token en `Authorization: Bearer <token>` y valida firma, issuer, audience y expiración con certificados públicos de Firebase.

## 🚀 Auto-Deployment desde GitHub

### Configuración en Vercel (Web UI)

1. **Ir a tu proyecto en Vercel**: https://vercel.com/dashboard
2. **Seleccionar el proyecto**: `flight-tracker-deploy`
3. **Settings → Git**:
   - Conectar con GitHub repository: `lele32/Flight-Tracker`
   - Branch principal: `main`
   - Auto-deploy habilitado por defecto
4. **Configurar Build Settings**:
   - Framework Preset: "Other"
   - Build Command: (dejar vacío)
   - Output Directory: `.`
   - Install Command: (dejar vacío)

### ✅ Resultado
Cada push a `main` desplegará automáticamente a producción.

---

## 🛡️ Rate Limiting

### Configuración Actual
- **Límite**: 30 requests por minuto
- **Ventana**: 60 segundos (rolling window)
- **Antes de autenticar**: límite por IP para frenar abuso anónimo
- **Después de autenticar**: límite por combinación usuario + IP
- **Respuesta cuando se excede**: HTTP 429 con `retryAfter` en segundos
- **Persistencia**: en memoria serverless; se reinicia con cold starts. Para protección fuerte, migrar a Vercel KV/Upstash.

### Headers de Rate Limit
```
X-RateLimit-Limit: 30
X-RateLimit-Remaining: 25
X-RateLimit-Reset: 45 (segundos hasta el reset)
```

### Ejemplo de Respuesta (429)
```json
{
  "error": "rate-limit-exceeded",
  "message": "Demasiadas solicitudes. Intenta de nuevo más tarde.",
  "retryAfter": 45
}
```

### Ajustar Límites
Editar en `api/lookupFlight.js`:
```javascript
const RATE_LIMIT_WINDOW_MS = 60000; // Ventana en milisegundos
const MAX_REQUESTS_PER_WINDOW = 30; // Requests permitidos
```

---

## 📊 Logging y Monitoring

### Log Estructurado
Todos los eventos se registran en formato JSON estructurado:

```json
{
  "timestamp": "2026-03-09T21:30:45.123Z",
  "level": "info",
  "message": "Flight found successfully",
  "flightNumber": "AR1388",
  "origin": "Buenos Aires",
  "destination": "Montevideo",
  "responseTime": 1234,
  "ip": "192.168.1.1"
}
```

### Niveles de Log
- **info**: Eventos normales (requests, vuelos encontrados)
- **warn**: Advertencias (rate limit, validación fallida)
- **error**: Errores del sistema (API key faltante, provider caído)

### Ver Logs en Vercel
1. Dashboard → Proyecto → **Logs**
2. Filtrar por nivel: `level:error`, `level:warn`
3. Buscar por flight number: `flightNumber:AR1388`

### Configurar Alertas
1. **Vercel Dashboard** → Settings → **Integrations**
2. Instalar: **Sentry**, **Datadog**, o **LogTail**
3. Alertas automáticas para errores 500

---

## 📈 Analytics

### Métricas Recolectadas (en memoria)
```javascript
{
  total: 150,      // Total de requests
  found: 120,      // Vuelos encontrados
  notFound: 25,    // Vuelos no encontrados
  errors: 5,       // Errores
  startTime: 1709...
}
```

### Acceso a Métricas
Las métricas se resetean con cada cold start de la función serverless.

### Analytics Recomendados
Para analytics persistente, agregar:
- **Vercel Analytics** (integración nativa)
- **Google Analytics** en el frontend
- **Mixpanel** o **Amplitude** para eventos detallados

---

## 🔒 Seguridad Headers

### Autenticación

Todas las búsquedas reales requieren un Firebase ID token:

```bash
curl "https://flight-tracker-deploy.vercel.app/api/lookupFlight?flightNumber=AR1388" \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN"
```

Respuestas esperadas:
- Sin token: `401 { "error": "unauthenticated" }`
- Token inválido o expirado: `401 { "error": "unauthenticated" }`
- Origen CORS no permitido: `403 { "error": "origin-not-allowed" }`

### Headers Implementados
```
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 1; mode=block
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), microphone=(), camera=()
Cache-Control: no-store, max-age=0
Strict-Transport-Security: max-age=31536000; includeSubDomains
Access-Control-Allow-Origin: [origen permitido]
```

El hosting estático de Vercel también aplica headers desde `vercel.json`, incluyendo Content Security Policy, HSTS, `X-Frame-Options`, `Referrer-Policy` y `Permissions-Policy`.

### CORS Permitido
- `https://lele32.github.io` (producción)
- `https://flight-tracker-deploy.vercel.app` (producción Vercel)
- `http://localhost:5500` (desarrollo)
- `http://127.0.0.1:5500` (desarrollo)

La validación de origen usa comparación exacta, no prefijos.

---

## 🔧 Variables de Entorno

### Configuradas en Vercel
```
AVIATIONSTACK_API_KEY=TU_API_KEY_AQUI
FIREBASE_PROJECT_ID=flightracker-f5493
```

### Agregar/Editar
```bash
cd /tmp/flight-tracker-deploy
npx vercel env add VARIABLE_NAME production
```

---

## 🧪 Testing

### Test Básico
```bash
FIREBASE_ID_TOKEN="pega_un_token_valido" ./test_api.sh
```

Sin `FIREBASE_ID_TOKEN`, el script ejecuta solo las pruebas públicas/negativas y omite los casos autenticados.

### Test Rate Limiting
```bash
for i in {1..35}; do
  curl -s "https://flight-tracker-deploy.vercel.app/api/lookupFlight?flightNumber=AR1388" \
    -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
    -w "\n%{http_code}\n"
  sleep 0.1
done
```

### Ver Headers
```bash
curl -I "https://flight-tracker-deploy.vercel.app/api/lookupFlight?flightNumber=AR1388"
```

---

## 📦 Deployment Workflow

### Flujo Automático (con GitHub conectado)
1. Hacer cambios en código local
2. `git add .`
3. `git commit -m "mensaje"`
4. `git push origin main`
5. ✅ Vercel deploya automáticamente

### Flujo Manual
```bash
cd "/Users/leandrocarbone/Google Drive/Proyectos Visual Studio/Flight Tracker"
git add -A
git commit -m "Update API"
git push

# Deploy manual si es necesario
cd /tmp && rm -rf flight-tracker-deploy
git clone https://github.com/lele32/Flight-Tracker.git flight-tracker-deploy
cd flight-tracker-deploy
npx vercel --prod --yes
```

---

## 🎯 Próximas Mejoras Recomendadas

1. **Cache de respuestas**: Redis/Upstash para cachear vuelos frecuentes
2. **WebSockets**: Updates en tiempo real de estado de vuelos
3. **Database para analytics**: PostgreSQL/Supabase para métricas persistentes
4. **CDN**: CloudFlare para assets estáticos
5. **Health check endpoint**: `/api/health` para monitoring

---

## 📞 Soporte

- **Vercel Docs**: https://vercel.com/docs
- **Aviationstack API**: https://aviationstack.com/documentation
- **GitHub Repo**: https://github.com/lele32/Flight-Tracker
