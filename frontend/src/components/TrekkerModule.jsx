import { useState } from 'react'
import {
  Activity,
  Backpack,
  Check,
  Flag,
  Footprints,
  Gauge,
  Layers,
  ListChecks,
  LoaderCircle,
  MapPin,
  Mountain,
  Shirt,
  Thermometer,
  TrendingUp,
  Wind,
} from 'lucide-react'
import { planTrek } from '../services/api'

/**
 * Risk bands for the feasibility dial, mapped onto the spec's three statuses.
 * The backend score is 0-100 (higher = more feasible); bands are inclusive of
 * their lower bound.
 *   80-100 -> Safe, 50-79 -> Moderate, 0-49 -> Extreme.
 */
const RISK_BANDS = [
  {
    min: 80,
    status: 'Safe',
    ring: 'stroke-emerald-400',
    text: 'text-emerald-400',
    chip: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300',
    note: 'Conditions are within conventional safety margins.',
  },
  {
    min: 50,
    status: 'Moderate',
    ring: 'stroke-amber-400',
    text: 'text-amber-400',
    chip: 'border-amber-500/50 bg-amber-500/15 text-amber-300',
    note: 'Extra preparation and acclimatisation recommended.',
  },
  {
    min: 0,
    status: 'Extreme',
    ring: 'stroke-red-400',
    text: 'text-red-400',
    chip: 'border-red-500/50 bg-red-500/15 text-red-300',
    note: 'Serious risk: reconsider, or go with experienced support.',
  },
]

function riskBand(score) {
  return RISK_BANDS.find((band) => score >= band.min) ?? RISK_BANDS[RISK_BANDS.length - 1]
}

