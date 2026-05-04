# Dashboard de Vuelos

Una aplicación web simple para rastrear y visualizar información de vuelos usando HTML, CSS, JavaScript y Firebase.

## Flujo de Deploy (Actual)

- `git push` a `main` despliega en **Vercel** (si el repo está conectado en Vercel).
- **Firebase no es un paso intermedio** del deploy web/API.
- Firebase se usa para **Auth + Firestore**.
- `functions/` queda como implementación opcional para futuro (requiere plan Blaze para deploy).

## Características

- **Selector de Período**: Filtra todos los KPIs (Kilómetros, Destinos, Países) por período: Total, Último Mes, Últimos 3 Meses, Último Año.
- **Kilómetros Acumulados**: Muestra la suma total de distancias de todos los vuelos (filtrado por período).
- **Destinos Más Frecuentes**: Lista los 5 destinos más visitados (filtrado por período).
- **Países Visitados**: Lista única de países visitados (filtrado por período).
- **Mapa Interactivo con Rutas**: Muestra marcadores con colores únicos por aerolínea tanto en Buenos Aires (origen) como en cada destino visitado. Las líneas punteadas conectan cada aerolínea desde el origen hasta sus destinos. Haz clic en cualquier marcador para ver detalles por aerolínea.
- **Registro de Vuelos Inteligente**: Ingresa número de vuelo (ej: AM190) y fecha. El sistema:
  - Busca automáticamente en la base de datos de vuelos
  - Calcula origen, destino, distancia y país automáticamente
  - Muestra la información antes de confirmar
  - Registra el vuelo en Firestore
- **Carga de Datos de Ejemplo**: Botón para cargar 30 vuelos de ejemplo automáticamente con números de vuelo reales de 10 aerolíneas diferentes, mostrando toda la funcionalidad del mapa.

## Configuración

1. Crea un proyecto en [Firebase](https://console.firebase.google.com/).
2. Habilita Firestore en tu proyecto.
3. Obtén las claves de configuración de Firebase.
4. Reemplaza los placeholders en `index.html` con tus claves reales (ya están configuradas en el código actual).
5. Despliega o pega en Firebase Console las reglas de `firestore.rules`. No uses reglas en modo de prueba en producción.

## API de Lookup (Producción)

- Endpoint activo: `https://flight-tracker-deploy.vercel.app/api/lookupFlight`
- Configuración de API key: variable de entorno `AVIATIONSTACK_API_KEY` en Vercel.
- Configuración Firebase: variable opcional `FIREBASE_PROJECT_ID` en Vercel. Si no existe, se usa `flightracker-f5493`.
- Autenticación: requiere `Authorization: Bearer <Firebase ID token>`.
- Headers de seguridad estáticos: `vercel.json` define CSP, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` y HSTS para el hosting en Vercel.

## Vuelos Disponibles

El sistema incluye una base de datos de vuelos simulados. Los códigos de compañías y números disponibles son:

- **AM** (Aeromexico): 190, 191, 192
- **AA** (American Airlines): 100, 101, 102, 950, 951, 952, 953
- **BA** (British Airways): 200, 201
- **AF** (Air France): 300, 301
- **LH** (Lufthansa): 400, 401, 402
- **AZ** (Alitalia): 500, 501
- **IB** (Iberia): 600, 601
- **KL** (KLM): 700
- **JL** (Japan Airlines): 800, 801
- **QF** (Qantas): 900, 901

**Ejemplos de vuelos válidos:** AM190, BA200, LH400, JL800, AA953

Todos los vuelos salen desde Buenos Aires hacia sus destinos respectivos.

## Colores por Aerolínea

Cada aerolínea tiene un color único en el mapa:

- **AM** (Aeromexico): Naranja rojizo
- **AA** (American Airlines): Azul
- **BA** (British Airways): Azul oscuro
- **AF** (Air France): Azul marino
- **LH** (Lufthansa): Rojo
- **AZ** (Alitalia): Azul claro
- **IB** (Iberia): Rojo
- **KL** (KLM): Azul cielo
- **JL** (Japan Airlines): Rojo
- **QF** (Qantas): Rojo

## Estructura de Datos

Los vuelos se guardan por usuario en `users/{uid}/flights/{flightId}`. Las reglas de `firestore.rules` solo permiten que cada usuario autenticado lea y escriba sus propios vuelos.

Cada documento de vuelo usa campos como:
- `origin`: Ciudad de origen
- `destination`: Ciudad de destino
- `distance`: Distancia en km (número)
- `date`: Fecha del vuelo
- `country`: País del destino

## Uso

1. Abre `index.html` en un navegador web.
2. Selecciona el período en los radio buttons para filtrar los datos (Total, Último Mes, Últimos 3 Meses, Último Año).
3. **Registrar un vuelo:**
   - Ingresa un número de vuelo válido (ej: AM190) en el campo "Número de Vuelo"
   - El sistema buscará el vuelo automáticamente
   - Selecciona la fecha del vuelo
   - Se mostrarán automáticamente: origen, destino, distancia y país
   - Haz clic en "Registrar Vuelo" para guardar
4. Alternativamente, haz clic en "Cargar Datos de Ejemplo" para poblar con 30 vuelos de muestra.
5. Los datos en el dashboard y el mapa se actualizan en tiempo real.

## Notas

- El mapa usa Leaflet.js con OpenStreetMap tiles para máxima interactividad.
- Las coordenadas de las ciudades están definidas en `script.js`. Puedes expandirlas agregando más ciudades.
- Todos los vuelos salen desde Buenos Aires hacia sus destinos.
- Asegúrate de tener una conexión a internet para que Firebase funcione correctamente.