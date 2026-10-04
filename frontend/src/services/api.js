/**
 * OffWeGo API client.
 *
 * A pre-configured Axios instance plus modular wrapper functions for the four
 * backend endpoints. Every wrapper resolves with the parsed response body and
 * rejects with an {@link ApiError}: network failures, timeouts and FastAPI
 * error payloads are normalised by a response interceptor, so callers only
 * need `catch (error) { error.status / error.message / error.details }`.
 *
 * @example
 * import { calculateRoutes, ApiError } from '../services/api'
 * try {
 *   const plan = await calculateRoutes({
 *     origin: 'London', destination: 'Paris', preferred_mode: 'Train',
 *   })
 * } catch (error) {
 *   if (error instanceof ApiError) console.error(error.status, error.message)
 * }
 */
import axios from 'axios'

/**
 * API base shared by every endpoint.
 *
 * Defaults to a same-origin path (`/api/v1`), so in dev every request goes
 * through the Vite proxy (`vite.config.js` → 127.0.0.1:8000). That sidesteps
 * CORS entirely and avoids `localhost` resolving to IPv6 `::1` (the backend
 * binds IPv4 only). Override with `VITE_API_BASE_URL` (full URL including
 * `/api/v1`) when the API is hosted on another origin without a proxy.
 */
export const BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1'

/**
 * Error thrown for every failed request.
 * `status` is the HTTP status code, or `null` when the server could not be
 * reached at all (backend down, CORS, offline). `details` carries the raw
 * FastAPI `detail` payload when available (e.g. 422 validation issues).
 */
export class ApiError extends Error {
  constructor(message, { status = null, code = null, details = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

const STATUS_MESSAGES = {
  400: 'Bad request.',
  401: 'Not authorised.',
  403: 'Forbidden.',
  404: 'Endpoint not found.',
  409: 'Conflicting request.',
  422: 'The submitted data failed validation.',
  429: 'Too many requests — please try again shortly.',
  500: 'Server error — please try again shortly.',
  502: 'Upstream service unavailable.',
  503: 'Service unavailable.',
  504: 'The server took too long to respond.',
}

/** Pull a readable message out of a FastAPI body (`detail` string or 422 array). */
function messageFrom(status, data) {
  const detail = data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length > 0) {
    const parts = detail.slice(0, 3).map((issue) => {
      const field = (issue.loc ?? []).slice(1).join('.') || 'request'
      return `${field}: ${issue.msg}`
    })
    const more = detail.length > 3 ? ` (+${detail.length - 3} more)` : ''
    return `${parts.join('; ')}${more}`
  }
  if (typeof data?.message === 'string') return data.message
  return STATUS_MESSAGES[status] ?? `Request failed with status ${status}.`
}

/** Normalise any thrown value into an `ApiError`. Exported for custom callers. */
export function toApiError(error) {
  if (error instanceof ApiError) return error
  if (axios.isAxiosError(error)) {
    if (error.response) {
      const { status, data } = error.response
      return new ApiError(messageFrom(status, data), {
        status,
        code: error.code ?? null,
        details: data?.detail ?? null,
      })
    }
    // No response at all: timeout, DNS, CORS or the backend is not running.
    const timedOut = error.code === 'ECONNABORTED'
    return new ApiError(
      timedOut
        ? 'The request timed out.'
        : 'Cannot reach the OffWeGo API — is the backend running on port 8000?',
      { status: null, code: error.code ?? 'NETWORK_ERROR' },
    )
  }
  return new ApiError(error?.message ?? 'Unexpected error', {
    status: null,
    code: 'UNKNOWN',
  })
}

/** Pre-configured Axios client for the OffWeGo backend. */
export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  headers: { Accept: 'application/json' },
})

// Normalise every failed request before it reaches a caller.
api.interceptors.response.use(
  (response) => response,
  (error) => Promise.reject(toApiError(error)),
)

/** Return the response body, or throw if the server sent nothing. */
function unwrap(response, endpoint) {
  if (response?.data === null || response?.data === undefined) {
    throw new ApiError(`Empty response from ${endpoint}.`, {
      status: response?.status ?? null,
      code: 'EMPTY_RESPONSE',
    })
  }
  return response.data
}

/* ------------------------------------------------------------------------ *
 * Endpoint wrappers
 *
 * Each function mirrors a backend route exactly:
 *   POST /routes/calculate       POST /trekker/analyze
 *   POST /fuel/plan              GET  /hotels/search
 *   GET  /routes/reverse-geocode GET  /routes/tourist-spots
 * All resolve with the parsed body and reject with `ApiError`.
 * ------------------------------------------------------------------------ */

/**
 * POST /routes/calculate — distance + base/weather-adjusted travel times for
 * every transport mode.
 *
 * @param {Object} payload
 * @param {string} payload.origin Place name or `lat,lon`.
 * @param {string} payload.destination Place name or `lat,lon`.
 * @param {'Driving'|'Bus'|'Train'|'Flight'|'Walking'} payload.preferred_mode
 * @returns {Promise<Object>} Route response (distance, modes, weather).
 */
