import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-analytics.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { collection, getDocs, addDoc, deleteDoc, updateDoc, doc } from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js';
import {
    getAuth,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut,
    GoogleAuthProvider,
    signInWithPopup,
    sendPasswordResetEmail
} from 'https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js';

// Configuración de Firebase
const firebaseConfig = {
    apiKey: "AIzaSyC-PDZnq1zfygXmvvCOqo_-HaooN_PUbfQ",
    authDomain: "flightracker-f5493.firebaseapp.com",
    projectId: "flightracker-f5493",
    storageBucket: "flightracker-f5493.firebasestorage.app",
    messagingSenderId: "712197361322",
    appId: "1:712197361322:web:7d7cfaa410eca80c5b8ad3",
    measurementId: "G-QZ5VTMWJCY"
};

// Inicializar Firebase
const app = initializeApp(firebaseConfig);
getAnalytics(app);
const db = getFirestore(app);
const auth = getAuth(app);
window.db = db;

// Variable global para almacenar el mapa de Leaflet
let map = null;
let markers = {};
let allFlights = []; // Guardar todos los vuelos para filtrado
let currentPeriod = 'total'; // Período actual seleccionado
let currentTripType = 'all'; // Tipo de viaje seleccionado
let currentFlightData = null; // Datos del vuelo actual cargado desde la BD
let flightLines = []; // Almacenar las líneas de vuelo
let lastFilteredFlights = []; // Snapshot para modo animado
let isAnimationMode = false;
let animationTimerId = null;

// Constantes para equivalentes de distancia
const EARTH_CIRCUMFERENCE_KM = 40075; // Circunferencia de la tierra
const MOON_DISTANCE_KM = 384400; // Distancia promedio a la luna

// Variables de control para modos de visualización
let isHeatmapMode = false;
let heatmapLayer = null;
let isNetworkMode = false;
let networkGraph = null;
let networkMinFrequency = 1;
let currentUser = null;
const googleProvider = new GoogleAuthProvider();
let openAuthModal = () => {};
const FLIGHT_LOOKUP_PROXY_URL_STORAGE = 'flightTracker_lookup_proxy_url';
const FLIGHT_LOOKUP_PROXY_URL_DEFAULT = 'https://flight-tracker-zeta-tawny.vercel.app/api/lookupFlight';
let isLiveLookupAvailable = true;

function validatePasswordStrength(password) {
    const checks = {
        minLength: password.length >= 8,
        hasUpper: /[A-Z]/.test(password),
        hasLower: /[a-z]/.test(password),
        hasDigit: /\d/.test(password),
        hasSymbol: /[^A-Za-z0-9]/.test(password)
    };

    const passed = Object.values(checks).filter(Boolean).length;
    return {
        isStrong: passed === 5,
        score: passed,
        checks
    };
}

function getGoogleAuthErrorMessage(error, context = 'login') {
    const code = error?.code || 'unknown';

    switch (code) {
        case 'auth/operation-not-allowed':
            return 'Google Sign-In no esta habilitado en Firebase Authentication > Sign-in method.';
        case 'auth/unauthorized-domain':
            return 'Dominio no autorizado. Agrega lele32.github.io en Firebase Authentication > Settings > Authorized domains.';
        case 'auth/popup-blocked':
            return 'El navegador bloqueo la ventana de Google. Habilita popups para este sitio e intenta nuevamente.';
        case 'auth/popup-closed-by-user':
            return 'cancelled';
        case 'auth/network-request-failed':
            return 'Fallo de red durante autenticacion. Revisa tu conexion e intenta nuevamente.';
        case 'auth/invalid-api-key':
            return 'La API key de Firebase no es valida para este proyecto.';
        default:
            return `No se pudo iniciar sesion con Google (codigo: ${code}).`;
    }
}

function getFlightsCollectionRef() {
    if (!currentUser) return null;
    return collection(window.db, 'users', currentUser.uid, 'flights');
}

function getFlightLookupProxyUrl() {
    try {
        const stored = (localStorage.getItem(FLIGHT_LOOKUP_PROXY_URL_STORAGE) || '').trim();
        if (!stored) return FLIGHT_LOOKUP_PROXY_URL_DEFAULT;

        const normalized = stored.toLowerCase();
        if (normalized.includes('localhost') || normalized.includes('127.0.0.1')) {
            localStorage.removeItem(FLIGHT_LOOKUP_PROXY_URL_STORAGE);
            return FLIGHT_LOOKUP_PROXY_URL_DEFAULT;
        }

        return stored;
    } catch {
        return FLIGHT_LOOKUP_PROXY_URL_DEFAULT;
    }
}

