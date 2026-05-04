const crypto = require('crypto');

const API_KEY = process.env.AVIATIONSTACK_API_KEY;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'flightracker-f5493';
const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const ALLOWED_ORIGINS = [
    'https://lele32.github.io',
    'https://flight-tracker-deploy.vercel.app',
    'http://localhost:5500',
    'http://127.0.0.1:5500'
];

// Rate limiting: almacén en memoria (se reinicia con cada cold start)
const requestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minuto
const MAX_REQUESTS_PER_WINDOW = 30; // 30 requests por minuto por identificador

// Analytics: contador simple
let requestStats = {
    total: 0,
    found: 0,
    notFound: 0,
    errors: 0,
    startTime: Date.now()
};

function log(level, message, data = {}) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        message,
        ...data
    };
    console.log(JSON.stringify(entry));
}

let firebaseCertsCache = {
    expiresAt: 0,
    certs: null
};

function base64UrlDecode(value) {
    const input = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    const padded = input.padEnd(input.length + ((4 - (input.length % 4)) % 4), '=');
    return Buffer.from(padded, 'base64');
}

function parseJwtPart(value) {
    try {
        return JSON.parse(base64UrlDecode(value).toString('utf8'));
    } catch {
        return null;
    }
}

async function getFirebaseCerts() {
    const now = Date.now();
    if (firebaseCertsCache.certs && firebaseCertsCache.expiresAt > now) {
        return firebaseCertsCache.certs;
    }

    const response = await fetch(FIREBASE_CERTS_URL);
    if (!response.ok) {
        throw new Error('firebase-certs-unavailable');
    }

    const cacheControl = response.headers.get('cache-control') || '';
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
    const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
    const certs = await response.json();

    firebaseCertsCache = {
        certs,
        expiresAt: now + Math.max(60, maxAgeSeconds - 60) * 1000
    };
    return certs;
}

async function verifyFirebaseIdToken(idToken) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const header = parseJwtPart(encodedHeader);
    const payload = parseJwtPart(encodedPayload);
    if (!header || !payload || header.alg !== 'RS256' || !header.kid) return null;

    const certs = await getFirebaseCerts();
    const cert = certs?.[header.kid];
    if (!cert) return null;

    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();

    const signature = base64UrlDecode(encodedSignature);
    const isSignatureValid = verifier.verify(cert, signature);
    if (!isSignatureValid) return null;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const expectedIssuer = `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`;
    if (payload.aud !== FIREBASE_PROJECT_ID) return null;
    if (payload.iss !== expectedIssuer) return null;
    if (!payload.sub || typeof payload.sub !== 'string') return null;
    if (payload.sub.length > 128) return null;
    if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds) return null;
    if (typeof payload.iat !== 'number' || payload.iat > nowSeconds + 300) return null;

    return {
        uid: payload.sub,
        email: payload.email || null
    };
}

async function verifyFirebaseUser(req) {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) return null;

    const idToken = authHeader.replace('Bearer ', '').trim();
    if (!idToken) return null;

    try {
        return await verifyFirebaseIdToken(idToken);
    } catch (error) {
        log('error', 'Firebase token verification failed', { error: error.message });
        return null;
    }
}

function checkRateLimit(identifier) {
    const now = Date.now();
    const clientData = requestCounts.get(identifier) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    
    // Resetear contador si la ventana expiró
    if (now >= clientData.resetTime) {
        clientData.count = 0;
        clientData.resetTime = now + RATE_LIMIT_WINDOW_MS;
    }
    
    clientData.count++;
    requestCounts.set(identifier, clientData);
    
    const isLimited = clientData.count > MAX_REQUESTS_PER_WINDOW;
    const remaining = Math.max(0, MAX_REQUESTS_PER_WINDOW - clientData.count);
    const resetIn = Math.ceil((clientData.resetTime - now) / 1000);
    
    return { isLimited, remaining, resetIn, count: clientData.count };
}

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
           req.headers['x-real-ip'] ||
           req.socket?.remoteAddress ||
           'unknown';
}

function haversineDistanceKm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return Math.round(R * c);
}

function isOriginAllowed(req) {
    const origin = req.headers.origin || '';
    return !origin || ALLOWED_ORIGINS.includes(origin);
}

