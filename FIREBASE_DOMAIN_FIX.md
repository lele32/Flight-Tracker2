# 🔥 SOLUCIÓN: Error Firebase Unauthorized Domain

## 🔴 Error
```
Firebase: Error (auth/unauthorized-domain)
The current domain (flight-tracker-deploy.vercel.app) is not authorized for OAuth operations
```

## ✅ Solución: Autorizar Dominio en Firebase

### Paso 1: Ir a Firebase Console
1. Abrir: https://console.firebase.google.com
2. Seleccionar proyecto: **flightracker-f5493**

### Paso 2: Configurar Dominios Autorizados
1. **Authentication** (menú izquierdo)
2. **Settings** (pestaña superior)
3. **Authorized domains** (tab)
4. Click en **Add domain**

### Paso 3: Agregar Dominios
Agregar estos dominios uno por uno:

```
flight-tracker-deploy.vercel.app
lele32.github.io
localhost
```

**Dominios completos a autorizar:**
- ✅ `flight-tracker-deploy.vercel.app` (Vercel deployment actual)
- ✅ `lele32.github.io` (GitHub Pages - si lo usas)
- ✅ `localhost` (desarrollo local - ya debería estar)

### Paso 4: Guardar y Esperar
- Click en **Add** para cada dominio
- Esperar 1-2 minutos para que se propague
- Recargar la página de tu app

---

## 🧪 Verificar Configuración

Después de agregar los dominios, prueba:

```bash
# 1. Abrir en el navegador
open https://flight-tracker-deploy.vercel.app

# 2. Intentar login con Google
# Debería funcionar sin errores
```

---

## 📝 Lista de Verificación

- [ ] Firebase Console abierto
- [ ] Proyecto flightracker-f5493 seleccionado
- [ ] Authentication → Settings → Authorized domains
- [ ] Dominio `flight-tracker-deploy.vercel.app` agregado
- [ ] Guardado correctamente
- [ ] Esperado 1-2 minutos
- [ ] Página recargada
- [ ] Login con Google testeado

---

## 🔧 Si el Error Persiste

### Verificar CORS en Vercel
El backend ya tiene CORS configurado para:
- `https://lele32.github.io`
- `http://localhost:5500`

Si despliegas el frontend en Vercel también, agregar a `api/lookupFlight.js`:

```javascript
const allowedOrigins = [
    'https://lele32.github.io',
    'https://flight-tracker-deploy.vercel.app',  // ← Agregar
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];
```

---

## 🎯 Explicación del Error

**¿Por qué ocurre?**
- Firebase Authentication requiere que todos los dominios desde donde se hace login estén en una lista blanca
- Esto previene ataques de phishing y uso no autorizado
- Cada vez que despliegas en un nuevo dominio, debes agregarlo

**Dominios que necesitan autorización:**
- Dominio de producción (Vercel, Netlify, etc.)
- Dominio de desarrollo (localhost)
- Cualquier subdominio que uses

---

## 📌 Nota Importante

Los errores de `FrameDoesNotExistError` y `LastPass` que ves en la consola son de **extensiones del navegador**, NO de tu aplicación. Puedes ignorarlos.

**Errores de extensiones (ignorar):**
- ❌ `FrameDoesNotExistError` → LastPass/otras extensiones
- ❌ `runtime.lastError: Cannot create item with duplicate id` → LastPass
- ❌ `Invalid frameId for foreground` → Extensiones de Chrome

**Error real de la app (solucionar):**
- ✅ `auth/unauthorized-domain` → Firebase Configuration ← **Este es el que importa**

---

## 🚀 Después de Solucionar

Una vez agregado el dominio en Firebase:
1. ✅ Google Sign-In funcionará correctamente
2. ✅ Email/Password login seguirá funcionando
3. ✅ Todos los usuarios podrán autenticarse
4. ✅ No más errores de unauthorized-domain

---

## 💡 Para Futuros Deployments

Cada vez que despliegues en un nuevo dominio:
1. Anotar el dominio (ej: `nuevo-deploy.vercel.app`)
2. Agregarlo a Firebase Authorized Domains
3. Esperar propagación
4. Probar login

**¡Listo para continuar!**