async function lookupFlightLive(flightNumber) {
    if (!currentUser) return null;
    if (!isLiveLookupAvailable) return null;
    const proxyUrl = getFlightLookupProxyUrl();
    if (!proxyUrl) return null;

    const value = String(flightNumber || '').trim().toUpperCase();
    if (!value) return null;

    try {
        const idToken = await currentUser.getIdToken();
        const separator = proxyUrl.includes('?') ? '&' : '?';
        const url = `${proxyUrl}${separator}flightNumber=${encodeURIComponent(value)}`;
        const response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${idToken}`
            }
        });

        if (!response.ok) {
            // Evita repetir requests si el endpoint no existe o falla CORS de forma sistemática
            if (response.status === 404 || response.status === 405) {
                isLiveLookupAvailable = false;
            }
            return null;
        }

        const payload = await response.json();
        if (!payload || payload.found === false) return null;

        const destination = normalizeDestinationCity(payload.destination || 'Desconocido');
        const country = normalizeCountryName(payload.country, destination);

        return {
            origin: payload.origin || 'Desconocido',
            destination,
            distance: Math.max(100, Number(payload.distance || 1000)),
            country
        };
    } catch {
        isLiveLookupAvailable = false;
        return null;
    }
}

async function lookupFlightWithFallback(flightNumber) {
    const value = String(flightNumber || '').trim().toUpperCase();
    if (!value) return null;
    return await lookupFlightLive(value);
}

function buildFlightSignature(flight) {
    const origin = String(flight.origin || '').trim().toLowerCase();
    const destination = String(flight.destination || '').trim().toLowerCase();
    const date = String(flight.date || '').trim();
    const flightNumber = String(flight.flightNumber || '').trim().toUpperCase();
    const distance = Number(flight.distance || 0);
    return `${flightNumber}|${date}|${origin}|${destination}|${distance}`;
}

function normalizeFlightPayload(flight) {
    const distance = Number(flight.distance || 0);
    const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : 100;
    const destination = normalizeDestinationCity(flight.destination || 'Desconocido');
    const country = normalizeCountryName(flight.country, destination);
    return {
        origin: flight.origin || 'Buenos Aires',
        destination,
        distance: safeDistance,
        date: flight.date || new Date().toISOString().slice(0, 10),
        country,
        flightNumber: (flight.flightNumber || 'LEG000').toUpperCase(),
        category: flight.category || 'Personal',
        rating: Number(flight.rating || 5),
        durationHours: Number(flight.durationHours || estimateDurationHours(safeDistance))
    };
}

function ensureAuthenticated() {
    if (!currentUser) {
        openAuthModal();
        return false;
    }
    return true;
}

function updateAuthUI() {
    const openAuthBtn = document.getElementById('open-auth-modal');
    const accountUser = document.getElementById('account-user');
    const accountMenu = document.getElementById('account-menu');
    const accountTrigger = document.getElementById('account-trigger');
    const accountAvatar = document.getElementById('account-avatar');
    const authStatus = document.getElementById('auth-status');
    const isLoggedIn = Boolean(currentUser);

    document.body.classList.toggle('auth-locked', !isLoggedIn);

    if (openAuthBtn) openAuthBtn.classList.toggle('auth-hidden', isLoggedIn);
    if (accountUser) accountUser.classList.toggle('auth-hidden', !isLoggedIn);
    if (accountMenu && !isLoggedIn) accountMenu.classList.add('auth-hidden');
    if (accountTrigger && !isLoggedIn) accountTrigger.setAttribute('aria-expanded', 'false');

    if (!authStatus) return;
    if (isLoggedIn) {
        authStatus.textContent = currentUser.email || 'Usuario autenticado';
        authStatus.style.color = '#8df2b3';
        if (accountAvatar) {
            const seed = (currentUser.email || 'U').trim().charAt(0).toUpperCase();
            accountAvatar.textContent = seed || 'U';
        }
    } else {
        authStatus.textContent = 'No autenticado';
        authStatus.style.color = '#9f9f9f';
        if (accountAvatar) accountAvatar.textContent = 'U';
    }
}

function setupAuthControls() {
    const authModal = document.getElementById('auth-modal');
    const authModalOverlay = document.getElementById('auth-modal-overlay');
    const closeAuthModalBtn = document.getElementById('close-auth-modal');
    const openAuthBtn = document.getElementById('open-auth-modal');
    const emailInput = document.getElementById('auth-email');
    const passwordInput = document.getElementById('auth-password');
    const loginBtn = document.getElementById('auth-login');
    const registerBtn = document.getElementById('auth-register');
    const googleBtn = document.getElementById('auth-google');
    const resetBtn = document.getElementById('auth-reset');
    const accountResetBtn = document.getElementById('account-reset');
    const accountLogoutBtn = document.getElementById('account-logout');
    const accountTrigger = document.getElementById('account-trigger');
    const accountMenu = document.getElementById('account-menu');
    const accountUser = document.getElementById('account-user');
    let lastFocusedElement = null;

    const closeAccountMenu = () => {
        accountMenu?.classList.add('auth-hidden');
        accountTrigger?.setAttribute('aria-expanded', 'false');
    };

    const toggleAccountMenu = () => {
        if (!currentUser) return;
        const isHidden = accountMenu?.classList.contains('auth-hidden');
        accountMenu?.classList.toggle('auth-hidden', !isHidden);
        accountTrigger?.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    };

    const showAuthModal = () => {
        lastFocusedElement = document.activeElement;
        authModal?.classList.remove('modal-hidden');
        authModal?.classList.add('modal-visible');
        authModal?.setAttribute('aria-hidden', 'false');
        emailInput?.focus();
    };

    const hideAuthModal = () => {
        if (authModal?.contains(document.activeElement)) {
            document.activeElement.blur();
        }
        authModal?.classList.add('modal-hidden');
        authModal?.classList.remove('modal-visible');
        authModal?.setAttribute('aria-hidden', 'true');
        if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
            lastFocusedElement.focus();
        }
    };

    openAuthModal = showAuthModal;

    openAuthBtn?.addEventListener('click', showAuthModal);
    accountTrigger?.addEventListener('click', toggleAccountMenu);
    closeAuthModalBtn?.addEventListener('click', hideAuthModal);
    authModalOverlay?.addEventListener('click', hideAuthModal);
    document.addEventListener('click', (event) => {
        if (!accountUser || accountUser.classList.contains('auth-hidden')) return;
        if (!accountUser.contains(event.target)) {
            closeAccountMenu();
        }
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && authModal?.classList.contains('modal-visible')) {
            hideAuthModal();
        }

        if (event.key === 'Escape' && accountMenu && !accountMenu.classList.contains('auth-hidden')) {
            closeAccountMenu();
        }
    });

    const readCredentials = (mode = 'login') => {
        const email = emailInput?.value.trim() || '';
        const password = passwordInput?.value || '';
        if (!email) {
            alert('Ingresa un email válido.');
            return null;
        }

        if (mode === 'login' && password.length < 6) {
            alert('Ingresa tu contraseña (mínimo 6 caracteres).');
            return null;
        }

        if (mode === 'register') {
            const strength = validatePasswordStrength(password);
            if (!strength.isStrong) {
                alert('La contraseña debe tener al menos 8 caracteres e incluir mayúscula, minúscula, número y símbolo.');
                return null;
            }
        }

        return { email, password };
    };

    loginBtn?.addEventListener('click', async () => {
        const creds = readCredentials('login');
        if (!creds) return;
        try {
            await signInWithEmailAndPassword(auth, creds.email, creds.password);
            hideAuthModal();
        } catch (error) {
            console.error('Error iniciando sesión:', error);
            alert('No se pudo iniciar sesión. Verifica email y contraseña.');
        }
    });

    registerBtn?.addEventListener('click', async () => {
        const creds = readCredentials('register');
        if (!creds) return;
        try {
            await createUserWithEmailAndPassword(auth, creds.email, creds.password);
            alert('Cuenta creada correctamente.');
            hideAuthModal();
        } catch (error) {
            console.error('Error creando cuenta:', error);
            alert('No se pudo crear la cuenta. Revisa si el email ya existe.');
        }
    });

    googleBtn?.addEventListener('click', async () => {
        try {
            await signInWithPopup(auth, googleProvider);
            hideAuthModal();
        } catch (error) {
            const message = getGoogleAuthErrorMessage(error, 'login');
            if (message === 'cancelled') {
                console.info('Login con Google cancelado por el usuario.');
                return;
            }
            console.error('Error con Google Sign-In:', error);
            alert(message);
        }
    });

    resetBtn?.addEventListener('click', async () => {
        const email = emailInput?.value.trim() || '';
        if (!email) {
            alert('Escribe tu email para enviarte el enlace de recuperación.');
            return;
        }

        try {
            await sendPasswordResetEmail(auth, email);
            alert('Te enviamos un email para restablecer tu contraseña.');
        } catch (error) {
            console.error('Error enviando recovery email:', error);
            alert('No se pudo enviar el correo de recuperación. Revisa el email ingresado.');
        }
    });

    accountResetBtn?.addEventListener('click', async () => {
        if (!currentUser?.email) {
            alert('No hay una sesión activa para recuperar contraseña.');
            return;
        }

        try {
            await sendPasswordResetEmail(auth, currentUser.email);
            alert('Te enviamos un email para restablecer tu contraseña.');
            closeAccountMenu();
        } catch (error) {
            console.error('Error enviando recovery email:', error);
            alert('No se pudo enviar el correo de recuperación.');
        }
    });

    accountLogoutBtn?.addEventListener('click', async () => {
        try {
            await signOut(auth);
            closeAccountMenu();
        } catch (error) {
            console.error('Error cerrando sesión:', error);
            alert('No se pudo cerrar sesión.');
        }
    });

    onAuthStateChanged(auth, async (user) => {
        currentUser = user;
        updateAuthUI();
        await loadFlights();
    });

    updateAuthUI();
}

const continentColors = {
    'América del Sur': '#06b6d4',
    'América del Norte': '#3b82f6',
    'Europa': '#8b5cf6',
    'Asia': '#f59e0b',
    'Oceanía': '#22c55e',
    'Desconocido': '#6b7280'
};

// Base de datos de vuelos simulados
const flightDatabase = {
    // Viva
    'VB': { airline: 'Viva', routes: {
        '1100': { destination: 'Monterrey', distance: 710, country: 'México' }
    }},
    // LATAM
    'LA': { airline: 'LATAM', routes: {
        '8000': { destination: 'Santiago', distance: 1130, country: 'Chile' }
    }},
    // Aeromexico
    'AM': { airline: 'Aeromexico', routes: {
        '190': { origin: 'Ciudad de México', destination: 'Mexicali', distance: 2170, country: 'México' },
        '191': { origin: 'Ciudad de México', destination: 'Monterrey', distance: 710, country: 'México' },
        '192': { origin: 'Ciudad de México', destination: 'Cancún', distance: 1290, country: 'México' }
    }},
    // American Airlines
    'AA': { airline: 'American Airlines', routes: {
        '100': { destination: 'Nueva York', distance: 8500, country: 'Estados Unidos' },
        '101': { destination: 'Miami', distance: 4500, country: 'Estados Unidos' },
        '102': { destination: 'Chicago', distance: 7500, country: 'Estados Unidos' },
        '953': { destination: 'Nueva York', distance: 8500, country: 'Estados Unidos' },
        '950': { destination: 'Los Ángeles', distance: 9000, country: 'Estados Unidos' },
        '951': { destination: 'Miami', distance: 4500, country: 'Estados Unidos' },
        '952': { destination: 'Chicago', distance: 7500, country: 'Estados Unidos' }
    }},
    // Aerolineas Argentinas
    'AR': { airline: 'Aerolineas Argentinas', routes: {
        '1388': { origin: 'Buenos Aires', destination: 'Montevideo', distance: 230, country: 'Uruguay' },
        '1389': { origin: 'Montevideo', destination: 'Buenos Aires', distance: 230, country: 'Argentina' }
    }},
    // British Airways
    'BA': { airline: 'British Airways', routes: {
        '200': { destination: 'Londres', distance: 11000, country: 'Reino Unido' },
        '201': { destination: 'Manchester', distance: 11200, country: 'Reino Unido' }
    }},
    // Air France
    'AF': { airline: 'Air France', routes: {
        '300': { destination: 'París', distance: 10500, country: 'Francia' },
        '301': { destination: 'Lyon', distance: 10700, country: 'Francia' }
    }},
    // Lufthansa
    'LH': { airline: 'Lufthansa', routes: {
        '400': { destination: 'Berlín', distance: 12000, country: 'Alemania' },
        '401': { destination: 'Múnich', distance: 12200, country: 'Alemania' },
        '402': { destination: 'Fráncfort', distance: 11800, country: 'Alemania' }
    }},
    // Alitalia
    'AZ': { airline: 'Alitalia', routes: {
        '500': { destination: 'Roma', distance: 11500, country: 'Italia' },
        '501': { destination: 'Milán', distance: 11700, country: 'Italia' }
    }},
    // Iberia
    'IB': { airline: 'Iberia', routes: {
        '600': { destination: 'Madrid', distance: 10000, country: 'España' },
        '601': { destination: 'Barcelona', distance: 10100, country: 'España' }
    }},
    // KLM
    'KL': { airline: 'KLM', routes: {
        '700': { destination: 'Ámsterdam', distance: 11000, country: 'Países Bajos' }
    }},
    // Japan Airlines
    'JL': { airline: 'Japan Airlines', routes: {
        '800': { destination: 'Tokio', distance: 18000, country: 'Japón' },
        '801': { destination: 'Osaka', distance: 18200, country: 'Japón' }
    }},
    // Qantas
    'QF': { airline: 'Qantas', routes: {
        '900': { destination: 'Sídney', distance: 12000, country: 'Australia' },
        '901': { destination: 'Melbourne', distance: 11800, country: 'Australia' }
    }}
};

// Colores por aerolínea
const airlineColors = {
    'VB': '#4B5563', // Viva - Gris oscuro
    'LA': '#2E5C99', // LATAM - Azul
    'AM': '#FF6B35', // Aeromexico - Naranja rojizo
    'AA': '#0073CF', // American Airlines - Azul
    'AR': '#00AEEF', // Aerolineas Argentinas - Celeste
    'BA': '#2E5C99', // British Airways - Azul oscuro
    'AF': '#002157', // Air France - Azul marino
    'LH': '#E31937', // Lufthansa - Rojo
    'AZ': '#0066CC', // Alitalia - Azul claro
    'IB': '#D71920', // Iberia - Rojo
    'KL': '#00A1E4', // KLM - Azul cielo
    'JL': '#ED1A3A', // Japan Airlines - Rojo
    'QF': '#E31837'  // Qantas - Rojo
};

// Logos embebidos para evitar dependencias de red externas.
const airlineBrandAssets = {
    'VB': { logo: null },
    'LA': { logo: null },
    'AM': { logo: null },
    'AA': { logo: null },
    'AR': { logo: null },
    'BA': { logo: null },
    'AF': { logo: null },
    'LH': { logo: null },
    'AZ': { logo: null },
    'IB': { logo: null },
    'KL': { logo: null },
    'JL': { logo: null },
    'QF': { logo: null }
};

// Mapeo de ciudades a países para búsquedas inversas
const cityToCountryMap = {
    'Ciudad de México': 'México',
    'Mexicali': 'México',
    'Monterrey': 'México',
    'Cancún': 'México',
    'Nueva York': 'Estados Unidos',
    'Miami': 'Estados Unidos',
    'Chicago': 'Estados Unidos',
    'Los Ángeles': 'Estados Unidos',
    'México': 'México',
    'Santiago': 'Chile',
    'Santiago de Chile': 'Chile',
    'Londres': 'Reino Unido',
    'Manchester': 'Reino Unido',
    'París': 'Francia',
    'Lyon': 'Francia',
    'Berlín': 'Alemania',
    'Múnich': 'Alemania',
    'Fráncfort': 'Alemania',
    'Roma': 'Italia',
    'Milán': 'Italia',
    'Madrid': 'España',
    'Barcelona': 'España',
    'Ámsterdam': 'Países Bajos',
    'Tokio': 'Japón',
    'Osaka': 'Japón',
    'Sídney': 'Australia',
    'Melbourne': 'Australia',
    'Montevideo': 'Uruguay',
    'Buenos Aires': 'Argentina'
};

// Mapeo de países español a inglés para heatmap (incluyendo variantes)
const countrySpanishToEnglish = {
    'Estados Unidos': 'United States of America',
    'México': 'Mexico',
    'Reino Unido': 'United Kingdom',
    'Francia': 'France',
    'Alemania': 'Germany',
    'Italia': 'Italy',
    'España': 'Spain',
    'Países Bajos': 'Netherlands',
    'Japón': 'Japan',
    'Australia': 'Australia',
    'Chile': 'Chile',
    'Uruguay': 'Uruguay',
    'Argentina': 'Argentina',
    'Desconocido': 'Unknown'
};

// Mapeo de país a continente para KPI de cobertura.
const countryToContinentMap = {
    'argentina': 'América del Sur',
    'estados unidos': 'América del Norte',
    'united states of america': 'América del Norte',
    'mexico': 'América del Norte',
    'méxico': 'América del Norte',
    'reino unido': 'Europa',
    'united kingdom': 'Europa',
    'francia': 'Europa',
    'france': 'Europa',
    'alemania': 'Europa',
    'germany': 'Europa',
    'italia': 'Europa',
    'italy': 'Europa',
    'españa': 'Europa',
    'spain': 'Europa',
    'paises bajos': 'Europa',
    'países bajos': 'Europa',
    'netherlands': 'Europa',
    'japon': 'Asia',
    'japón': 'Asia',
    'japan': 'Asia',
    'australia': 'Oceanía',
    'chile': 'América del Sur',
    'uruguay': 'América del Sur'
};

const countryAliasToSpanish = {
    'united states': 'Estados Unidos',
    'united states of america': 'Estados Unidos',
    'usa': 'Estados Unidos',
    'u.s.a.': 'Estados Unidos',
    'united kingdom': 'Reino Unido',
    'uk': 'Reino Unido',
    'great britain': 'Reino Unido',
    'france': 'Francia',
    'germany': 'Alemania',
    'italy': 'Italia',
    'spain': 'España',
    'netherlands': 'Países Bajos',
    'japan': 'Japón',
    'australia': 'Australia',
    'us': 'Estados Unidos',
    'gb': 'Reino Unido',
    'mx': 'México',
    'ar': 'Argentina',
    'uy': 'Uruguay',
    'cl': 'Chile',
    'mexico': 'México',
    'chile': 'Chile',
    'uruguay': 'Uruguay',
    'argentina': 'Argentina',
    'unknown': 'Desconocido'
};

const airportKeywordToCity = {
    'aeroparque': 'Buenos Aires',
    'jorge newbery': 'Buenos Aires',
    'ezeiza': 'Buenos Aires',
    'pistarini': 'Buenos Aires',
    'gen mariano escobedo': 'Monterrey',
    'mariano escobedo': 'Monterrey',
    'benito juarez': 'Ciudad de México',
    'internacional benito juarez': 'Ciudad de México',
    'mexico city international': 'Ciudad de México',
    'arturo merino benitez': 'Santiago',
    'carrasco': 'Montevideo',
    'scl': 'Santiago',
    'mvd': 'Montevideo',
    'aep': 'Buenos Aires',
    'eze': 'Buenos Aires'
};

function normalizeText(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function normalizeDestinationCity(destination) {
    const raw = String(destination || '').trim();
    if (!raw) return 'Desconocido';
    if (cityToCountryMap[raw]) return raw;

    const normalized = normalizeText(raw);
    for (const [keyword, city] of Object.entries(airportKeywordToCity)) {
        if (normalized.includes(keyword)) {
            return city;
        }
    }

    const cleaned = raw
        .replace(/international airport/gi, '')
        .replace(/international/gi, '')
        .replace(/airport/gi, '')
        .replace(/aeropuerto/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

    if (cityToCountryMap[cleaned]) return cleaned;
    return raw;
}

function normalizeCountryName(country, destination = '') {
    const rawCountry = String(country || '').trim();
    const destinationCity = normalizeDestinationCity(destination);

    if (rawCountry) {
        if (cityToCountryMap[rawCountry]) return cityToCountryMap[rawCountry];
        const alias = countryAliasToSpanish[normalizeText(rawCountry)];
        if (alias) return alias;
        return rawCountry;
    }

    return cityToCountryMap[destinationCity] || 'Desconocido';
}

// Esperar a que Firebase esté listo
document.addEventListener('DOMContentLoaded', () => {
    initializeMap();
    setupFilters();
    setupAuthControls();
    setupDatabaseManager();
    setupAnimationControls();
    setupHeatmapControls();
    setupNetworkControls();
    setupForm();
});

function initializeMap() {
    // Crear el mapa centrado en el mundo
    map = L.map('map', {
        minZoom: 2.4,
        zoomSnap: 0.1,
        zoomDelta: 0.2,
        maxBounds: [[-85, -180], [85, 180]],
        maxBoundsViscosity: 1.0,
        attributionControl: false
    }).setView([20, 0], 2.4);
    
    // Estilo oscuro minimalista alineado con la UI
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
        attribution: '',
        maxZoom: 19,
        subdomains: 'abcd',
        noWrap: true
    }).addTo(map);
}

function setupFilters() {
    const radios = document.querySelectorAll('input[name="period"]');
    radios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            currentPeriod = e.target.value;
            stopAnimationMode(false);
            removeHeatmap();
            processFlights(allFlights);
        });
    });

    const tripTypeFilter = document.getElementById('trip-type-filter');
    if (tripTypeFilter) {
        tripTypeFilter.addEventListener('change', (e) => {
            currentTripType = e.target.value;
            stopAnimationMode(false);
            removeHeatmap();
            processFlights(allFlights);
        });
    }
}

function setupAnimationControls() {
    const toggleBtn = document.getElementById('toggle-animated-mode');
    if (!toggleBtn) return;

    toggleBtn.addEventListener('click', () => {
        if (isAnimationMode) {
            stopAnimationMode(false);
        } else {
            if (isNetworkMode) {
                disableNetworkMode(false);
            }
            startAnimationMode();
        }
    });
}

function setupHeatmapControls() {
    const heatmapBtn = document.getElementById('toggle-heatmap');
    if (!heatmapBtn) return;

    setHeatmapStatus('Heatmap apagado', 'idle');

    heatmapBtn.addEventListener('click', () => {
        if (isHeatmapMode) {
            removeHeatmap();
        } else {
            if (isNetworkMode) {
                disableNetworkMode(false);
            }
            renderHeatmap();
        }
    });
}

function setupNetworkControls() {
    const networkBtn = document.getElementById('toggle-network');
    const frequencyInput = document.getElementById('network-min-frequency');
    const frequencyValue = document.getElementById('network-min-frequency-value');
    if (!networkBtn) return;

    setNetworkStatus('Network apagado', 'idle');

    if (frequencyInput && frequencyValue) {
        frequencyInput.value = String(networkMinFrequency);
        frequencyValue.textContent = `${networkMinFrequency}+`;

        frequencyInput.addEventListener('input', () => {
            networkMinFrequency = Number(frequencyInput.value) || 1;
            frequencyValue.textContent = `${networkMinFrequency}+`;

            if (isNetworkMode) {
                renderNetworkGraph(lastFilteredFlights);
            }
        });
    }

    networkBtn.addEventListener('click', () => {
        if (isNetworkMode) {
            disableNetworkMode(true);
            return;
        }

        if (isAnimationMode) {
            stopAnimationMode(false);
        }

        if (isHeatmapMode) {
            removeHeatmap();
        }

        enableNetworkMode();
    });
}

function setHeatmapStatus(message, tone = 'idle') {
    const statusEl = document.getElementById('heatmap-status');
    if (!statusEl) return;

    statusEl.textContent = message;
    statusEl.classList.remove('status-idle', 'status-loading', 'status-ok', 'status-error');
    statusEl.classList.add(`status-${tone}`);
}

function setNetworkStatus(message, tone = 'idle') {
    const statusEl = document.getElementById('network-status');
    if (!statusEl) return;

    statusEl.textContent = message;
    statusEl.classList.remove('status-idle', 'status-loading', 'status-ok', 'status-error');
    statusEl.classList.add(`status-${tone}`);
}

function enableNetworkMode() {
    const networkBtn = document.getElementById('toggle-network');
    const mapEl = document.getElementById('map');
    const cyEl = document.getElementById('cytoscape-container');
    const panelEl = document.getElementById('network-hubs-panel');
    const frequencyControl = document.getElementById('network-frequency-control');

    if (!window.cytoscape) {
        setNetworkStatus('Cytoscape no cargado', 'error');
        return;
    }

    if (!mapEl || !cyEl) {
        setNetworkStatus('Contenedor no disponible', 'error');
        return;
    }

    isNetworkMode = true;
    networkBtn?.classList.add('active');
    mapEl.classList.add('network-background');
    cyEl.classList.add('active');
    panelEl?.classList.add('active');
    frequencyControl?.classList.add('active');
    setNetworkStatus('Construyendo red...', 'loading');

    renderNetworkGraph(lastFilteredFlights);
}

function disableNetworkMode(restoreMap = true) {
    const networkBtn = document.getElementById('toggle-network');
    const mapEl = document.getElementById('map');
    const cyEl = document.getElementById('cytoscape-container');
    const panelEl = document.getElementById('network-hubs-panel');
    const frequencyControl = document.getElementById('network-frequency-control');

    isNetworkMode = false;
    networkBtn?.classList.remove('active');
    mapEl?.classList.remove('network-background');
    cyEl?.classList.remove('active');
    panelEl?.classList.remove('active');
    frequencyControl?.classList.remove('active');

    if (networkGraph) {
        networkGraph.destroy();
        networkGraph = null;
    }

    const hubsList = document.getElementById('network-hubs-list');
    if (hubsList) hubsList.innerHTML = '';

    setNetworkStatus('Network apagado', 'idle');

    if (restoreMap && lastFilteredFlights.length && !isAnimationMode) {
        renderMap(lastFilteredFlights);
    }
}

function sanitizeNodeId(value) {
    return String(value || 'unknown')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .toLowerCase();
}

function renderNetworkGraph(flights) {
    if (!isNetworkMode) return;

    const cyEl = document.getElementById('cytoscape-container');
    if (!cyEl) {
        setNetworkStatus('Contenedor no disponible', 'error');
        return;
    }

    if (networkGraph) {
        networkGraph.destroy();
        networkGraph = null;
    }

    const validFlights = (flights || []).filter(f => f.origin && f.destination);
    if (!validFlights.length) {
        setNetworkStatus('Sin vuelos para filtros actuales', 'error');
        renderNetworkHubsPanel([]);
        return;
    }

    const airportCountryMap = new Map();
    const nodeStats = new Map();
    const edgeStats = new Map();

    validFlights.forEach((flight) => {
        const origin = flight.origin || 'Buenos Aires';
        const destination = flight.destination;
        const routeKey = `${origin}__${destination}`;

        const originCountry = cityToCountryMap[origin] || 'Desconocido';
        const destinationCountry = flight.country || cityToCountryMap[destination] || 'Desconocido';
        if (!airportCountryMap.has(origin)) {
            airportCountryMap.set(origin, originCountry);
        }
        if (!airportCountryMap.has(destination)) {
            airportCountryMap.set(destination, destinationCountry);
        }

        nodeStats.set(origin, (nodeStats.get(origin) || 0) + 1);
        nodeStats.set(destination, (nodeStats.get(destination) || 0) + 1);

        if (!edgeStats.has(routeKey)) {
            edgeStats.set(routeKey, {
                source: origin,
                target: destination,
                count: 0,
                airlines: new Set()
            });
        }

        const edge = edgeStats.get(routeKey);
        edge.count += 1;
        const airlineCode = (flight.flightNumber || '').substring(0, 2).toUpperCase();
        if (airlineCode) edge.airlines.add(airlineCode);
    });

    const maxObservedFrequency = Math.max(...Array.from(edgeStats.values()).map(e => e.count), 1);
    const frequencyInput = document.getElementById('network-min-frequency');
    const frequencyValue = document.getElementById('network-min-frequency-value');
    if (frequencyInput) {
        frequencyInput.max = String(maxObservedFrequency);
        if (networkMinFrequency > maxObservedFrequency) {
            networkMinFrequency = maxObservedFrequency;
            frequencyInput.value = String(networkMinFrequency);
        }
    }
    if (frequencyValue) {
        frequencyValue.textContent = `${networkMinFrequency}+`;
    }

    const filteredEdgeEntries = Array.from(edgeStats.values()).filter(edge => edge.count >= networkMinFrequency);

    if (!filteredEdgeEntries.length) {
        setNetworkStatus(`Sin rutas con frecuencia >= ${networkMinFrequency}`, 'error');
        renderNetworkHubsPanel([]);
        return;
    }

    const nodeIdsInUse = new Set();
    filteredEdgeEntries.forEach(edge => {
        nodeIdsInUse.add(edge.source);
        nodeIdsInUse.add(edge.target);
    });

    const filteredNodeStats = new Map();
    nodeIdsInUse.forEach(airport => {
        filteredNodeStats.set(airport, nodeStats.get(airport) || 0);
    });

    const nodeCounts = Array.from(filteredNodeStats.values());
    const maxNodeCount = Math.max(...nodeCounts, 1);
    const edgeCounts = filteredEdgeEntries.map(e => e.count);
    const maxEdgeCount = Math.max(...edgeCounts, 1);

    const nodes = Array.from(filteredNodeStats.entries()).map(([airport, count]) => {
        const nodeId = `airport_${sanitizeNodeId(airport)}`;
        const size = 24 + (count / maxNodeCount) * 34;
        const airportCountry = airportCountryMap.get(airport) || 'Desconocido';
        const continent = getContinentFromCountry(airportCountry) || 'Desconocido';
        const color = continentColors[continent] || continentColors.Desconocido;
        return {
            data: {
                id: nodeId,
                label: airport,
                flights: count,
                size,
                continent,
                country: airportCountry,
                color
            }
        };
    });

    const edges = filteredEdgeEntries.map((edge) => {
        const edgeId = `route_${sanitizeNodeId(edge.source)}_${sanitizeNodeId(edge.target)}`;
        const width = 1.5 + (edge.count / maxEdgeCount) * 7;
        return {
            data: {
                id: edgeId,
                source: `airport_${sanitizeNodeId(edge.source)}`,
                target: `airport_${sanitizeNodeId(edge.target)}`,
                count: edge.count,
                airlines: Array.from(edge.airlines).join(', ') || 'N/A',
                width,
                label: `${edge.count}`
            }
        };
    });

    networkGraph = window.cytoscape({
        container: cyEl,
        elements: [...nodes, ...edges],
        style: [
            {
                selector: 'node',
                style: {
                    label: 'data(label)',
                    width: 'data(size)',
                    height: 'data(size)',
                    'background-color': 'data(color)',
                    color: '#f3f3f3',
                    'font-size': 10,
                    'text-wrap': 'wrap',
                    'text-max-width': 72,
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'border-width': 1.5,
                    'border-color': '#f5f5f5'
                }
            },
            {
                selector: 'edge',
                style: {
                    width: 'data(width)',
                    'line-color': '#5f6b7a',
                    'target-arrow-color': '#5f6b7a',
                    'target-arrow-shape': 'triangle',
                    'curve-style': 'bezier',
                    opacity: 0.85,
                    label: 'data(label)',
                    'font-size': 9,
                    color: '#d4d4d4',
                    'text-background-color': 'rgba(10, 10, 10, 0.75)',
                    'text-background-opacity': 1,
                    'text-background-padding': 2
                }
            },
            {
                selector: ':selected',
                style: {
                    'overlay-opacity': 0,
                    'border-color': '#ffffff',
                    'line-color': '#ffffff',
                    'target-arrow-color': '#ffffff'
                }
            }
        ],
        layout: {
            name: 'cose',
            animate: true,
            animationDuration: 900,
            fit: true,
            padding: 36,
            randomize: true,
            idealEdgeLength: 140,
            nodeRepulsion: 700000,
            edgeElasticity: 120,
            gravity: 0.65,
            numIter: 1200
        }
    });

    networkGraph.on('tap', 'node', (evt) => {
        const node = evt.target.data();
        setNetworkStatus(`Hub: ${node.label} • ${node.flights} vuelos • ${node.continent}`, 'ok');
    });

    networkGraph.on('tap', 'edge', (evt) => {
        const edge = evt.target.data();
        setNetworkStatus(`Ruta: ${edge.count} vuelos • Aerolíneas ${edge.airlines}`, 'ok');
    });

    renderNetworkHubsPanel(Array.from(filteredNodeStats.entries()));
    setNetworkStatus(`Network activo • ${nodes.length} nodos • ${edges.length} rutas (>= ${networkMinFrequency})`, 'ok');
}

function renderNetworkHubsPanel(hubEntries) {
    const hubsList = document.getElementById('network-hubs-list');
    if (!hubsList) return;

    hubsList.innerHTML = '';

    if (!hubEntries || !hubEntries.length) {
        const empty = document.createElement('li');
        empty.textContent = 'Sin hubs para el filtro actual';
        hubsList.appendChild(empty);
        return;
    }

    hubEntries
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .forEach(([airport, flights]) => {
            const item = document.createElement('li');
            item.textContent = `${airport} - ${flights} vuelos`;
            hubsList.appendChild(item);
        });
}

function renderHeatmap() {
    if (!map) {
        setHeatmapStatus('Error: mapa no inicializado', 'error');
        return;
    }

    if (!allFlights || allFlights.length === 0) {
        setHeatmapStatus('No hay vuelos registrados', 'error');
        return;
    }

    setHeatmapStatus('Procesando heatmap...', 'loading');

    // Aplicar filtros actuales para obtener vuelos visibles
    const periodFilteredFlights = getFlightsByPeriod(allFlights, currentPeriod);
    const filteredFlights = getFlightsByTripType(periodFilteredFlights, currentTripType);

    if (!filteredFlights || filteredFlights.length === 0) {
        setHeatmapStatus('Sin vuelos para filtros actuales', 'error');
        return;
    }

    // Contar vuelos por país (en español)
    const countryCounts = {};
    filteredFlights.forEach(flight => {
        const country = flight.country || 'Desconocido';
        if (!countryCounts[country]) {
            countryCounts[country] = 0;
        }
        countryCounts[country] += 1;
    });

    // Convertir a inglés usando el mapping
    const countryCountsEnglish = {};
    for (let [spanishName, count] of Object.entries(countryCounts)) {
        if (!spanishName || typeof spanishName !== 'string') {
            continue;
        }
        const englishName = countrySpanishToEnglish[spanishName] || spanishName;
        countryCountsEnglish[englishName] = count;
    }

    if (!countryCountsEnglish || typeof countryCountsEnglish !== 'object' || Object.keys(countryCountsEnglish).length === 0) {
        setHeatmapStatus('No se pudieron procesar países', 'error');
        return;
    }

    const counts = Object.values(countryCountsEnglish).filter(c => typeof c === 'number' && c > 0);
    if (counts.length === 0) {
        setHeatmapStatus('No se pudieron mapear países', 'error');
        return;
    }

    const maxFlights = Math.max(...counts);

    // GUARDAR en variable del scope para acceso en .then()
    const countryMapData = { ...countryCountsEnglish };
    const maxFlightsValue = maxFlights;

    // Cargar GeoJSON de países
    fetch('https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson')
        .then(res => {
            if (!res.ok) throw new Error('GeoJSON HTTP ' + res.status);
            return res.json();
        })
        .then(geojson => {
            if (!geojson.features || geojson.features.length === 0) {
                throw new Error('GeoJSON sin features');
            }

            let matchedCountries = 0;

            heatmapLayer = L.geoJSON(geojson, {
                style: (feature) => {
                    const geoCountryName = feature.properties?.ADMIN || feature.properties?.name;
                    if (!geoCountryName) {
                        return {
                            fillColor: '#1a1a2e',
                            weight: 0.5,
                            opacity: 1,
                            color: '#000',
                            fillOpacity: 0.7
                        };
                    }

                    const flightCount = findCountryMatch(geoCountryName, countryMapData);

                    if (flightCount > 0) {
                        matchedCountries++;
                    }

                    let color = '#1a1a2e'; // Sin vuelos
                    if (flightCount > 0) {
                        const intensity = flightCount / maxFlightsValue;
                        color = getHeatmapColor(intensity);
                    }

                    return {
                        fillColor: color,
                        weight: 0.5,
                        opacity: 1,
                        color: '#000',
                        fillOpacity: 0.7
                    };
                },
                onEachFeature: (feature, layer) => {
                    const geoCountryName = feature.properties?.ADMIN || feature.properties?.name;
                    const flightCount = findCountryMatch(geoCountryName, countryMapData);

                    if (flightCount > 0) {
                        layer.bindPopup(`<strong>${geoCountryName}</strong><br>Vuelos: ${flightCount}`);
                    }
                }
            }).addTo(map);

            isHeatmapMode = true;
            const btn = document.getElementById('toggle-heatmap');
            if (btn) btn.classList.add('active');

            if (matchedCountries === 0) {
                setHeatmapStatus('0 países coloreados', 'error');
                return;
            }

            setHeatmapStatus(`${matchedCountries} países coloreados`, 'ok');
        })
        .catch(err => {
            console.error('Error en renderHeatmap:', err);
            setHeatmapStatus(`Error: ${err.message}`, 'error');
        });
}

function removeHeatmap() {
    if (heatmapLayer && map) {
        map.removeLayer(heatmapLayer);
        heatmapLayer = null;
    }
    
    isHeatmapMode = false;
    const btn = document.getElementById('toggle-heatmap');
    if (btn) btn.classList.remove('active');
    setHeatmapStatus('Heatmap apagado', 'idle');
    
    // Re-renderizar el mapa normal
    if (lastFilteredFlights.length && !isNetworkMode) {
        renderMap(lastFilteredFlights);
    }
}

function getHeatmapColor(intensity) {
    // Gradiente de color basado en intensidad (pastel a vibrante)
    if (intensity < 0.2) return '#e8f4f8';      // Azul muy claro
    if (intensity < 0.4) return '#b3dfe8';      // Azul claro
    if (intensity < 0.6) return '#7ec8d9';      // Azul medio
    if (intensity < 0.8) return '#4a9fb5';      // Azul más oscuro
    return '#1a5f7a';                           // Azul oscuro
}

// Función auxiliar para hacer matching flexible de nombres de países
function findCountryMatch(geoCountryName, countryCountsEnglish) {
    if (!geoCountryName || typeof geoCountryName !== 'string') {
        return 0;
    }

    if (!countryCountsEnglish || typeof countryCountsEnglish !== 'object') {
        return 0;
    }

    const normalize = (value) => String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\./g, '')
        .trim()
        .toLowerCase();

    const normalizedGeo = normalize(geoCountryName);

    // 1. Búsqueda exacta
    if (countryCountsEnglish[geoCountryName]) {
        return countryCountsEnglish[geoCountryName];
    }

    // 1.1 Búsqueda exacta normalizada
    for (const [countryName, count] of Object.entries(countryCountsEnglish)) {
        if (normalize(countryName) === normalizedGeo) {
            return count;
        }
    }

    // 2. Búsqueda con variantes (USA vs United States)
    const variants = {
        'United States of America': ['United States', 'USA', 'US'],
        'United States': ['United States of America', 'USA', 'US'],
        'United Kingdom': ['UK', 'Britain', 'Great Britain'],
        'Netherlands': ['Holland'],
        'Czechia': ['Czech Republic'],
        'Bosnia and Herzegovina': ['Bosnia'],
        'Republic of Serbia': ['Serbia'],
        'Republic of Moldova': ['Moldova']
    };

    try {
        if (variants[geoCountryName]) {
            for (let variant of variants[geoCountryName]) {
                if (countryCountsEnglish[variant]) {
                    return countryCountsEnglish[variant];
                }
            }
        }

        // 3. Búsqueda parcial (si contiene la mayoría de letras)
        for (let [countryName, count] of Object.entries(countryCountsEnglish)) {
            if (!countryName || typeof countryName !== 'string' || !count) continue;
            
            try {
                const geoLower = normalizedGeo;
                const countryLower = normalize(countryName);
                const geoFirstWord = geoLower.split(' ')[0];
                const countryFirstWord = countryLower.split(' ')[0];
                
                if ((geoFirstWord && countryLower.includes(geoFirstWord)) ||
                    (countryFirstWord && geoLower.includes(countryFirstWord))) {
                    return count;
                }
            } catch (e) {
                continue;
            }
        }
    } catch (e) {
        return 0;
    }

    return 0;
}

function startAnimationMode() {
    if (!lastFilteredFlights.length) {
        alert('No hay vuelos para reproducir con los filtros actuales.');
        return;
    }

    const toggleBtn = document.getElementById('toggle-animated-mode');
    const status = document.getElementById('timeline-status');

    const timelineFlights = [...lastFilteredFlights].sort((a, b) => {
        const dateCompare = new Date(a.date) - new Date(b.date);
        if (dateCompare !== 0) return dateCompare;
        return (a.flightNumber || '').localeCompare(b.flightNumber || '');
    });

    isAnimationMode = true;
    toggleBtn?.classList.add('active');
    if (toggleBtn) toggleBtn.textContent = 'Detener';
    if (status) status.textContent = `Timeline 1/${timelineFlights.length}`;

    let index = 0;
    const processNextFlight = () => {
        if (!isAnimationMode) return;

        if (index >= timelineFlights.length) {
            stopAnimationMode(true);
            return;
        }

        const currentFlight = timelineFlights[index];
        const partialFlights = timelineFlights.slice(0, index + 1);

        if (status) {
            status.textContent = `Timeline ${index + 1}/${timelineFlights.length} • ${currentFlight.date} • ${currentFlight.flightNumber}`;
        }

        index += 1;

        // Animar el vuelo actual y luego pasar al siguiente
        animateFlight(currentFlight, partialFlights, () => {
            if (isAnimationMode) {
                animationTimerId = setTimeout(processNextFlight, 500);
            }
        });
    };

    processNextFlight();
}

function stopAnimationMode(completed) {
    if (animationTimerId) {
        clearInterval(animationTimerId);
        animationTimerId = null;
    }

    const toggleBtn = document.getElementById('toggle-animated-mode');
    const status = document.getElementById('timeline-status');

    isAnimationMode = false;
    toggleBtn?.classList.remove('active');
    if (toggleBtn) toggleBtn.textContent = 'Modo Animado';
    if (status) status.textContent = completed ? 'Timeline finalizado' : 'Modo normal';

    if (lastFilteredFlights.length && !isNetworkMode) {
        renderMap(lastFilteredFlights);
    }
}

function animateFlight(flight, sourceFlights, callback) {
    if (!map) return callback();

    // Coordenadas de ciudades
    const cityCoords = {
        'Nueva York': [40.7128, -74.0060],
        'Miami': [25.7617, -80.1918],
        'Chicago': [41.8781, -87.6298],
        'Los Ángeles': [34.0522, -118.2437],
        'México': [19.4326, -99.1332],
        'Londres': [51.5074, -0.1278],
        'Manchester': [53.4808, -2.2426],
        'París': [48.8566, 2.3522],
        'Lyon': [45.7640, 4.8357],
        'Tokio': [35.6762, 139.6503],
        'Osaka': [34.6937, 135.5023],
        'Sídney': [-33.8688, 151.2093],
        'Melbourne': [-37.8136, 144.9631],
        'Roma': [41.9028, 12.4964],
        'Madrid': [40.4168, -3.7038],
        'Barcelona': [41.3851, 2.1734],
        'Berlín': [52.5200, 13.4050],
        'Múnich': [48.1351, 11.5820],
        'Fráncfort': [50.1109, 8.6821],
        'Ámsterdam': [52.3676, 4.9041],
        'Buenos Aires': [-34.6037, -58.3816]
    };

    const origin = flight.origin || 'Buenos Aires';
    const originCoords = cityCoords[origin];
    const destCoords = cityCoords[flight.destination];

    if (!destCoords || !originCoords) {
        renderMap(sourceFlights);
        callback();
        return;
    }

    // Renderizar todos los vuelos excepto el actual (que se va a animar)
    const previousFlights = sourceFlights.slice(0, -1);
    renderMap(previousFlights);

    // Obtener la ruta curva
    const arcCoords = buildArcCoordinates(originCoords, destCoords, 1);
    const airlineCode = (flight.flightNumber || '').substring(0, 2).toUpperCase();

    // Crear marcador de avión como emoji
    const planeMarker = L.marker(originCoords, {
        icon: L.divIcon({
            html: '<div style="font-size: 28px; transform: rotate(45deg); filter: drop-shadow(0 0 4px rgba(255,255,255,0.6));">✈️</div>',
            iconSize: [32, 32],
            iconAnchor: [16, 16],
            className: 'animated-plane'
        })
    }).addTo(map);

    // Animar el avión a lo largo de la ruta
    let pathIndex = 0;
    const animationInterval = setInterval(() => {
        if (!isAnimationMode) {
            clearInterval(animationInterval);
            if (map.hasLayer(planeMarker)) {
                map.removeLayer(planeMarker);
            }
            return;
        }

        if (pathIndex >= arcCoords.length) {
            clearInterval(animationInterval);
            if (map.hasLayer(planeMarker)) {
                map.removeLayer(planeMarker);
            }

            // Renderizar el vuelo como completado
            renderMap(sourceFlights);
            callback();
            return;
        }

        planeMarker.setLatLng(arcCoords[pathIndex]);
        pathIndex++;
    }, 25); // 25ms por paso = ~1.2s para 48 puntos
}

function estimateDurationHours(distanceKm) {
    // Estimacion simple: velocidad crucero + tiempos de despegue/aterrizaje.
    const avgCruiseSpeedKmh = 840;
    const groundOpsHours = 0.75;
    const rawHours = (distanceKm || 0) / avgCruiseSpeedKmh + groundOpsHours;
    return Number(rawHours.toFixed(2));
}

function getCountryFromCity(destination) {
    // Función auxiliar para obtener país de una ciudad
    return cityToCountryMap[destination] || 'Desconocido';
}

function formatDuration(totalHours) {
    const totalMinutes = Math.round((totalHours || 0) * 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${hours} h ${minutes} min`;
}

function renderRatingStars(rating) {
    const safeRating = Math.min(5, Math.max(1, Number(rating) || 1));
    return `${'★'.repeat(safeRating)}${'☆'.repeat(5 - safeRating)}`;
}

function buildAirlineLogoDataUri(airlineCode) {
    const bgColor = airlineColors[airlineCode] || '#1f2937';
    const safeCode = String(airlineCode || 'XX').slice(0, 2).toUpperCase();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${safeCode}"><rect width="64" height="64" rx="32" fill="${bgColor}"/><text x="32" y="40" text-anchor="middle" font-size="22" font-family="Arial, sans-serif" font-weight="700" fill="#ffffff">${safeCode}</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function getAirlineLogoHTML(airlineCode, airlineName, size = 16) {
    const logoUrl = airlineBrandAssets[airlineCode]?.logo || buildAirlineLogoDataUri(airlineCode);
    const safeName = airlineName || airlineCode;
    const fallbackSize = Math.max(9, size - 6);

    if (!logoUrl) {
        return `<span style="width:${size}px;height:${size}px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:#1f2937;color:#f9fafb;font-size:${Math.max(9, size - 6)}px;font-weight:700;">${airlineCode}</span>`;
    }

    return `<span style="width:${size}px;height:${size}px;display:inline-flex;align-items:center;justify-content:center;vertical-align:middle;">
        <img src="${logoUrl}" alt="${safeName}" width="${size}" height="${size}" loading="lazy" referrerpolicy="no-referrer" style="border-radius:50%;background:#fff;object-fit:contain;display:block;" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex';">
        <span style="display:none;width:${size}px;height:${size}px;border-radius:50%;align-items:center;justify-content:center;background:#1f2937;color:#f9fafb;font-size:${fallbackSize}px;font-weight:700;">${airlineCode}</span>
    </span>`;
}

function getAirlineMarkerBadgeHTML(airlineCode, airlineName) {
    return `<span class="marker-logo-badge">${getAirlineLogoHTML(airlineCode, airlineName, 12)}</span>`;
}

function setupDatabaseManager() {
    const openBtn = document.getElementById('open-db-manager');
    const closeBtn = document.getElementById('close-db-manager');
    const overlay = document.getElementById('db-modal-overlay');
    const modal = document.getElementById('db-modal');
    const addForm = document.getElementById('db-add-form');
    const tableBody = document.getElementById('db-table-body');
    const resetBtn = document.getElementById('db-reset-all');
    let lastFocusedElement = null;

    const openModal = () => {
        if (!ensureAuthenticated()) return;
        lastFocusedElement = document.activeElement;
        modal.classList.remove('modal-hidden');
        modal.classList.add('modal-visible');
        modal.setAttribute('aria-hidden', 'false');
        renderDatabaseTable(allFlights);
        closeBtn?.focus();
    };

    const closeModal = () => {
        // Evita ocultar un contenedor que todavía retiene foco interno.
        if (modal.contains(document.activeElement)) {
            document.activeElement.blur();
        }
        modal.classList.add('modal-hidden');
        modal.classList.remove('modal-visible');
        modal.setAttribute('aria-hidden', 'true');
        if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
            lastFocusedElement.focus();
        }
    };

    openBtn?.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', closeModal);
    overlay?.addEventListener('click', closeModal);

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && modal.classList.contains('modal-visible')) {
            closeModal();
        }
    });

    addForm?.addEventListener('submit', async (event) => {
        event.preventDefault();

        const flightNumber = document.getElementById('db-flight-number').value.trim().toUpperCase();
        const date = document.getElementById('db-date').value;
        const distance = Number(document.getElementById('db-distance').value);
        const origin = document.getElementById('db-origin').value.trim();
        const destination = document.getElementById('db-destination').value.trim();
        const country = document.getElementById('db-country').value.trim();
        const category = document.getElementById('db-category').value;
        const rating = Number(document.getElementById('db-rating').value || 5);

        if (!flightNumber || !date || !distance || !origin || !destination || !country) {
            alert('Completa todos los campos para agregar un vuelo manual.');
            return;
        }

        const flightsRef = getFlightsCollectionRef();
        if (!flightsRef) {
            alert('Inicia sesión para guardar vuelos.');
            return;
        }

        try {
            await addDoc(flightsRef, {
                origin,
                flightNumber,
                date,
                distance,
                destination,
                country,
                category,
                rating,
                durationHours: estimateDurationHours(distance)
            });

            addForm.reset();
            document.getElementById('db-origin').value = 'Buenos Aires';
            document.getElementById('db-category').value = 'Personal';
            document.getElementById('db-rating').value = '5';
            await loadFlights();
            renderDatabaseTable(allFlights);
        } catch (error) {
            console.error('Error agregando vuelo manual:', error);
            alert('No se pudo agregar el vuelo manualmente.');
        }
    });

    resetBtn?.addEventListener('click', async () => {
        const shouldReset = confirm('Esto eliminará TODOS los vuelos de la base de datos. ¿Continuar?');
        if (!shouldReset) return;

        const flightsRef = getFlightsCollectionRef();
        if (!flightsRef) {
            alert('Inicia sesión para resetear tu base.');
            return;
        }

        try {
            const snapshot = await getDocs(flightsRef);
            if (snapshot.empty) {
                alert('La base ya está vacía.');
                return;
            }

            for (const docSnapshot of snapshot.docs) {
                await deleteDoc(docSnapshot.ref);
            }

            await loadFlights();
            renderDatabaseTable(allFlights);
            alert('Base de datos reseteada. Ahora está vacía.');
        } catch (error) {
            console.error('Error reseteando la base de datos:', error);
            alert('No se pudo resetear la base de datos.');
        }
    });

    tableBody?.addEventListener('click', async (event) => {
        const target = event.target;
        const button = target.closest('button[data-action][data-id]');
        if (!button) return;

        const flightId = button.getAttribute('data-id');
        const action = button.getAttribute('data-action');
        const row = target.closest('tr');

        if (!flightId || !row) return;

        if (action === 'delete') {
            if (!confirm('¿Eliminar este registro?')) return;
            if (!currentUser) {
                alert('Inicia sesión para eliminar registros.');
                return;
            }
            try {
                await deleteDoc(doc(window.db, 'users', currentUser.uid, 'flights', flightId));
                await loadFlights();
                renderDatabaseTable(allFlights);
            } catch (error) {
                console.error('Error eliminando vuelo:', error);
                alert('No se pudo eliminar el registro.');
            }
            return;
        }

        if (action === 'save') {
            const payload = {
                flightNumber: row.querySelector('[data-field="flightNumber"]').value.trim().toUpperCase(),
                date: row.querySelector('[data-field="date"]').value,
                origin: row.querySelector('[data-field="origin"]').value.trim(),
                destination: row.querySelector('[data-field="destination"]').value.trim(),
                country: row.querySelector('[data-field="country"]').value.trim(),
                distance: Number(row.querySelector('[data-field="distance"]').value),
                category: row.querySelector('[data-field="category"]').value,
                rating: Number(row.querySelector('[data-field="rating"]').value || 5)
            };

            if (!payload.flightNumber || !payload.date || !payload.origin || !payload.destination || !payload.country || !payload.distance) {
                alert('Completa los campos obligatorios antes de guardar.');
                return;
            }

            payload.durationHours = estimateDurationHours(payload.distance);

            try {
                if (!currentUser) {
                    alert('Inicia sesión para actualizar registros.');
                    return;
                }
                await updateDoc(doc(window.db, 'users', currentUser.uid, 'flights', flightId), payload);
                await loadFlights();
                renderDatabaseTable(allFlights);
            } catch (error) {
                console.error('Error actualizando vuelo:', error);
                alert('No se pudo actualizar el registro.');
            }
        }
    });
}