export async function calculateRoutes(payload) {
  try {
    const response = await api.post('/routes/calculate', payload)
    return unwrap(response, 'POST /routes/calculate')
  } catch (error) {
    throw toApiError(error)
  }
}

/**
 * POST /trekker/analyze — trek feasibility score, duration and gear checklist.
 *
 * @param {Object} payload
 * @param {string} payload.home_location
 * @param {string} payload.base_camp
 * @param {string} payload.summit_location
 * @param {number} payload.elevation_meters Total elevation gain (metres).
 * @param {number} payload.planned_month Calendar month, 1-12.
 * @returns {Promise<Object>} Analysis with distance, feasibility, gear.
 */
export async function analyzeTrek(payload) {
  try {
    const response = await api.post('/trekker/analyze', payload)
    return unwrap(response, 'POST /trekker/analyze')
  } catch (error) {
    throw toApiError(error)
  }
}

/**
 * POST /trekker/plan — generate trekking spots (with fetched elevations) and
 * a full feasibility analysis from just a start and a destination.
 *
 * @param {Object} payload
 * @param {string} payload.start Trek starting point (place name or `lat,lon`).
 * @param {string} payload.destination Trek final destination (place name or `lat,lon`).
 * @param {number} [payload.planned_month] Calendar month 1-12; defaults to now.
 * @returns {Promise<Object>} Plan with spots, elevation gain, feasibility, gear.
 */
export async function planTrek(payload) {
  try {
    const response = await api.post('/trekker/plan', payload)
    return unwrap(response, 'POST /trekker/plan')
  } catch (error) {
    throw toApiError(error)
  }
}

/**
 * POST /fuel/plan — total fuel, cost, minimum refuel stops and markers.
 *
 * @param {Object} payload
 * @param {string} payload.origin
 * @param {string} payload.destination
 * @param {number} payload.distance_km
 * @param {number} payload.mileage_kpl Kilometres per litre.
 * @param {number} payload.tank_capacity_liters
 * @param {number} payload.fuel_price_per_liter
 * @returns {Promise<Object>} Fuel plan (cost, stops, refuel markers).
 */
export async function planFuel(payload) {
  try {
    const response = await api.post('/fuel/plan', payload)
    return unwrap(response, 'POST /fuel/plan')
  } catch (error) {
    throw toApiError(error)
  }
}

/**
 * GET /hotels/search — hotels within budget for a stay type.
 *
 * Sends camelCase options as the backend's snake_case query params
 * (`hotel_type`, `budget_max`).
 *
 * @param {Object} options
 * @param {string} options.location Place to search.
 * @param {'transit'|'basecamp_lodge'} options.hotelType Kind of stay.
 * @param {number} options.budgetMax Maximum nightly budget.
 * @returns {Promise<Array<Object>>} Matching hotels (possibly empty).
 */
export async function searchHotels({ location, hotelType, budgetMax } = {}) {
  try {
    const response = await api.get('/hotels/search', {
      params: {
        location,
        hotel_type: hotelType,
        budget_max: budgetMax,
      },
    })
    return unwrap(response, 'GET /hotels/search')
  } catch (error) {
    throw toApiError(error)
  }
}

/**
 * GET /routes/reverse-geocode — readable city/address for coordinates.
 *
 * @param {number} lat Latitude in decimal degrees.
 * @param {number} lng Longitude in decimal degrees.
 * @returns {Promise<{lat: number, lng: number, label: string, source: string}>}
 */
export async function reverseGeocode(lat, lng) {
  try {
    const response = await api.get('/routes/reverse-geocode', {
      params: { lat, lng },
    })
    return unwrap(response, 'GET /routes/reverse-geocode')
  } catch (error) {
    throw toApiError(error)
  }
}

/**
 * GET /routes/tourist-spots — attraction suggestions near a destination.
 *
 * The backend geocodes the place, queries Wikipedia's geosearch API for
 * notable landmarks within 10 km and falls back to deterministic offline
 * suggestions (`source: 'mock'`) when the API is unreachable.
 *
 * @param {Object} options
 * @param {string} options.place Destination place name or `lat,lon`.
 * @returns {Promise<{place: string, lat: number, lng: number, source: string, spots: Array<Object>}>}
 */
export async function getTouristSpots({ place } = {}) {
  try {
    const response = await api.get('/routes/tourist-spots', {
      params: { place },
    })
    return unwrap(response, 'GET /routes/tourist-spots')
  } catch (error) {
    throw toApiError(error)
  }
}

/* ------------------------------------------------------------------------ *
 * Health check — handy for "backend status" indicators.
 * ------------------------------------------------------------------------ */

/**
 * GET /health — backend liveness probe.
 *
 * @returns {Promise<{status: string}>}
 */
export async function getHealth() {
  try {
    const response = await api.get('/health')
    return unwrap(response, 'GET /health')
  } catch (error) {
    throw toApiError(error)
  }
}

export default {
  calculateRoutes,
  analyzeTrek,
  planTrek,
  planFuel,
  searchHotels,
  reverseGeocode,
  getHealth,
}