/** Format minutes compactly (e.g. 95 -> "1h 35m"); accepts hours as fallback. */
function formatDuration(minutes) {
  const total = Math.max(0, Math.round(minutes))
  if (total < 60) return `${total}m`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** Category display metadata; unknown categories fall back to a backpack icon. */
const CATEGORY_META = {
  Outerwear: { Icon: Shirt, hint: 'Shells and insulation' },
  'Base Layers': { Icon: Layers, hint: 'Moisture-wicking next-to-skin' },
  Footwear: { Icon: Footprints, hint: 'Boots, socks and traction' },
  'Safety Gear': { Icon: Backpack, hint: 'Never leave these behind' },
}

function categoryMeta(name) {
  return CATEGORY_META[name] ?? { Icon: Backpack, hint: '' }
}

/**
 * Circular feasibility dial with risk status.
 * Renders as an ARIA meter so screen readers announce the score.
 */
export function FeasibilityGauge({ score, rating, notes = [], penalties }) {
  const clamped = Math.min(100, Math.max(0, score))
  const band = riskBand(clamped)
  const radius = 54
  const circumference = 2 * Math.PI * radius
  const filled = (clamped / 100) * circumference

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-slate-700 bg-slate-800 p-5">
      <h3 className="flex items-center gap-2 text-lg font-semibold text-white">
        <Gauge className="h-5 w-5 text-emerald-400" aria-hidden="true" />
        Feasibility Score
      </h3>

      <div
        role="meter"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Feasibility score ${clamped} out of 100`}
        className="relative"
      >
        <svg width="140" height="140" viewBox="0 0 140 140" className="-rotate-90">
          <circle
            cx="70"
            cy="70"
            r={radius}
            fill="none"
            strokeWidth="12"
            className="stroke-slate-700"
          />
          <circle
            cx="70"
            cy="70"
            r={radius}
            fill="none"
            strokeWidth="12"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference - filled}
            className={`${band.ring} transition-[stroke-dashoffset] duration-700`}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className={`text-4xl font-bold ${band.text}`}>{clamped}</span>
          <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${band.chip}`}>
            {band.status}
          </span>
        </div>
      </div>

      <p className="text-sm text-slate-400">
        Backend rating:{' '}
        <span className="font-medium text-slate-200">{rating}</span>
      </p>
      <p className="text-center text-xs text-slate-500">{band.note}</p>

      {penalties && (
        <ul className="flex flex-wrap justify-center gap-2 text-xs">
          <li className="rounded-full border border-slate-600 px-2 py-0.5 text-slate-300">
            Precipitation −{penalties.precipitation_penalty}
          </li>
          <li className="rounded-full border border-slate-600 px-2 py-0.5 text-slate-300">
            Cold −{penalties.cold_penalty}
          </li>
          <li className="rounded-full border border-slate-600 px-2 py-0.5 text-slate-300">
            Elevation −{penalties.elevation_penalty}
          </li>
        </ul>
      )}

      {notes.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-slate-700 pt-3 text-xs text-slate-400">
          {notes.map((note) => (
            <li key={note} className="flex gap-1.5">
              <Activity className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" aria-hidden="true" />
              {note}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Interactive, categorised clothing & trekking-gear checklist.
 * `checked` is a Set of "category::item" keys owned by the parent so state
 * survives re-renders and can be reset when a new analysis arrives.
 */
export function GearChecklist({ checklist, checked, onToggle, onClearCategory }) {
  const categories = Object.keys(checklist ?? {})
  if (categories.length === 0) return null

  const totalItems = categories.reduce((n, c) => n + checklist[c].length, 0)
  const packedCount = categories.reduce(
    (n, c) => n + checklist[c].filter((item) => checked.has(`${c}::${item}`)).length,
    0,
  )
  const packedPercent = totalItems === 0 ? 0 : Math.round((packedCount / totalItems) * 100)

  return (
    <section
      aria-label="Gear checklist"
      className="flex flex-col gap-4 rounded-xl border border-slate-700 bg-slate-800 p-5"
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-white">
          <ListChecks className="h-5 w-5 text-emerald-400" aria-hidden="true" />
          Gear Checklist
        </h3>
        <span className="text-sm text-slate-400">
          {packedCount}/{totalItems} packed
        </span>
      </header>

      <div
        role="progressbar"
        aria-valuenow={packedPercent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Packing progress"
        className="h-2 overflow-hidden rounded-full bg-slate-700"
      >
        <div
          className="h-full rounded-full bg-emerald-400 transition-[width] duration-500"
          style={{ width: `${packedPercent}%` }}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {categories.map((category) => {
          const items = checklist[category]
          const { Icon, hint } = categoryMeta(category)
          const done = items.filter((item) => checked.has(`${category}::${item}`)).length
          return (
            <div
              key={category}
              className="flex flex-col gap-2 rounded-lg border border-slate-700 bg-slate-900/60 p-3"
            >
              <header className="flex items-center justify-between gap-2">
                <h4 className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Icon className="h-4 w-4 text-emerald-400" aria-hidden="true" />
                  {category}
                  <span className="text-xs font-normal text-slate-500">
                    {done}/{items.length}
                  </span>
                </h4>
                <button
                  type="button"
                  onClick={() => onClearCategory(category)}
                  disabled={done === 0}
                  className="text-xs text-slate-500 underline-offset-2 hover:text-slate-300 disabled:no-underline disabled:opacity-50"
                >
                  Clear
                </button>
              </header>

              {hint && <p className="text-xs text-slate-500">{hint}</p>}

              <ul className="flex flex-col gap-1">
                {items.map((item) => {
                  const key = `${category}::${item}`
                  const isChecked = checked.has(key)
                  return (
                    <li key={key}>
                      <label
                        className={`flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-sm transition hover:bg-slate-800 ${
                          isChecked ? 'text-slate-500' : 'text-slate-200'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => onToggle(key)}
                          className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
                        />
                        {isChecked && (
                          <Check
                            className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400"
                            aria-hidden="true"
                          />
                        )}
                        <span className={isChecked ? 'line-through' : ''}>{item}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Generated trekking spots with fetched elevations.
 */
export function TrekSpotsCard({ spots, elevationSource }) {
  return (
    <section
      aria-label="Generated trekking spots"
      className="rounded-xl border border-slate-700 bg-slate-800 p-5"
    >
      <h3 className="flex items-center gap-2 text-lg font-semibold text-white">
        <Mountain className="h-5 w-5 text-emerald-400" aria-hidden="true" />
        Trekking Spots
        <span className="ml-auto text-xs font-normal text-slate-500">
          elevation:{' '}
          {elevationSource === 'open-meteo' ? 'Open-Meteo' : 'synthetic estimate'}
        </span>
      </h3>
      <ol className="mt-3 flex flex-col">
        {spots.map((spot, index) => (
          <li
            key={spot.name}
            className={`flex items-center justify-between gap-3 px-2 py-2 ${
              index < spots.length - 1 ? 'border-b border-slate-700/60' : ''
            }`}
          >
            <span className="flex items-center gap-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-500/15 text-xs font-semibold text-emerald-400">
                {index + 1}
              </span>
              <span className="text-sm font-medium text-white">{spot.name}</span>
            </span>
            <span className="flex items-center gap-4 text-sm">
              <span className="flex items-center gap-1 text-slate-300">
                <TrendingUp className="h-4 w-4 text-sky-400" aria-hidden="true" />
                {spot.elevation_meters.toLocaleString('en-IN')} m
              </span>
              <span className="w-24 text-right text-xs text-slate-500">
                {spot.distance_from_start_km.toFixed(1)} km
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * Trek analysis: a starting point and final destination are enough — the
 * backend generates the trekking spots, fetches their elevations, and returns
 * the feasibility dial plus a tailored gear checklist.
 *
 * Calls POST /api/v1/trekker/plan via the shared Axios client.
 */
function TrekkerModule() {
  const [start, setStart] = useState('')
  const [destination, setDestination] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  // Checklist state lives here so a new plan resets ticked items.
  const [checked, setChecked] = useState(() => new Set())

  function toggleItem(key) {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function clearCategory(category) {
    setChecked((prev) => {
      const next = new Set(prev)
      for (const key of next) {
        if (key.startsWith(`${category}::`)) next.delete(key)
      }
      return next
    })
  }

  async function handleSubmit(event) {
    event.preventDefault()
    const startLoc = start.trim()
    const destinationLoc = destination.trim()

    if (!startLoc || !destinationLoc) {
      setError('Please enter a starting point and a final destination.')
      return
    }

    setLoading(true)
    setError(null)
    try {
      const response = await planTrek({
        start: startLoc,
        destination: destinationLoc,
      })
      setResult(response)
      setChecked(new Set())
    } catch (caught) {
      setError(caught?.message ?? 'Something went wrong while planning the trek.')
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  const inputClass =
    'rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none disabled:opacity-50'

  return (
    <section aria-label="Trek analysis" className="flex w-full max-w-5xl flex-col gap-6">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-800 p-4"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm text-slate-300">
            <span className="flex items-center gap-1.5">
              <MapPin className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              Starting point
            </span>
            <input
              type="text"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              placeholder="e.g. Interlaken or 46.68,7.86"
              disabled={loading}
              className={inputClass}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm text-slate-300">
            <span className="flex items-center gap-1.5">
              <Flag className="h-4 w-4 text-amber-400" aria-hidden="true" />
              Final destination
            </span>
            <input
              type="text"
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder="e.g. Jungfrau or 46.55,7.98"
              disabled={loading}
              className={inputClass}
            />
          </label>

          <button
            type="submit"
            disabled={loading}
            className="flex items-center justify-center gap-2 self-end rounded-lg bg-emerald-500 px-5 py-2 font-semibold text-slate-900 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Gauge className="h-4 w-4" aria-hidden="true" />
            )}
            {loading ? 'Planning…' : 'Plan Trek'}
          </button>
        </div>
      </form>

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
            {result.start} → {result.destination} ·{' '}
            {result.distance_km.toFixed(1)} km ·{' '}
            {formatDuration(result.estimated_duration_minutes)} trek time ·{' '}
            +{result.total_elevation_gain_meters.toLocaleString('en-IN')} m ascent
          </p>

          <TrekSpotsCard
            spots={result.spots}
            elevationSource={result.elevation_source}
          />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-4">
              <FeasibilityGauge
                score={result.feasibility.score}
                rating={result.feasibility.rating}
                notes={result.feasibility.notes}
                penalties={{
                  precipitation_penalty: result.feasibility.precipitation_penalty,
                  cold_penalty: result.feasibility.cold_penalty,
                  elevation_penalty: result.feasibility.elevation_penalty,
                }}
              />

              <div className="flex flex-col gap-2 rounded-xl border border-slate-700 bg-slate-800 p-4 text-sm text-slate-300">
                <h3 className="flex items-center gap-2 font-semibold text-white">
                  <Thermometer className="h-4 w-4 text-sky-400" aria-hidden="true" />
                  Expected conditions
                </h3>
                <p>
                  {result.weather.month_name} · {result.weather.estimated_temperature_c}°C ·{' '}
                  {result.weather.estimated_precipitation_mm} mm precipitation
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  <Wind className="h-3.5 w-3.5" aria-hidden="true" />
                  {result.weather.hemisphere} hemisphere · planned month {result.planned_month}
                  {result.weather.is_extreme_cold && (
                    <span className="rounded-full border border-red-500/50 bg-red-500/15 px-2 py-0.5 text-red-300">
                      Extreme cold
                    </span>
                  )}
                </p>
              </div>
            </div>

            <GearChecklist
              checklist={result.gear_checklist}
              checked={checked}
              onToggle={toggleItem}
              onClearCategory={clearCategory}
            />
          </div>
        </div>
      )}

      {!result && !error && (
        <p className="text-sm text-slate-500">
          Enter a starting point and final destination to generate trekking
          spots with elevations, a feasibility dial and a tailored gear
          checklist.
        </p>
      )}
    </section>
  )
}

export default TrekkerModule