function renderDatabaseTable(flights) {
    const tableBody = document.getElementById('db-table-body');
    if (!tableBody) return;

    const sortedFlights = [...flights].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    tableBody.innerHTML = sortedFlights.map((flight) => {
        const id = flight.id || '';
        const flightNumber = escapeHtml(flight.flightNumber || '');
        const date = escapeHtml(flight.date || '');
        const origin = escapeHtml(flight.origin || 'Buenos Aires');
        const destination = escapeHtml(flight.destination || '');
        const country = escapeHtml(flight.country || '');
        const distance = Number(flight.distance || 0);
        const category = flight.category || 'Personal';
        const rating = Number(flight.rating || 5);

        return `
            <tr>
                <td><input class="db-input" data-field="flightNumber" value="${flightNumber}"></td>
                <td><input class="db-input" data-field="date" type="date" value="${date}"></td>
                <td><input class="db-input" data-field="origin" value="${origin}"></td>
                <td><input class="db-input" data-field="destination" value="${destination}"></td>
                <td><input class="db-input" data-field="country" value="${country}"></td>
                <td><input class="db-input" data-field="distance" type="number" min="100" step="10" value="${distance}"></td>
                <td>
                    <select class="db-select" data-field="category">
                        <option value="Personal" ${category === 'Personal' ? 'selected' : ''}>Personal</option>
                        <option value="Trabajo" ${category === 'Trabajo' ? 'selected' : ''}>Trabajo</option>
                    </select>
                </td>
                <td>
                    <select class="db-select" data-field="rating">
                        ${[1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${value === rating ? 'selected' : ''}>${value}</option>`).join('')}
                    </select>
                </td>
                <td>
                    <div class="db-actions">
                        <button class="db-btn save" data-action="save" data-id="${id}">Guardar</button>
                        <button class="db-btn delete" data-action="delete" data-id="${id}">Eliminar</button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function lookupFlight(flightNumber) {
    const compact = String(flightNumber || '').trim().toUpperCase().replace(/\s+/g, '').replace(/-/g, '');
    const match = compact.match(/^([A-Z]{2,3})(\d{1,4})$/);
    if (!match) return null;

    const code = match[1];
    const number = match[2];
    
    if (flightDatabase[code] && flightDatabase[code].routes[number]) {
        return flightDatabase[code].routes[number];
    }
    return null;
}

async function setupForm() {
    const form = document.getElementById('flight-form');
    const flightNumberInput = document.getElementById('flight-number');
    const categoryInput = document.getElementById('category');
    const dateInput = document.getElementById('date');
    const loadSampleBtn = document.getElementById('load-sample');
    const submitBtn = document.getElementById('submit-btn');
    const flightInfo = document.getElementById('flight-info');
    const flightError = document.getElementById('flight-error');
    const openRegisterModalBtn = document.getElementById('open-register-modal');
    const closeRegisterModalBtn = document.getElementById('close-register-modal');
    const modalOverlay = document.getElementById('modal-overlay');
    const flightModal = document.getElementById('flight-modal');
    let lastFocusedElement = null;

    const openModal = () => {
        if (!ensureAuthenticated()) return;
        lastFocusedElement = document.activeElement;
        flightModal.classList.remove('modal-hidden');
        flightModal.classList.add('modal-visible');
        flightModal.setAttribute('aria-hidden', 'false');
        closeRegisterModalBtn?.focus();
    };

    const closeModal = () => {
        // Evita warning de aria-hidden cuando el foco sigue dentro del modal.
        if (flightModal.contains(document.activeElement)) {
            document.activeElement.blur();
        }
        flightModal.classList.add('modal-hidden');
        flightModal.classList.remove('modal-visible');
        flightModal.setAttribute('aria-hidden', 'true');
        if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
            lastFocusedElement.focus();
        }
    };

    openRegisterModalBtn.addEventListener('click', openModal);
    closeRegisterModalBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', closeModal);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && flightModal.classList.contains('modal-visible')) {
            closeModal();
        }
    });

    flightNumberInput.addEventListener('blur', async () => {
        const flightNumber = flightNumberInput.value.trim();
        if (flightNumber.length >= 3) {
            submitBtn.disabled = true;
            const flightData = await lookupFlightWithFallback(flightNumber);
            if (flightData) {
                currentFlightData = flightData;
                const estimatedDuration = estimateDurationHours(flightData.distance);
                const routeOrigin = flightData.origin || 'Buenos Aires';
                document.getElementById('info-origin').textContent = routeOrigin;
                document.getElementById('info-destination').textContent = flightData.destination;
                document.getElementById('info-distance').textContent = flightData.distance + ' km';
                document.getElementById('info-duration').textContent = formatDuration(estimatedDuration);
                document.getElementById('info-country').textContent = flightData.country;
                flightInfo.style.display = 'block';
                flightError.style.display = 'none';
                submitBtn.disabled = false;
            } else {
                flightInfo.style.display = 'none';
                flightError.style.display = 'block';
                flightError.textContent = '❌ Vuelo no encontrado en API o backend no disponible.';
                submitBtn.disabled = true;
                currentFlightData = null;
            }
        }
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        if (!currentFlightData) {
            alert('Por favor, ingresa un número de vuelo válido');
            return;
        }

        const flightNumber = flightNumberInput.value.trim();
        const date = dateInput.value;
        const category = categoryInput.value;
        const rating = Number(document.querySelector('input[name="rating"]:checked')?.value || 5);
        const origin = currentFlightData.origin || 'Buenos Aires';
        const destination = currentFlightData.destination;
        const distance = currentFlightData.distance;
        const durationHours = estimateDurationHours(distance);
        const country = currentFlightData.country;

        const flightsRef = getFlightsCollectionRef();
        if (!flightsRef) {
            alert('Debes iniciar sesión para registrar vuelos.');
            return;
        }

        try {
            await addDoc(flightsRef, {
                origin,
                destination,
                distance,
                date,
                country,
                flightNumber,
                category,
                rating,
                durationHours
            });
            alert(`✈️ Vuelo ${flightNumber} registrado exitosamente`);
            form.reset();
            flightInfo.style.display = 'none';
            flightError.style.display = 'none';
            submitBtn.disabled = true;
            currentFlightData = null;
            const defaultRating = document.getElementById('star5');
            if (defaultRating) defaultRating.checked = true;
            loadFlights(); // Recargar datos
            closeModal();
        } catch (error) {
            console.error('Error registrando vuelo:', error);
            alert('Error registrando vuelo');
        }
    });

    loadSampleBtn.addEventListener('click', async () => {
        if (!ensureAuthenticated()) return;
        if (confirm('¿Cargar 30 vuelos de ejemplo? Esto puede tomar un momento.')) {
            await loadSampleData();
            loadFlights();
        }
    });
}