function setRateLimitHeaders(res, rateLimitInfo = {}) {
    if (rateLimitInfo.remaining === undefined) return;
    res.setHeader('X-RateLimit-Limit', MAX_REQUESTS_PER_WINDOW);
    res.setHeader('X-RateLimit-Remaining', rateLimitInfo.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitInfo.resetIn);
}

function setCors(req, res, rateLimitInfo = {}) {
    const origin = req.headers.origin || '';
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    setRateLimitHeaders(res, rateLimitInfo);
}

function pickFlightCandidate(items) {
    return (items || []).find((flight) => {
        const dep = flight?.departure;
        const arr = flight?.arrival;
        return dep?.airport && arr?.airport;
    });
}

async function getAirportDetails(iataCode) {
    const iata = String(iataCode || '').trim().toUpperCase();
    if (!iata) return null;

    const url = `https://api.aviationstack.com/v1/airports?access_key=${encodeURIComponent(API_KEY)}&iata_code=${encodeURIComponent(iata)}&limit=1`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const payload = await response.json();
    const airport = payload?.data?.[0];
    const lat = Number(airport?.latitude);
    const lon = Number(airport?.longitude);
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);

    return {
        lat: hasCoords ? lat : null,
        lon: hasCoords ? lon : null,
        city: airport?.city || null,
        country: airport?.country_name || airport?.country_iso2 || null
    };
}

