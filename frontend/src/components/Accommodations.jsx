import { useEffect, useMemo, useState } from 'react'
import {
  Filter,
  Hotel,
  IndianRupee,
  MapPin,
  Search,
  Star,
} from 'lucide-react'
import { searchHotels } from '../services/api'

/** Stay types supported by the backend (`hotel_type` query param). */
const HOTEL_TYPES = [
  { value: 'transit', label: 'Transit', hint: 'Near the station' },
  { value: 'basecamp_lodge', label: 'Basecamp Lodge', hint: 'Near the trailhead' },
]

const DEFAULT_LOCATION = 'London'
const DEFAULT_BUDGET = '30000'

function formatMoney(amount, currency = 'INR') {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency,
  }).format(amount)
}

/**
 * One hotel recommendation: price, rating, distance to the station or
 * trailhead, and amenity chips.
 */
export function HotelCard({ hotel }) {
  const landmark = hotel.nearest_landmark === 'station' ? 'station' : 'trailhead'
  const typeLabel =
    hotel.hotel_type === 'transit' ? 'Transit' : 'Basecamp Lodge'

  return (
    <article
      aria-label={`${hotel.name} hotel card`}
      className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-800 p-4 transition hover:border-emerald-500/40"
    >
      <header className="flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold leading-tight text-white">
          {hotel.name}
        </h3>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
            hotel.hotel_type === 'transit'
              ? 'border-sky-500/50 bg-sky-500/15 text-sky-300'
              : 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
          }`}
        >
          {typeLabel}
        </span>
      </header>

      <div className="flex items-end justify-between gap-2">
        <span className="text-2xl font-bold text-emerald-400">
          {formatMoney(hotel.price_per_night, hotel.currency)}
          <span className="ml-1 text-xs font-normal text-slate-400">/night</span>
        </span>
        <span className="flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-sm font-semibold text-amber-300">
          <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" aria-hidden="true" />
          {hotel.rating.toFixed(1)}
        </span>
      </div>

      <p className="flex items-center gap-1.5 text-xs text-slate-400">
        <MapPin className="h-3.5 w-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
        {hotel.distance_to_landmark_km} km to the {landmark}
      </p>

      <ul className="flex flex-wrap gap-1.5" aria-label="Amenities">
        {hotel.amenities.map((amenity) => (
          <li
            key={amenity}
            className="rounded-full border border-slate-600 px-2 py-0.5 text-[11px] text-slate-300"
          >
            {amenity}
          </li>
        ))}
      </ul>
    </article>
  )
}

/**
 * Accommodation search: location + stay type + budget inputs (debounced
 * GET /api/v1/hotels/search) with a client-side price/rating filter bar
 * over the returned recommendation cards.
 */
function Accommodations() {
  const [location, setLocation] = useState(DEFAULT_LOCATION)
  const [hotelType, setHotelType] = useState('transit')
  const [budgetMax, setBudgetMax] = useState(DEFAULT_BUDGET)

  const [hotels, setHotels] = useState([])
  const [hasSearched, setHasSearched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // Client-side filters applied on top of the API results.
  const [minRating, setMinRating] = useState(0)
  const [maxPrice, setMaxPrice] = useState(Number(DEFAULT_BUDGET))

  // Debounced search — mirrors FuelCalculator's pattern so typing doesn't
  // fire a request per keystroke. `setBusy(true)` lives in the change
  // handlers (not the effect) to keep the linter/React happy.
  useEffect(() => {
    const trimmed = location.trim()
    if (!trimmed) return undefined

    const budget = Number(budgetMax)
    const parsedBudget =
      Number.isFinite(budget) && budgetMax !== ''
        ? Math.min(50000, Math.max(0, budget))
        : Number(DEFAULT_BUDGET)

    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const results = await searchHotels({
          location: trimmed,
          hotelType,
          budgetMax: parsedBudget,
        })
        if (cancelled) return
        setHotels(results)
        setHasSearched(true)
        setError(null)
      } catch (caught) {
        if (cancelled) return
        setError(caught?.message ?? 'Something went wrong while searching hotels.')
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [location, hotelType, budgetMax])

  function updateLocation(raw) {
    setLocation(raw)
    setBusy(true)
  }

  function updateType(value) {
    setHotelType(value)
    setBusy(true)
  }

  function updateBudget(raw) {
    setBudgetMax(raw)
    setBusy(true)
  }

  // Price cap of the current result set drives the price slider's range.
  const priceCap = useMemo(
    () => (hotels.length > 0 ? Math.max(...hotels.map((h) => h.price_per_night)) : 0),
    [hotels],
  )

  const visible = useMemo(
    () =>
      hotels.filter(
        (hotel) => hotel.rating >= minRating && hotel.price_per_night <= maxPrice,
      ),
    [hotels, minRating, maxPrice],
  )

  const filtersActive = minRating > 0 || maxPrice < priceCap

  function resetFilters() {
    setMinRating(0)
    setMaxPrice(priceCap)
  }

  const inputClass =
    'rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none'

  return (
    <section aria-label="Hotel recommendations" className="flex w-full max-w-5xl flex-col gap-6">
      {/* Search inputs */}
      <div className="flex flex-col gap-4 rounded-xl border border-slate-700 bg-slate-800 p-5">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-white">
          <Hotel className="h-5 w-5 text-emerald-400" aria-hidden="true" />
          Accommodations
          {busy && <span className="text-xs font-normal text-slate-500">searching…</span>}
        </h3>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm text-slate-300">
            <span className="flex items-center gap-1.5">
              <Search className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              Location
            </span>
            <input
              type="text"
              value={location}
              onChange={(event) => updateLocation(event.target.value)}
              placeholder="e.g. Zurich or Chamonix"
              className={inputClass}
            />
          </label>

          <div className="flex flex-col gap-1 text-sm text-slate-300">
            <span>Stay type</span>
            <div
              role="group"
              aria-label="Stay type"
              className="flex overflow-hidden rounded-lg border border-slate-600"
            >
              {HOTEL_TYPES.map((type) => (
                <button
                  key={type.value}
                  type="button"
                  aria-pressed={hotelType === type.value}
                  onClick={() => updateType(type.value)}
                  title={type.hint}
                  className={`flex-1 px-3 py-2 text-sm font-medium transition ${
                    hotelType === type.value
                      ? 'bg-emerald-500 text-slate-900'
                      : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {type.label}
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1 text-sm text-slate-300">
            <span className="flex items-center gap-1.5">
              <IndianRupee className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              Budget max (per night)
            </span>
            <input
              type="number"
              min="0"
              max="50000"
              step="500"
              value={budgetMax}
              onChange={(event) => updateBudget(event.target.value)}
              className={inputClass}
            />
          </label>
        </div>
      </div>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-3 text-sm text-red-300"
        >
          {error}
        </p>
      )}

      {/* Price / rating filter bar */}
      {hasSearched && !error && hotels.length > 0 && (
        <div className="flex flex-col gap-3 rounded-xl border border-slate-700 bg-slate-800 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-white">
              <Filter className="h-4 w-4 text-emerald-400" aria-hidden="true" />
              Filters
            </h4>
            <span className="text-xs text-slate-400" aria-live="polite">
              Showing {visible.length} of {hotels.length} hotels
            </span>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-slate-400">
              Minimum rating: {minRating === 0 ? 'any' : `${minRating.toFixed(1)}★`}
              <input
                type="range"
                min={0}
                max={5}
                step={0.5}
                value={minRating}
                onChange={(event) => setMinRating(Number(event.target.value))}
                aria-label="Minimum rating"
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-emerald-500"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-400">
              Max price: {formatMoney(maxPrice)}
              <input
                type="range"
                min={0}
                max={Math.ceil(priceCap)}
                step={1}
                value={Math.min(maxPrice, Math.ceil(priceCap))}
                onChange={(event) => setMaxPrice(Number(event.target.value))}
                aria-label="Maximum price per night"
                className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-emerald-500"
              />
            </label>
          </div>

          {filtersActive && (
            <button
              type="button"
              onClick={resetFilters}
              className="self-start text-xs text-emerald-400 underline-offset-2 hover:underline"
            >
              Reset filters
            </button>
          )}
        </div>
      )}

      {/* Results */}
      {hasSearched && !error && hotels.length > 0 && visible.length === 0 && (
        <p className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-400">
          No hotels match your filters — try lowering the minimum rating or
          raising the price cap.
        </p>
      )}

      {hasSearched && !error && hotels.length === 0 && (
        <p className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-3 text-sm text-slate-400">
          No hotels found for “{location}” within that budget.
        </p>
      )}

      {!hasSearched && !error && (
        <p className="text-sm text-slate-500">
          Search a location to browse transit stays and basecamp lodges.
        </p>
      )}

      {visible.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((hotel) => (
            <HotelCard key={hotel.id} hotel={hotel} />
          ))}
        </div>
      )}
    </section>
  )
}

export default Accommodations