async function loadSampleData() {
    const flightsRef = getFlightsCollectionRef();
    if (!flightsRef) {
        alert('Debes iniciar sesión para cargar datos de ejemplo.');
        return;
    }

    // Primero, borrar todos los vuelos existentes
    try {
        const querySnapshot = await getDocs(flightsRef);
        for (const doc of querySnapshot.docs) {
            await deleteDoc(doc.ref);
        }
    } catch (error) {
        console.warn('No se pudieron borrar los datos antiguos:', error);
    }

    const sampleFlights = [
        // Vuelos desde Buenos Aires
        { origin: 'Buenos Aires', destination: 'Nueva York', distance: 8500, date: '2025-01-15', country: 'Estados Unidos', flightNumber: 'AA953' },
        { origin: 'Buenos Aires', destination: 'Madrid', distance: 10000, date: '2025-01-20', country: 'España', flightNumber: 'IB600' },
        { origin: 'Buenos Aires', destination: 'París', distance: 10500, date: '2025-02-01', country: 'Francia', flightNumber: 'AF300' },
        { origin: 'Buenos Aires', destination: 'Roma', distance: 11500, date: '2025-02-10', country: 'Italia', flightNumber: 'AZ500' },
        { origin: 'Buenos Aires', destination: 'Sídney', distance: 12000, date: '2025-02-25', country: 'Australia', flightNumber: 'QF900' },

        // Vuelos desde Nueva York
        { origin: 'Nueva York', destination: 'Londres', distance: 5570, date: '2025-02-20', country: 'Reino Unido', flightNumber: 'BA200' },
        { origin: 'Nueva York', destination: 'París', distance: 5840, date: '2025-03-15', country: 'Francia', flightNumber: 'AF300' },
        { origin: 'Nueva York', destination: 'Miami', distance: 1760, date: '2025-03-10', country: 'Estados Unidos', flightNumber: 'AA951' },
        { origin: 'Nueva York', destination: 'Los Ángeles', distance: 3950, date: '2025-05-12', country: 'Estados Unidos', flightNumber: 'AA950' },
        { origin: 'Nueva York', destination: 'Tokio', distance: 10850, date: '2025-01-10', country: 'Japón', flightNumber: 'JL800' },

        // Vuelos desde Londres
        { origin: 'Londres', destination: 'Manchester', distance: 260, date: '2025-03-20', country: 'Reino Unido', flightNumber: 'BA201' },
        { origin: 'Londres', destination: 'Berlín', distance: 930, date: '2025-01-30', country: 'Alemania', flightNumber: 'LH400' },
        { origin: 'Londres', destination: 'Madrid', distance: 1260, date: '2025-03-25', country: 'España', flightNumber: 'IB600' },
        { origin: 'Londres', destination: 'Roma', distance: 1430, date: '2025-04-01', country: 'Italia', flightNumber: 'AZ500' },
        { origin: 'Londres', destination: 'Ámsterdam', distance: 360, date: '2025-02-05', country: 'Países Bajos', flightNumber: 'KL700' },

        // Vuelos desde París
        { origin: 'París', destination: 'Lyon', distance: 390, date: '2025-04-10', country: 'Francia', flightNumber: 'AF301' },
        { origin: 'París', destination: 'Barcelona', distance: 830, date: '2025-04-30', country: 'España', flightNumber: 'IB601' },
        { origin: 'París', destination: 'Múnich', distance: 690, date: '2025-04-20', country: 'Alemania', flightNumber: 'LH401' },
        { origin: 'París', destination: 'Milán', distance: 640, date: '2025-05-05', country: 'Italia', flightNumber: 'AZ501' },

        // Vuelos desde Madrid
        { origin: 'Madrid', destination: 'Barcelona', distance: 500, date: '2025-02-15', country: 'España', flightNumber: 'IB600' },
        { origin: 'Madrid', destination: 'Roma', distance: 1360, date: '2025-03-05', country: 'Italia', flightNumber: 'AZ500' },
        { origin: 'Madrid', destination: 'París', distance: 1050, date: '2025-02-01', country: 'Francia', flightNumber: 'AF300' },

        // Vuelos desde Tokio
        { origin: 'Tokio', destination: 'Osaka', distance: 400, date: '2025-05-20', country: 'Japón', flightNumber: 'JL801' },
        { origin: 'Tokio', destination: 'Sídney', distance: 7820, date: '2025-03-30', country: 'Australia', flightNumber: 'QF900' },
        { origin: 'Tokio', destination: 'Los Ángeles', distance: 8800, date: '2025-03-12', country: 'Estados Unidos', flightNumber: 'AM192' },

        // Vuelos desde Miami
        { origin: 'Miami', destination: 'México', distance: 1300, date: '2025-02-28', country: 'México', flightNumber: 'AM191' },
        { origin: 'Miami', destination: 'Buenos Aires', distance: 6900, date: '2025-01-05', country: 'Argentina', flightNumber: 'AM190' },

        // Vuelos desde Berlín
        { origin: 'Berlín', destination: 'Fráncfort', distance: 430, date: '2025-05-15', country: 'Alemania', flightNumber: 'LH402' },
        { origin: 'Berlín', destination: 'Ámsterdam', distance: 580, date: '2025-04-15', country: 'Países Bajos', flightNumber: 'KL700' },

        // Vuelos desde Sídney
        { origin: 'Sídney', destination: 'Melbourne', distance: 710, date: '2025-05-25', country: 'Australia', flightNumber: 'QF901' },
        { origin: 'Sídney', destination: 'Tokio', distance: 7820, date: '2025-04-25', country: 'Japón', flightNumber: 'JL800' }
    ].map((flight, index) => ({
        ...flight,
        category: index % 2 === 0 ? 'Trabajo' : 'Personal',
        rating: (index % 5) + 1,
        durationHours: estimateDurationHours(flight.distance)
    }));

    let successCount = 0;
    let errorCount = 0;

    for (const flight of sampleFlights) {
        try {
            await addDoc(flightsRef, flight);
            successCount++;
        } catch (error) {
            console.error('Error agregando vuelo de ejemplo:', error);
            errorCount++;
        }
    }
    alert(`✈️ Se cargaron ${successCount} vuelos de ejemplo exitosamente!\n\nAhora puedes ver:\n• Marcadores de origen por aerolínea desde diferentes ciudades\n• Marcadores de destino con colores únicos\n• Líneas punteadas conectando cada ruta\n• Popups detallados con información por aerolínea y origen`);
}

