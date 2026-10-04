import { useRef, useState } from 'react'
import {
  AlertTriangle,
  BusFront,
  CarFront,
  Cloud,
  CloudRain,
  ExternalLink,
  Footprints,
  Image as ImageIcon,
  Landmark,
  LoaderCircle,
  LocateFixed,
  MapPin,
  Plane,
  Search,
  Sun,
  Train,
} from 'lucide-react'
import { calculateRoutes, getTouristSpots, reverseGeocode } from '../services/api'
import { useGeolocation } from '../hooks/useGeolocation'
import LocationMap from './LocationMap.jsx'

/**
 * Display order requested by the UI spec: Flight, Train, Bus, Drive, Walk.
 * Backend mode keys are Driving/Walking; labels are shortened for the cards.
 */
const MODE_CARDS = [
  { mode: 'Flight', label: 'Flight', Icon: Plane },
  { mode: 'Train', label: 'Train', Icon: Train },
  { mode: 'Bus', label: 'Bus', Icon: BusFront },
  { mode: 'Driving', label: 'Drive', Icon: CarFront },
  { mode: 'Walking', label: 'Walk', Icon: Footprints },
]

/** The API requires preferred_mode; the spec's form only has two inputs. */
const DEFAULT_PREFERRED_MODE = 'Driving'