module.exports = async (req, res) => {
    const startTime = Date.now();
    const clientIP = getClientIP(req);
    const flightNumber = req.query.flightNumber || 'unknown';
    
    // Analytics: incrementar contador total
    requestStats.total++;
    
    // Logging: request recibido
    log('info', 'Request received', { 
        ip: clientIP, 
        method: req.method, 
        flightNumber,
        userAgent: req.headers['user-agent']
    });

    setCors(req, res);

    if (!isOriginAllowed(req)) {
        log('warn', 'Origin not allowed', { origin: req.headers.origin, ip: clientIP });
        requestStats.errors++;
        res.status(403).json({ error: 'origin-not-allowed' });
        return;
    }

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'GET') {
        log('warn', 'Method not allowed', { method: req.method, ip: clientIP });
        res.status(405).json({ error: 'method-not-allowed' });
        return;
    }

    const anonymousRateLimitInfo = checkRateLimit(`anonymous:${clientIP}`);
    setRateLimitHeaders(res, anonymousRateLimitInfo);
    if (anonymousRateLimitInfo.isLimited) {
        log('warn', 'Rate limit exceeded', { 
            ip: clientIP, 
            count: anonymousRateLimitInfo.count,
            flightNumber 
        });
        requestStats.errors++;
        res.status(429).json({ 
            error: 'rate-limit-exceeded',
            message: 'Demasiadas solicitudes. Intenta de nuevo más tarde.',
            retryAfter: anonymousRateLimitInfo.resetIn
        });
        return;
    }

    const user = await verifyFirebaseUser(req);
    if (!user) {
        log('warn', 'Unauthenticated request', { ip: clientIP, flightNumber });
        requestStats.errors++;
        res.status(401).json({ error: 'unauthenticated' });
        return;
    }

    const userRateLimitInfo = checkRateLimit(`user:${user.uid}:${clientIP}`);
    setRateLimitHeaders(res, userRateLimitInfo);
    if (userRateLimitInfo.isLimited) {
        log('warn', 'User rate limit exceeded', {
            uid: user.uid,
            ip: clientIP,
            count: userRateLimitInfo.count,
            flightNumber
        });
        requestStats.errors++;
        res.status(429).json({
            error: 'rate-limit-exceeded',
            message: 'Demasiadas solicitudes. Intenta de nuevo más tarde.',
            retryAfter: userRateLimitInfo.resetIn
        });
        return;
    }

    if (!API_KEY) {
        log('error', 'API key not configured', { ip: clientIP, uid: user.uid });
        requestStats.errors++;
        res.status(500).json({ error: 'api-key-not-configured' });
        return;
    }

    const flightNumberRaw = String(req.query.flightNumber || '').trim().toUpperCase();
    
    if (!flightNumberRaw || flightNumberRaw.length < 2 || flightNumberRaw.length > 10) {
        log('warn', 'Invalid flight number length', { flightNumber: flightNumberRaw, ip: clientIP, uid: user.uid });
        requestStats.errors++;
        res.status(400).json({ error: 'invalid-flight-number-length' });
        return;
    }
    
    if (!/^[A-Z0-9-]+$/.test(flightNumberRaw)) {
        log('warn', 'Invalid flight number format', { flightNumber: flightNumberRaw, ip: clientIP, uid: user.uid });
        requestStats.errors++;
        res.status(400).json({ error: 'invalid-flight-number-format' });
        return;
    }

    try {
        log('info', 'Looking up flight', { flightNumber: flightNumberRaw, ip: clientIP, uid: user.uid });
        
        const compact = flightNumberRaw.replace(/\s+/g, '').replace(/-/g, '');
        const match = compact.match(/^([A-Z]{2,3})(\d{1,4})$/);
        const queryUrls = [
            `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(API_KEY)}&flight_iata=${encodeURIComponent(flightNumberRaw)}&limit=10`
        ];
        if (match) {
            queryUrls.push(
                `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(API_KEY)}&airline_iata=${encodeURIComponent(match[1])}&flight_number=${encodeURIComponent(match[2])}&limit=10`
            );
        }

        let flightsPayload = null;
        let providerReachable = false;

        for (const flightsUrl of queryUrls) {
            const flightsResponse = await fetch(flightsUrl);
            if (!flightsResponse.ok) {
                log('warn', 'Provider response not ok', {
                    status: flightsResponse.status,
                    flightNumber: flightNumberRaw,
                    ip: clientIP
                });
                continue;
            }

            providerReachable = true;
            const payload = await flightsResponse.json();
            if (payload?.error) continue;

            if (Array.isArray(payload?.data) && payload.data.length > 0) {
                flightsPayload = payload;
                break;
            }
        }

        if (!providerReachable) {
            log('error', 'Provider unavailable', {
                flightNumber: flightNumberRaw,
                ip: clientIP
            });
            requestStats.notFound++;
            res.status(200).json({ found: false, providerUnavailable: true });
            return;
        }

        if (!flightsPayload) {
            log('info', 'Flight not found in provider', { flightNumber: flightNumberRaw, ip: clientIP });
            requestStats.notFound++;
            res.status(200).json({ found: false });
            return;
        }

        const item = pickFlightCandidate(flightsPayload?.data);
        if (!item) {
            log('info', 'No valid flight candidate found', { flightNumber: flightNumberRaw, ip: clientIP });
            requestStats.notFound++;
            res.status(200).json({ found: false });
            return;
        }

        const departure = item.departure || {};
        const arrival = item.arrival || {};
        const depDetails = await getAirportDetails(departure.iata);
        const arrDetails = await getAirportDetails(arrival.iata);

        const origin = depDetails?.city || departure.city || departure.airport || departure.iata || 'Desconocido';
        const destination = arrDetails?.city || arrival.city || arrival.airport || arrival.iata || 'Desconocido';

        let distance = 1000;
        if (depDetails?.lat != null && depDetails?.lon != null && arrDetails?.lat != null && arrDetails?.lon != null) {
            distance = haversineDistanceKm(depDetails.lat, depDetails.lon, arrDetails.lat, arrDetails.lon);
        }

        const country = arrDetails?.country || arrival.country || 'Desconocido';
        
        const responseTime = Date.now() - startTime;
        
        // Analytics: incrementar contador de éxitos
        requestStats.found++;
        
        log('info', 'Flight found successfully', {
            flightNumber: flightNumberRaw,
            origin,
            destination,
            country,
            distance,
            responseTime,
            ip: clientIP
        });

        res.status(200).json({
            found: true,
            origin,
            destination,
            distance: Math.max(100, distance),
            country,
            departureIata: departure.iata || null,
            arrivalIata: arrival.iata || null,
            originLat: depDetails?.lat ?? null,
            originLng: depDetails?.lon ?? null,
            destinationLat: arrDetails?.lat ?? null,
            destinationLng: arrDetails?.lon ?? null
        });
    } catch (error) {
        const responseTime = Date.now() - startTime;
        
        log('error', 'Internal error', {
            flightNumber: flightNumberRaw,
            error: error.message,
            responseTime,
            ip: clientIP
        });
        
        requestStats.errors++;
        res.status(500).json({ error: 'internal-error' });
    }
};
