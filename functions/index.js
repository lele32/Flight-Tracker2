const { onRequest } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

if (!admin.apps.length) {
    admin.initializeApp();
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

function pickFlightCandidate(items) {
    return (items || []).find((flight) => {
        const dep = flight?.departure;
        const arr = flight?.arrival;
        return dep?.airport && arr?.airport;
    });
}

async function getAirportCoords(iataCode, apiKey) {
    const iata = String(iataCode || '').trim().toUpperCase();
    if (!iata) return null;

    const url = `https://api.aviationstack.com/v1/airports?access_key=${encodeURIComponent(apiKey)}&iata_code=${encodeURIComponent(iata)}&limit=1`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const payload = await response.json();
    const airport = payload?.data?.[0];
    const lat = Number(airport?.latitude);
    const lon = Number(airport?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    return { lat, lon };
}

async function verifyFirebaseUser(req) {
    const authHeader = req.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
        return null;
    }

    const idToken = authHeader.replace('Bearer ', '').trim();
    if (!idToken) {
        return null;
    }

    try {
        return await admin.auth().verifyIdToken(idToken);
    } catch {
        return null;
    }
}

exports.lookupFlight = onRequest({ region: 'us-central1', cors: true, secrets: ['AVIATIONSTACK_API_KEY'] }, async (req, res) => {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'method-not-allowed' });
        return;
    }

    const user = await verifyFirebaseUser(req);
    if (!user) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
    }

    const flightNumberRaw = String(req.query.flightNumber || '').trim().toUpperCase();
    if (!/^[A-Z0-9-]{3,8}$/.test(flightNumberRaw)) {
        res.status(400).json({ error: 'invalid-flight-number' });
        return;
    }

    const apiKey = process.env.AVIATIONSTACK_API_KEY;
    if (!apiKey) {
        logger.error('AVIATIONSTACK_API_KEY missing in function environment');
        res.status(500).json({ error: 'missing-api-key' });
        return;
    }

    try {
        const flightsUrl = `https://api.aviationstack.com/v1/flights?access_key=${encodeURIComponent(apiKey)}&flight_iata=${encodeURIComponent(flightNumberRaw)}&limit=10`;
        const flightsResponse = await fetch(flightsUrl);
        if (!flightsResponse.ok) {
            res.status(502).json({ error: 'provider-unavailable' });
            return;
        }

        const flightsPayload = await flightsResponse.json();
        if (flightsPayload?.error) {
            logger.warn('Aviationstack error', flightsPayload.error);
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
        const origin = departure.airport || departure.iata || 'Desconocido';
        const destination = arrival.airport || arrival.iata || 'Desconocido';

        let distance = 1000;
        const depCoords = await getAirportCoords(departure.iata, apiKey);
        const arrCoords = await getAirportCoords(arrival.iata, apiKey);
        if (depCoords && arrCoords) {
            distance = haversineDistanceKm(depCoords.lat, depCoords.lon, arrCoords.lat, arrCoords.lon);
        }

        res.status(200).json({
            found: true,
            origin,
            destination,
            distance: Math.max(100, distance),
            country: arrival.country || 'Desconocido',
            departureIata: departure.iata || null,
            arrivalIata: arrival.iata || null
        });
    } catch (error) {
        logger.error('lookupFlight failed', error);
        res.status(500).json({ error: 'internal-error' });
    }
});
