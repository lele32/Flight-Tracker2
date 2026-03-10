const API_KEY = process.env.AVIATIONSTACK_API_KEY;

// Rate limiting: almacén en memoria (se reinicia con cada cold start)
const requestCounts = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minuto
const MAX_REQUESTS_PER_WINDOW = 30; // 30 requests por minuto por IP

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

function checkRateLimit(ip) {
    const now = Date.now();
    const clientData = requestCounts.get(ip) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW_MS };
    
    // Resetear contador si la ventana expiró
    if (now >= clientData.resetTime) {
        clientData.count = 0;
        clientData.resetTime = now + RATE_LIMIT_WINDOW_MS;
    }
    
    clientData.count++;
    requestCounts.set(ip, clientData);
    
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

function setCors(res, rateLimitInfo = {}) {
    const allowedOrigins = [
        'https://lele32.github.io',
        'https://flight-tracker-deploy.vercel.app',
        'http://localhost:5500',
        'http://127.0.0.1:5500'
    ];
    
    const origin = res.req?.headers?.origin || '';
    if (allowedOrigins.some(allowed => origin.startsWith(allowed))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }
    
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    
    // Rate limiting headers
    if (rateLimitInfo.remaining !== undefined) {
        res.setHeader('X-RateLimit-Limit', MAX_REQUESTS_PER_WINDOW);
        res.setHeader('X-RateLimit-Remaining', rateLimitInfo.remaining);
        res.setHeader('X-RateLimit-Reset', rateLimitInfo.resetIn);
    }
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

    // Rate limiting check
    const rateLimitInfo = checkRateLimit(clientIP);
    setCors(res, rateLimitInfo);

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'GET') {
        log('warn', 'Method not allowed', { method: req.method, ip: clientIP });
        res.status(405).json({ error: 'method-not-allowed' });
        return;
    }

    // Rate limiting enforcement
    if (rateLimitInfo.isLimited) {
        log('warn', 'Rate limit exceeded', { 
            ip: clientIP, 
            count: rateLimitInfo.count,
            flightNumber 
        });
        requestStats.errors++;
        res.status(429).json({ 
            error: 'rate-limit-exceeded',
            message: 'Demasiadas solicitudes. Intenta de nuevo más tarde.',
            retryAfter: rateLimitInfo.resetIn
        });
        return;
    }

    if (!API_KEY) {
        log('error', 'API key not configured', { ip: clientIP });
        requestStats.errors++;
        res.status(500).json({ error: 'api-key-not-configured' });
        return;
    }

    const flightNumberRaw = String(req.query.flightNumber || '').trim().toUpperCase();
    
    if (!flightNumberRaw || flightNumberRaw.length < 2 || flightNumberRaw.length > 10) {
        log('warn', 'Invalid flight number length', { flightNumber: flightNumberRaw, ip: clientIP });
        requestStats.errors++;
        res.status(400).json({ error: 'invalid-flight-number-length' });
        return;
    }
    
    if (!/^[A-Z0-9-]+$/.test(flightNumberRaw)) {
        log('warn', 'Invalid flight number format', { flightNumber: flightNumberRaw, ip: clientIP });
        requestStats.errors++;
        res.status(400).json({ error: 'invalid-flight-number-format' });
        return;
    }

    try {
        log('info', 'Looking up flight', { flightNumber: flightNumberRaw, ip: clientIP });
        
        const flightsUrl = `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(API_KEY)}&flight_iata=${encodeURIComponent(flightNumberRaw)}&limit=10`;
        const flightsResponse = await fetch(flightsUrl);
        if (!flightsResponse.ok) {
            log('error', 'Provider unavailable', { 
                status: flightsResponse.status, 
                flightNumber: flightNumberRaw,
                ip: clientIP 
            });
            requestStats.errors++;
            res.status(502).json({ error: 'provider-unavailable' });
            return;
        }

        const flightsPayload = await flightsResponse.json();
        if (flightsPayload?.error) {
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
            arrivalIata: arrival.iata || null
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