async function loadFlights() {
    const flightsRef = getFlightsCollectionRef();
    if (!flightsRef) {
        allFlights = [];
        processFlights(allFlights);
        renderDatabaseTable(allFlights);
        return;
    }

    try {
        const querySnapshot = await getDocs(flightsRef);
        allFlights = [];
        for (const docSnapshot of querySnapshot.docs) {
            const data = docSnapshot.data();
            const migrationPayload = {};

            // Migra documentos antiguos sin categoria.
            if (!data.category) {
                data.category = 'Personal';
                migrationPayload.category = 'Personal';
            }

            if (!data.durationHours) {
                data.durationHours = estimateDurationHours(data.distance);
                migrationPayload.durationHours = data.durationHours;
            }

            if (!data.rating) {
                data.rating = 5;
                migrationPayload.rating = 5;
            }

            // Migra documentos sin país: asignar país basado en la ciudad destino
            if (!data.country && data.destination) {
                const normalizedDestination = normalizeDestinationCity(data.destination);
                data.country = normalizeCountryName('', normalizedDestination);
                migrationPayload.country = data.country;
                console.log(`%c🗺️ País asignado a ${data.flightNumber}: ${data.country}`, 'color: #ffc107; font-size: 11px;');
            }

            // Migra documentos sin origen: asignar Buenos Aires como origen por defecto
            if (!data.origin) {
                data.origin = 'Buenos Aires';
                migrationPayload.origin = 'Buenos Aires';
                console.log(`%c🛫 Origen asignado a ${data.flightNumber}: Buenos Aires`, 'color: #ffc107; font-size: 11px;');
            }

            // Si rules bloquean escritura, no interrumpimos la carga de datos.
            if (Object.keys(migrationPayload).length > 0) {
                try {
                    await updateDoc(docSnapshot.ref, migrationPayload);
                } catch (migrationError) {
                    console.warn('No se pudo aplicar migración automática del documento (se continúa):', migrationError?.code || migrationError);
                }
            }

            allFlights.push({ id: docSnapshot.id, ...data });
        }
        processFlights(allFlights);
        renderDatabaseTable(allFlights);
    } catch (error) {
        console.error('Error loading flights:', error);
        if (error?.code === 'permission-denied') {
            console.warn('Firestore denegó permisos. Revisa Authentication y Firestore Rules para users/{uid}/flights.');
        } else {
            console.warn('Asegúrate de que Firestore esté configurado correctamente');
        }
    }
}