/** Format minutes as compact human-readable duration (e.g. 95 -> "1h 35m"). */
function formatDuration(totalMinutes) {
  const minutes = Math.max(0, Math.round(totalMinutes))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/**
 * Map the destination weather to an alert badge for the cards.
 * Always returns a badge: adverse conditions are flagged in red/amber/blue,
 * benign conditions render as a calm informational chip.
 */
function weatherAlert(weather) {
  if (!weather) return null
  const temp =
    typeof weather.temperature_c === 'number'
      ? ` · ${Math.round(weather.temperature_c)}°C`
      : ''
  if (weather.is_storm) {
    return {
      label: `Storm alert${temp}`,
      Icon: AlertTriangle,
      className: 'border-red-500/50 bg-red-500/15 text-red-300',
    }
  }
  // Snow alert badge removed by request — render no badge for snowy weather.
  if (weather.is_snow) {
    return null
  }
  if (weather.is_rain) {
    return {
      label: `Rain at destination${temp}`,
      Icon: CloudRain,
      className: 'border-amber-500/50 bg-amber-500/15 text-amber-300',
    }
  }
  const cloudy = (weather.condition ?? '').toLowerCase().includes('cloud')
  return {
    label: `${weather.condition ?? 'Clear'}${temp}`,
    Icon: cloudy ? Cloud : Sun,
    className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  }
}

/**
 * One comparative card: distance, base time, weather-adjusted time and the
 * destination weather alert badge.
 */
export function ModeCard({ estimate, weather }) {
  const card = MODE_CARDS.find((c) => c.mode === estimate?.mode)
  if (!card) return null
  const { label, Icon } = card
  const badge = weatherAlert(weather)

  const base = estimate.base_time_minutes
  const adjusted = estimate.weather_adjusted_time_minutes
  const delayed = adjusted > base
  const delayMinutes = Math.round(adjusted - base)
  const speedCut = Math.round(estimate.speed_adjustment_percent)

  return (
    <article
      aria-label={`${label} route card`}
      className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-800 p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-white">
          <Icon className="h-5 w-5 text-emerald-400" aria-hidden="true" />
          {label}
        </h3>
        {estimate.is_preferred && (
          <span className="rounded-full border border-emerald-500/50 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">
            Preferred
          </span>
        )}
      </header>

      <div className="text-2xl font-bold text-white">
        {estimate.distance_km.toFixed(1)}
        <span className="ml-1 text-sm font-normal text-slate-400">km</span>
      </div>

      <dl className="flex flex-col gap-1 text-sm">
        <div className="flex items-center justify-between">
          <dt className="text-slate-400">Base time</dt>
          <dd className="font-medium text-slate-200">{formatDuration(base)}</dd>
        </div>
        <div className="flex items-center justify-between">
          <dt className="text-slate-400">Weather-adjusted</dt>
          <dd className={delayed ? 'font-medium text-amber-300' : 'font-medium text-slate-200'}>
            {formatDuration(adjusted)}
          </dd>
        </div>
      </dl>

      {delayed ? (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
          +{delayMinutes}m vs base · speed {speedCut}%
        </p>
      ) : (
        <p className="rounded-lg border border-slate-600 bg-slate-700/50 px-2 py-1 text-xs text-slate-300">
          No weather delay
        </p>
      )}

      {badge && (
        <span
          role="status"
          className={`inline-flex items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-xs font-medium ${badge.className}`}
        >
          <badge.Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {badge.label}
        </span>
      )}
    </article>
  )
}

/**
 * Route search: Source/Destination inputs plus comparative mode cards.
 *
 * Calls POST /api/v1/routes/calculate via the shared Axios client and renders
 * one card per transport mode with distance, base time, weather-adjusted time
 * and the destination weather alert badge.
 */
function RouteSearch() {
  const [source, setSource] = useState('')
  const [destination, setDestination] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const geo = useGeolocation()
  const [locating, setLocating] = useState(false)
  const [geoAddress, setGeoAddress] = useState(null)

  // Tourist-spot suggestions, fetched alongside every search.
  const [spots, setSpots] = useState(null)
  const [spotsLoading, setSpotsLoading] = useState(false)
  const [spotsError, setSpotsError] = useState(null)
  const [spotsPlace, setSpotsPlace] = useState('')
  const spotsRequestRef = useRef(0)

  /**
   * GET /routes/tourist-spots — fire-and-forget loader for the suggestions
   * grid. Never throws; a stale-response guard keeps results from a previous
   * search from clobbering a newer one.
   */
  async function loadTouristSpots(place) {
    const requestId = spotsRequestRef.current + 1
    spotsRequestRef.current = requestId
    setSpotsPlace(place)
    setSpotsLoading(true)
    setSpotsError(null)
    setSpots(null)
    try {
      const data = await getTouristSpots({ place })
      if (spotsRequestRef.current === requestId) setSpots(data)
    } catch (caught) {
      if (spotsRequestRef.current === requestId) {
        setSpotsError(caught?.message ?? 'Could not load tourist spots right now.')
      }
    } finally {
      if (spotsRequestRef.current === requestId) setSpotsLoading(false)
    }
  }

  /**
   * "Use Current Location": grab a GPS fix, drop it into the Source field
   * (upgrade to a readable address via reverse-geocode when possible), then
   * keep watching so the map follows the user in real time.
   */
  async function handleUseCurrentLocation() {
    setLocating(true)
    try {
      const fix = await geo.requestOnce()
      if (!fix) return // geo.error explains why

      const coordinatePair = `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}`
      setSource(coordinatePair)
      geo.startWatching()

      try {
        const { label } = await reverseGeocode(fix.lat, fix.lng)
        if (label) {
          setGeoAddress(label)
          setSource(label)
        }
      } catch {
        // Reverse geocoding unavailable — keep the coordinates in the field.
      }
    } finally {
      setLocating(false)
    }
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const origin = source.trim()
    const dest = destination.trim()
    if (!origin || !dest) {
      setError('Please enter both a source and a destination.')
      return
    }

    setLoading(true)
    setError(null)
    // Tourist-spot suggestions load in parallel with the route calculation.
    void loadTouristSpots(dest)
    try {
      const response = await calculateRoutes({
        origin,
        destination: dest,
        preferred_mode: DEFAULT_PREFERRED_MODE,
      })
      setResult(response)
    } catch (caught) {
      setError(caught?.message ?? 'Something went wrong while planning the route.')
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  const cards = (result?.modes ?? [])
    .map((estimate) => ({
      order: MODE_CARDS.findIndex((c) => c.mode === estimate.mode),
      estimate,
    }))
    .sort((a, b) => a.order - b.order)
    .map(({ estimate }) => estimate)

  return (
    <section aria-label="Route search" className="flex w-full max-w-5xl flex-col gap-6">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-800 p-4 sm:flex-row sm:items-end"
      >
        <div className="flex flex-1 flex-col gap-1 text-sm text-slate-300">
          <MapPin className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          <label htmlFor="route-source">Source</label>
          <div className="flex items-center gap-2">
            <input
              id="route-source"
              type="text"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder="e.g. London or 51.5,-0.1"
              disabled={loading}
              className="min-w-0 flex-1 rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleUseCurrentLocation}
              disabled={locating || loading}
              aria-label="Use Current Location"
              title="Use Current Location"
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-emerald-500/50 bg-emerald-500/10 px-3 py-2 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {locating ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <LocateFixed className="h-4 w-4" aria-hidden="true" />
              )}
              <span className="hidden whitespace-nowrap sm:inline">
                Use Current Location
              </span>
            </button>
          </div>
        </div>

        <label className="flex flex-1 flex-col gap-1 text-sm text-slate-300">
          <MapPin className="h-4 w-4 text-sky-400" aria-hidden="true" />
          Destination
          <input
            type="text"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="e.g. Paris or 48.85,2.35"
            disabled={loading}
            className="rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none disabled:opacity-50"
          />
        </label>

        <button
          type="submit"
          disabled={loading}
          className="flex items-center justify-center gap-2 rounded-lg bg-emerald-500 px-5 py-2 font-semibold text-slate-900 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? (
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Search className="h-4 w-4" aria-hidden="true" />
          )}
          {loading ? 'Searching…' : 'Search'}
        </button>
      </form>

      {geo.error && (
        <p
          role="alert"
          className="rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-300"
        >
          {geo.error}
        </p>
      )}

      {geo.coords && (
        <LocationMap coords={geo.coords} label={geoAddress} />
      )}

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        >
          {error}
        </p>
      )}

      {result && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-400">
            {result.origin} → {result.destination} ·{' '}
            {result.straight_line_distance_km.toFixed(1)} km straight line
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {cards.map((estimate) => (
              <ModeCard
                key={estimate.mode}
                estimate={estimate}
                weather={result.weather}
              />
            ))}
          </div>
        </div>
      )}

      {(spotsLoading || spotsError || spots) && (
        <section aria-label="Tourist spots" className="flex flex-col gap-4">
          <header className="flex flex-wrap items-center gap-2">
            <Landmark className="h-5 w-5 text-emerald-400" aria-hidden="true" />
            <h3 className="text-lg font-semibold text-white">
              Tourist spots in {spotsPlace}
            </h3>
            {spots?.source === 'mock' && (
              <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-300">
                offline picks
              </span>
            )}
          </header>

          {spotsLoading && (
            <p className="flex items-center gap-2 text-sm text-slate-400">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              Finding places to visit near {spotsPlace}…
            </p>
          )}

          {spotsError && (
            <p
              role="alert"
              className="rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-300"
            >
              {spotsError}
            </p>
          )}

          {spots && spots.spots.length === 0 && (
            <p className="text-sm text-slate-500">
              No spots found for {spotsPlace} — try a more specific
              destination.
            </p>
          )}

          {spots && spots.spots.length > 0 && (
            <>
              <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {spots.spots.map((spot, index) => (
                  <li
                    key={`${spot.name}-${index}`}
                    className="flex flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-800"
                  >
                    {spot.image_url ? (
                      <img
                        src={spot.image_url}
                        alt=""
                        loading="lazy"
                        className="h-36 w-full object-cover"
                      />
                    ) : (
                      <div
                        aria-hidden="true"
                        className="flex h-36 w-full items-center justify-center bg-slate-900/70"
                      >
                        <ImageIcon className="h-8 w-8 text-slate-600" />
                      </div>
                    )}
                    <div className="flex flex-1 flex-col gap-2 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <h4 className="font-semibold leading-snug text-white">
                          {spot.name}
                        </h4>
                        <span className="shrink-0 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs text-sky-300">
                          {spot.distance_km.toFixed(1)} km
                        </span>
                      </div>
                      {spot.description && (
                        <p className="text-xs font-medium text-emerald-400">
                          {spot.description}
                        </p>
                      )}
                      {spot.summary && (
                        <p className="text-sm text-slate-300">{spot.summary}</p>
                      )}
                      {spot.info_url && (
                        <a
                          href={spot.info_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-auto inline-flex items-center gap-1.5 pt-1 text-sm font-medium text-emerald-400 transition hover:text-emerald-300"
                        >
                          Learn more
                          <ExternalLink
                            className="h-4 w-4"
                            aria-hidden="true"
                          />
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {spots.source === 'wikipedia' && (
                <p className="text-xs text-slate-500">
                  Suggestions via Wikipedia geosearch, sorted by straight-line
                  distance from the destination.
                </p>
              )}
            </>
          )}
        </section>
      )}

      {!result && !error && (
        <p className="text-sm text-slate-500">
          Enter a source and destination to compare Flight, Train, Bus, Drive
          and Walk — including weather-adjusted travel times.
        </p>
      )}
    </section>
  )
}

export default RouteSearch
