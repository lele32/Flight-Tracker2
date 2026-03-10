const API_KEY = process.env.AVIATIONSTACK_API_KEY;

if (!API_KEY) {
    throw new Error('AVIATIONSTACK_API_KEY no configurada');
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

function setCors(res) {
    const allowedOrigins = [
        'https://lele32.github.io',
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
    setCors(res);

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    if (req.method !== 'GET') {
        res.status(405).json({ error: 'method-not-allowed' });
        return;
    }

    const flightNumberRaw = String(req.query.flightNumber || '').trim().toUpperCase();
    
    if (!flightNumberRaw || flightNumberRaw.length < 2 || flightNumberRaw.length > 10) {
        res.status(400).json({ error: 'invalid-flight-number-length' });
        return;
    }
    
    if (!/^[A-Z0-9-]+$/.test(flightNumberRaw)) {
        res.status(400).json({ error: 'invalid-flight-number-format' });
        return;
    }

    try {
        const flightsUrl = `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(API_KEY)}&flight_iata=${encodeURIComponent(flightNumberRaw)}&limit=10`;
        const flightsResponse = await fetch(flightsUrl);
        if (!flightsResponse.ok) {
            res.status(502).json({ error: 'provider-unavailable' });
            return;
        }

        const flightsPayload = await flightsResponse.json();
        if (flightsPayload?.error) {
            res.status(200).json({ found: false });
            return;
        }

        const item = pickFlightCandidate(flightsPayload?.data);
        if (!item) {
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

        res.status(200).json({
            found: true,
            origin,
            destination,
            distance: Math.max(100, distance),
            country,
            departureIata: departure.iata || null,
            arrivalIata: arrival.iata || null
        });
    } catch {
        res.status(500).json({ error: 'internal-error' });
    }
};