function getFlightsByPeriod(flights, period) {
    if (period === 'total') return flights;
    
    const now = new Date();
    const targetDate = new Date();
    
    switch(period) {
        case '1month':
            targetDate.setMonth(now.getMonth() - 1);
            break;
        case '3months':
            targetDate.setMonth(now.getMonth() - 3);
            break;
        case '1year':
            targetDate.setFullYear(now.getFullYear() - 1);
            break;
        default:
            return flights;
    }
    
    return flights.filter(flight => {
        const flightDate = new Date(flight.date);
        return flightDate >= targetDate;
    });
}

function getFlightsByTripType(flights, tripType) {
    if (tripType === 'all') return flights;
    return flights.filter(flight => (flight.category || 'Personal') === tripType);
}

function processFlights(flights) {
    // Filtrar vuelos según período seleccionado
    const periodFilteredFlights = getFlightsByPeriod(flights, currentPeriod);
    const filteredFlights = getFlightsByTripType(periodFilteredFlights, currentTripType);
    lastFilteredFlights = filteredFlights;
    
    // Calcular kilómetros acumulados
    const totalKm = filteredFlights.reduce((sum, flight) => sum + (flight.distance || 0), 0);
    const totalDurationHours = filteredFlights.reduce((sum, flight) => {
        return sum + (flight.durationHours || estimateDurationHours(flight.distance));
    }, 0);
    
    // Calcular equivalentes de distancia
    const worldTours = (totalKm / EARTH_CIRCUMFERENCE_KM).toFixed(2);
    const moonDistances = (totalKm / MOON_DISTANCE_KM).toFixed(2);

    // Calcular métricas de distancia por vuelo
    const flightsWithDistance = filteredFlights.filter(flight => Number(flight.distance) > 0);
    const averageDistance = flightsWithDistance.length
        ? Math.round(totalKm / flightsWithDistance.length)
        : 0;
    const longestFlight = flightsWithDistance.reduce((max, current) => {
        return Number(current.distance) > Number(max.distance || 0) ? current : max;
    }, {});
    const shortestFlight = flightsWithDistance.reduce((min, current) => {
        if (!min.distance) return current;
        return Number(current.distance) < Number(min.distance) ? current : min;
    }, {});
    
    // Actualizar DOM
    document.getElementById('total-km').textContent = `${totalKm.toLocaleString()} km`;
    document.getElementById('total-time').textContent = formatDuration(totalDurationHours);
    document.getElementById('world-tours').textContent = worldTours;
    document.getElementById('moon-distance').textContent = moonDistances;
    document.getElementById('flight-count').textContent = flightsWithDistance.length;
    document.getElementById('avg-distance').textContent = `${averageDistance.toLocaleString()} km`;
    document.getElementById('longest-flight').textContent = longestFlight.distance
        ? `${longestFlight.flightNumber || 'N/A'} • ${longestFlight.destination || 'N/A'} • ${Number(longestFlight.distance).toLocaleString()} km`
        : '-';
    document.getElementById('shortest-flight').textContent = shortestFlight.distance
        ? `${shortestFlight.flightNumber || 'N/A'} • ${shortestFlight.destination || 'N/A'} • ${Number(shortestFlight.distance).toLocaleString()} km`
        : '-';

    // Destinos más frecuentes
    const destinationCount = {};
    filteredFlights.forEach(flight => {
        const dest = normalizeDestinationCity(flight.destination);
        const country = normalizeCountryName(flight.country, dest);
        if (!destinationCount[dest]) {
            destinationCount[dest] = { count: 0, country };
        }
        destinationCount[dest].count += 1;
    });
    const sortedDestinations = Object.entries(destinationCount)
        .sort((a, b) => b[1].count - a[1].count);
    const destList = document.getElementById('frequent-destinations');
    destList.innerHTML = '';
    sortedDestinations.slice(0, 5).forEach(([dest, data]) => {
        const li = document.createElement('li');
        li.textContent = `${getCountryFlag(data.country)} ${dest}: ${data.count}`;
        destList.appendChild(li);
    });

    // Países visitados
    const countries = new Set();
    const cities = new Set();
    const continents = new Set();
    filteredFlights.forEach(flight => {
        const normalizedDestination = normalizeDestinationCity(flight.destination);
        const normalizedCountry = normalizeCountryName(flight.country, normalizedDestination);

        if (normalizedCountry && normalizedCountry !== 'Desconocido') {
            countries.add(normalizedCountry);
            const continent = getContinentFromCountry(normalizedCountry);
            if (continent) continents.add(continent);
        }
        if (normalizedDestination && normalizedDestination !== 'Desconocido') {
            cities.add(normalizedDestination);
        }
    });
    const countryList = document.getElementById('visited-countries');
    countryList.innerHTML = '';
    Array.from(countries).sort().slice(0, 5).forEach(country => {
        const li = document.createElement('li');
        li.textContent = `${getCountryFlag(country)} ${country}`;
        countryList.appendChild(li);
    });

    // Cobertura global
    const coverageCountryCount = document.getElementById('coverage-country-count');
    const coverageCityCount = document.getElementById('coverage-city-count');
    const coverageContinentCount = document.getElementById('coverage-continent-count');
    const coverageContinentsDetail = document.getElementById('coverage-continents-detail');
    const sortedContinents = Array.from(continents).sort();
    const continentsText = sortedContinents.length
        ? sortedContinents.join(', ')
        : 'Sin continentes detectados';
    if (coverageCountryCount) coverageCountryCount.textContent = String(countries.size);
    if (coverageCityCount) coverageCityCount.textContent = String(cities.size);
    if (coverageContinentCount) coverageContinentCount.textContent = String(continents.size);
    if (coverageContinentsDetail) {
        coverageContinentsDetail.textContent = continentsText;
        coverageContinentsDetail.title = continentsText;
    }

    // Top aerolineas por rating promedio
    const airlineAgg = {};
    filteredFlights.forEach(flight => {
        const airlineCode = (flight.flightNumber || '').substring(0, 2).toUpperCase();
        if (!airlineCode) return;

        if (!airlineAgg[airlineCode]) {
            airlineAgg[airlineCode] = {
                totalRating: 0,
                count: 0
            };
        }

        airlineAgg[airlineCode].totalRating += Number(flight.rating || 5);
        airlineAgg[airlineCode].count += 1;
    });

    const rankedAirlines = Object.entries(airlineAgg)
        .map(([code, data]) => ({
            code,
            name: flightDatabase[code]?.airline || code,
            avgRating: data.totalRating / Math.max(1, data.count),
            flights: data.count
        }))
        .sort((a, b) => b.avgRating - a.avgRating || b.flights - a.flights);

    const airlineList = document.getElementById('top-airlines');
    airlineList.innerHTML = '';

    rankedAirlines.slice(0, 5).forEach(airline => {
        const li = document.createElement('li');
        li.innerHTML = `
            <span style="display:flex;align-items:center;gap:8px;justify-content:space-between;">
                <span style="display:flex;align-items:center;gap:7px;min-width:0;">
                    ${getAirlineLogoHTML(airline.code, airline.name, 16)}
                    <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:120px;">${airline.name}</span>
                </span>
                <span style="font-size:12px;color:#d1d5db;">${renderRatingStars(Math.round(airline.avgRating))} (${airline.avgRating.toFixed(1)})</span>
            </span>
        `;
        airlineList.appendChild(li);
    });

    // Mapa o red interactiva
    if (isNetworkMode) {
        renderNetworkGraph(filteredFlights);
    } else if (!isAnimationMode) {
        renderMap(filteredFlights);
    }
}

function getContinentFromCountry(country) {
    if (!country) return null;
    const normalizedCountry = String(country)
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();

    return countryToContinentMap[normalizedCountry] || null;
}

function renderMap(flights, highlightedFlight = null) {
    if (!map) return;

    // Limpiar marcadores y líneas previos
    Object.values(markers).forEach(marker => map.removeLayer(marker));
    markers = {};
    flightLines.forEach(line => map.removeLayer(line));
    flightLines = [];

    // Coordenadas de ciudades
    const cityCoords = {
        'Nueva York': [40.7128, -74.0060],
        'Miami': [25.7617, -80.1918],
        'Chicago': [41.8781, -87.6298],
        'Los Ángeles': [34.0522, -118.2437],
        'México': [19.4326, -99.1332],
        'Londres': [51.5074, -0.1278],
        'Manchester': [53.4808, -2.2426],
        'París': [48.8566, 2.3522],
        'Lyon': [45.7640, 4.8357],
        'Tokio': [35.6762, 139.6503],
        'Osaka': [34.6937, 135.5023],
        'Sídney': [-33.8688, 151.2093],
        'Melbourne': [-37.8136, 144.9631],
        'Roma': [41.9028, 12.4964],
        'Madrid': [40.4168, -3.7038],
        'Barcelona': [41.3851, 2.1734],
        'Berlín': [52.5200, 13.4050],
        'Múnich': [48.1351, 11.5820],
        'Fráncfort': [50.1109, 8.6821],
        'Ámsterdam': [52.3676, 4.9041],
        'Buenos Aires': [-34.6037, -58.3816]
    };

    // Filtrar vuelos que tengan flightNumber
    const validFlights = flights.filter(f => f.flightNumber);

    // Agrupar vuelos por origen y aerolínea
    const flightsByOriginAirline = {};
    validFlights.forEach(flight => {
        const airlineCode = flight.flightNumber.substring(0, 2).toUpperCase();
        const origin = flight.origin || 'Buenos Aires';
        const key = `${origin}_${airlineCode}`;
        if (!flightsByOriginAirline[key]) {
            flightsByOriginAirline[key] = {
                origin,
                airlineCode,
                flights: []
            };
        }
        flightsByOriginAirline[key].flights.push(flight);
    });

    // Crear marcadores para cada combinación origen-aerolínea
    Object.values(flightsByOriginAirline).forEach(({ origin, airlineCode, flights: airlineFlights }) => {
        const originCoords = cityCoords[origin];
        if (!originCoords) return;

        const airlineColor = airlineColors[airlineCode] || '#0A84FF';
        const airlineName = flightDatabase[airlineCode]?.airline || airlineCode;
        const totalFlights = airlineFlights.length;
        const totalDistance = airlineFlights.reduce((sum, f) => sum + f.distance, 0);
        const averageRating = airlineFlights.reduce((sum, f) => sum + (f.rating || 5), 0) / Math.max(1, airlineFlights.length);
        const topDestination = airlineFlights[0]?.destination;
        const topCountry = airlineFlights[0]?.country;

        // Crear popup para el marcador de origen
        const originPopupContent = `
            <div style="font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif; min-width: 250px;">
                <h3 style="margin: 0 0 10px 0; color: ${airlineColor}; display:flex; align-items:center; gap:8px;">${getAirlineLogoHTML(airlineCode, airlineName, 18)} <span>🏠 ${airlineName} - ${origin}</span></h3>
                <p style="margin: 5px 0; color: #d1d5db;"><strong>Vuelos Salientes:</strong> ${totalFlights}</p>
                <p style="margin: 5px 0; color: #d1d5db;"><strong>Distancia Total:</strong> ${totalDistance.toLocaleString()} km</p>
                <p style="margin: 5px 0; color: #d1d5db;"><strong>Ruta destacada:</strong> ${getCountryFlag(topCountry)} ${topDestination || 'N/A'}</p>
                <p style="margin: 5px 0; color: #d1d5db;"><strong>Rating promedio:</strong> ${renderRatingStars(Math.round(averageRating))}</p>
                <hr style="border: none; border-top: 1px solid #343434; margin: 10px 0;">
                <div style="max-height: 200px; overflow-y: auto; font-size: 12px;">
                    ${airlineFlights.map(f => `<div style="padding: 5px 0; border-bottom: 1px solid #2a2a2a; color: #ebebeb;">
                        <strong>${f.flightNumber}</strong> ${f.origin || 'Buenos Aires'} → ${getCountryFlag(f.country)} ${f.destination}<br>
                        <small style="color: #a3a3a3;">${f.date} - ${f.distance} km - ${formatDuration(f.durationHours)} - ${getCategoryBadge(f.category)} - ${renderRatingStars(f.rating)}</small>
                    </div>`).join('')}
                </div>
            </div>
        `;

        // Crear marcador de origen con color de aerolínea
        const originMarkerIcon = L.divIcon({
            className: 'origin-marker',
            html: `<div class="origin-marker-inner" style="background: linear-gradient(135deg, ${airlineColor}, ${airlineColor}dd); border-color: ${airlineColor};">${getAirlineMarkerBadgeHTML(airlineCode, airlineName)}</div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
            popupAnchor: [0, -10]
        });

        const originMarker = L.marker(originCoords, {icon: originMarkerIcon})
            .bindPopup(originPopupContent)
            .addTo(map);

        markers[`origin_${origin}_${airlineCode}`] = originMarker;
    });

    // Agrupar vuelos por ruta (origen-destino-aerolínea) para crear líneas
    const flightRoutes = {};
    validFlights.forEach(flight => {
        const airlineCode = flight.flightNumber.substring(0, 2).toUpperCase();
        const origin = flight.origin || 'Buenos Aires';
        const destination = flight.destination;
        const key = `${origin}_${destination}_${airlineCode}`;
        if (!flightRoutes[key]) {
            flightRoutes[key] = {
                airline: airlineCode,
                origin,
                destination: destination,
                flights: []
            };
        }
        flightRoutes[key].flights.push(flight);
    });

    // Crear líneas punteadas por ruta
    Object.values(flightRoutes).forEach((route) => {
        const originCoords = cityCoords[route.origin];
        const destCoords = cityCoords[route.destination];
        if (destCoords && originCoords) {
            const airlineColor = airlineColors[route.airline] || '#0A84FF';
            const routeIntensity = route.flights.length;
            const arcCoords = buildArcCoordinates(originCoords, destCoords, routeIntensity);
            const dynamicWeight = 1.2 + Math.min(6, Math.sqrt(routeIntensity) * 1.35);

            // Crear línea curva con grosor dinámico para mostrar frecuencia de la ruta.
            const flightLine = L.polyline(arcCoords, {
                color: airlineColor,
                weight: dynamicWeight,
                opacity: 0.8,
                dashArray: '8, 9',
                className: 'flight-route'
            }).addTo(map);

            flightLines.push(flightLine);
        }
    });

    // Agrupar vuelos por destino para crear marcadores
    const flightsByDestination = {};
    validFlights.forEach(flight => {
        if (!flightsByDestination[flight.destination]) {
            flightsByDestination[flight.destination] = {};
        }
        const airlineCode = flight.flightNumber.substring(0, 2).toUpperCase();
        if (!flightsByDestination[flight.destination][airlineCode]) {
            flightsByDestination[flight.destination][airlineCode] = [];
        }
        flightsByDestination[flight.destination][airlineCode].push(flight);
    });

    // Crear marcadores de destino
    Object.entries(flightsByDestination).forEach(([destination, airlines]) => {
        const destCoords = cityCoords[destination];
        if (destCoords) {
            // Obtener el primer airline para el color del marcador
            const airlineCodes = Object.keys(airlines);
            const primaryAirline = airlineCodes[0];
            const markerColor = airlineColors[primaryAirline] || '#0A84FF';
            
            // Crear HTML personalizado para el popup
            const totalFlights = Object.values(airlines).flat().length;
            const totalDistance = Object.values(airlines).flat().reduce((sum, f) => sum + f.distance, 0);
            const averageRouteRating = Object.values(airlines).flat().reduce((sum, f) => sum + (f.rating || 5), 0) / Math.max(1, totalFlights);

            const airlineDetails = Object.entries(airlines).map(([airlineCode, flightList]) => {
                const airlineName = flightDatabase[airlineCode]?.airline || airlineCode;
                const flightNumbers = flightList.map(f => f.flightNumber).join(', ');
                return `<div style="margin: 8px 0; padding: 8px; background: rgba(255,255,255,0.1); border-radius: 5px; border-left: 3px solid ${airlineColors[airlineCode] || '#0A84FF'};">
                    <strong style="color: ${airlineColors[airlineCode] || '#0A84FF'}; display:flex; align-items:center; gap:7px;">${getAirlineLogoHTML(airlineCode, airlineName, 16)} <span>${airlineName}</span></strong><br>
                    <small style="color: #d4d4d4;">Vuelos: ${flightNumbers}</small><br>
                    <small style="color: #d4d4d4;">Cantidad: ${flightList.length}</small><br>
                    <small style="color: #d4d4d4;">Categorias: ${Array.from(new Set(flightList.map(f => getCategoryBadge(f.category)))).join(', ')}</small>
                </div>`;
            }).join('');

            const popupContent = `
                <div style="font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif; min-width: 280px;">
                    <h3 style="margin: 0 0 10px 0; color: #0f5ba8;">✈️ ${getCountryFlag(Object.values(airlines)[0][0]?.country)} ${destination}</h3>
                    <p style="margin: 5px 0; color: #d1d5db;"><strong>Total de Vuelos:</strong> ${totalFlights}</p>
                    <p style="margin: 5px 0; color: #d1d5db;"><strong>Distancia Total:</strong> ${totalDistance.toLocaleString()} km</p>
                    <p style="margin: 5px 0; color: #d1d5db;"><strong>Rating promedio:</strong> ${renderRatingStars(Math.round(averageRouteRating))}</p>
                    <hr style="border: none; border-top: 1px solid #343434; margin: 10px 0;">
                    <div style="max-height: 250px; overflow-y: auto; font-size: 12px;">
                        ${airlineDetails}
                        <hr style="border: none; border-top: 1px solid #343434; margin: 10px 0;">
                        <div style="font-weight: 600; margin-bottom: 8px; color: #e7e7e7;">Todos los vuelos:</div>
                        ${Object.values(airlines).flat().map(f => `<div style="padding: 5px 0; border-bottom: 1px solid #2a2a2a; color: #d4d4d4;">
                            <strong style="color: ${airlineColors[f.flightNumber.substring(0, 2).toUpperCase()] || '#0A84FF'};">${f.flightNumber}</strong> desde ${f.origin || 'Buenos Aires'} - ${f.date} - ${f.distance} km - ${formatDuration(f.durationHours)} - ${getCategoryBadge(f.category)} - ${renderRatingStars(f.rating)}
                        </div>`).join('')}
                    </div>
                </div>
            `;

            // Crear marcador personalizado con color de aerolínea
            const markerIcon = L.divIcon({
                className: 'custom-marker',
                html: `<div class="marker-inner" style="background: linear-gradient(135deg, ${markerColor}, ${markerColor}dd);">${getAirlineMarkerBadgeHTML(primaryAirline, flightDatabase[primaryAirline]?.airline || primaryAirline)}</div>`,
                iconSize: [24, 24],
                iconAnchor: [12, 12],
                popupAnchor: [0, -12]
            });

            const marker = L.marker(destCoords, {icon: markerIcon})
                .bindPopup(popupContent)
                .addTo(map);

            markers[destination] = marker;
        }
    });

    if (highlightedFlight?.destination && highlightedFlight?.origin) {
        const origin = highlightedFlight.origin || 'Buenos Aires';
        const originCoords = cityCoords[origin];
        const destCoords = cityCoords[highlightedFlight.destination];
        
        if (destCoords && originCoords) {
            const airlineCode = (highlightedFlight.flightNumber || '').substring(0, 2).toUpperCase();
            const highlightColor = airlineColors[airlineCode] || '#ffffff';
            const highlightArc = buildArcCoordinates(originCoords, destCoords, 1);

            const highlightLine = L.polyline(highlightArc, {
                color: '#ffffff',
                weight: 5,
                opacity: 0.95,
                dashArray: '2, 8'
            }).addTo(map);
            flightLines.push(highlightLine);

            const pulseMarker = L.circleMarker(destCoords, {
                radius: 11,
                color: '#ffffff',
                weight: 2,
                fillColor: highlightColor,
                fillOpacity: 0.95
            }).addTo(map);
            flightLines.push(pulseMarker);
        }
    }
}

function getCountryFlag(country) {
    const countryFlags = {
        'Estados Unidos': '🇺🇸',
        'México': '🇲🇽',
        'Reino Unido': '🇬🇧',
        'Francia': '🇫🇷',
        'Alemania': '🇩🇪',
        'Italia': '🇮🇹',
        'España': '🇪🇸',
        'Países Bajos': '🇳🇱',
        'Japón': '🇯🇵',
        'Australia': '🇦🇺',
        'Chile': '🇨🇱',
        'Uruguay': '🇺🇾',
        'Argentina': '🇦🇷'
    };

    const normalizedCountry = normalizeCountryName(country);
    return countryFlags[normalizedCountry] || '🏳️';
}

function getCategoryBadge(category) {
    return category === 'Trabajo' ? '💼 Trabajo' : '🧳 Personal';
}

function buildArcCoordinates(origin, destination, intensity = 1) {
    const [lat1, lng1] = origin;
    const [lat2, lng2] = destination;

    const midLat = (lat1 + lat2) / 2;
    const midLng = (lng1 + lng2) / 2;
    const dLat = lat2 - lat1;
    const dLng = lng2 - lng1;
    const distance = Math.sqrt(dLat * dLat + dLng * dLng);
    const norm = Math.max(distance, 0.0001);

    const perpLat = -dLng / norm;
    const perpLng = dLat / norm;
    const curvature = Math.min(18, 2.8 + distance * 0.08 + Math.sqrt(intensity) * 0.5);
    const controlLat = midLat + perpLat * curvature;
    const controlLng = midLng + perpLng * curvature;

    const points = [];
    const steps = 48;

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const oneMinusT = 1 - t;
        const lat = oneMinusT * oneMinusT * lat1 + 2 * oneMinusT * t * controlLat + t * t * lat2;
        const lng = oneMinusT * oneMinusT * lng1 + 2 * oneMinusT * t * controlLng + t * t * lng2;
        points.push([lat, lng]);
    }

    return points;
}