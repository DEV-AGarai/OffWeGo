import { useEffect, useState } from 'react'
import {
  Calculator,
  Droplet,
  Flag,
  Fuel,
  Gauge,
  IndianRupee,
  MapPin,
  Navigation,
  Route,
  Truck,
} from 'lucide-react'
import { planFuel } from '../services/api'

/**
 * Input ranges for each control. The number input is clamped to the same
 * range as its slider so both stay in sync and the API never sees
 * out-of-domain values (mileage/tank must be > 0 per the backend schema).
 */
const FIELDS = [
  {
    key: 'mileage',
    label: 'Car Mileage (km/L)',
    icon: Gauge,
    min: 1,
    max: 40,
    step: 0.5,
    unit: 'km/L',
    initial: '15',
  },
  {
    key: 'tank',
    label: 'Tank Capacity (L)',
    icon: Droplet,
    min: 5,
    max: 120,
    step: 1,
    unit: 'L',
    initial: '50',
  },
  {
    key: 'distance',
    label: 'Distance (km)',
    icon: Route,
    min: 0,
    max: 5000,
    step: 10,
    unit: 'km',
    initial: '1000',
  },
  {
    key: 'price',
    label: 'Fuel Price (per L)',
    icon: IndianRupee,
    min: 0,
    max: 200,
    step: 1,
    unit: '₹/L',
    initial: '100',
  },
]

/** Parse a raw input string, falling back to `fallback` then clamping. */
function clampNumber(raw, { min, max, fallback }) {
  const parsed = Number(raw)
  if (raw === '' || !Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * One slider + number-input pair. The slider drives the number field; the
 * number field accepts free typing and normalises on blur.
 */
function SliderField({ field, value, onChange }) {
  const { key, label, icon: Icon, min, max, step, unit } = field
  const numeric = clampNumber(value, { min, max, fallback: min })

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={`fuel-${key}`}
        className="flex items-center justify-between gap-2 text-sm text-slate-300"
      >
        <span className="flex items-center gap-1.5">
          <Icon className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          {label}
        </span>
        <span className="flex items-center gap-1">
          <input
            id={`fuel-${key}`}
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onBlur={(event) => onChange(String(clampNumber(event.target.value, {
              min, max, fallback: min,
            })))}
            className="w-24 rounded-md border border-slate-600 bg-slate-900 px-2 py-1 text-right text-white focus:border-emerald-500 focus:outline-none"
          />
          <span className="w-10 text-xs text-slate-500">{unit}</span>
        </span>
      </label>

      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={numeric}
        onChange={(event) => onChange(event.target.value)}
        aria-label={label}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-emerald-500"
      />
    </div>
  )
}

/**
 * Interactive route bar: start/end, clickable refuel-stop markers at the
 * exact backend `refuel_markers` positions, and a "you are here" scrubber
 * that derives the live tank level from the trip's refuel schedule
 * (tank starts full and is refilled to full at every marker).
 */
export function RouteProgressBar({ distanceKm, markers = [], mileageKpl, tankLiters }) {
  const [position, setPosition] = useState(0)

  // Reset the scrubber when the trip distance changes. React's documented
  // "adjust state during render" pattern — avoids a setState-in-effect.
  const [lastDistance, setLastDistance] = useState(distanceKm)
  if (lastDistance !== distanceKm) {
    setLastDistance(distanceKm)
    setPosition(0)
  }

  const safeDistance = Math.max(distanceKm, 0)
  const atEnd = safeDistance > 0 && position >= safeDistance
  const clampedPos = Math.min(position, safeDistance)
  const progressPct = safeDistance > 0 ? (clampedPos / safeDistance) * 100 : 0

  // Tank level: last marker at/before the position refilled the tank to full.
  let lastRefuel = 0
  for (const marker of markers) {
    if (marker <= clampedPos) lastRefuel = marker
  }
  const legKm = clampedPos - lastRefuel
  const fuelUsed = mileageKpl > 0 ? legKm / mileageKpl : 0
  const fuelPct = tankLiters > 0
    ? Math.max(0, Math.min(100, ((tankLiters - fuelUsed) / tankLiters) * 100))
    : 0

  const nextMarker = markers.find((marker) => marker > clampedPos)
  const toNextKm = nextMarker !== undefined ? nextMarker - clampedPos : null

  return (
    <div className="flex flex-col gap-3">
      {/* Route bar with marker pins */}
      <div className="relative pt-6">
        {/* Refuel marker pins */}
        {markers.map((marker, index) => {
          // Round to avoid float noise like "63.74999999999999%".
          const leftPct =
            safeDistance > 0
              ? Math.round((marker / safeDistance) * 10000) / 100
              : 0
          const passed = clampedPos >= marker
          return (
            <button
              key={marker}
              type="button"
              title={`Refuel stop ${index + 1} — ${marker.toFixed(1)} km`}
              aria-label={`Go to refuel stop ${index + 1} at ${marker.toFixed(1)} kilometres`}
              onClick={() => setPosition(marker)}
              className="absolute top-0 z-10 -translate-x-1/2 cursor-pointer"
              style={{ left: `${leftPct}%` }}
            >
              <Fuel
                className={`h-4 w-4 transition-colors ${
                  passed ? 'text-emerald-400' : 'text-amber-400'
                }`}
                aria-hidden="true"
              />
            </button>
          )
        })}

        {/* The track itself */}
        <div className="relative h-3 overflow-visible rounded-full bg-slate-700">
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-emerald-500 transition-[width] duration-100"
            style={{ width: `${progressPct}%` }}
          />
          {/* Scrubber handle */}
          <div
            className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-slate-900 bg-white shadow transition-[left] duration-100"
            style={{ left: `${progressPct}%` }}
            aria-hidden="true"
          />
        </div>

        {/* End labels */}
        <div className="mt-1 flex justify-between text-xs text-slate-500">
          <span className="flex items-center gap-1">
            <MapPin className="h-3 w-3" aria-hidden="true" /> Start · 0 km
          </span>
          <span className="flex items-center gap-1">
            {safeDistance.toFixed(0)} km
            <Flag className="h-3 w-3" aria-hidden="true" /> Finish
          </span>
        </div>
      </div>

      {/* Scrubber + live readouts */}
      <label className="flex flex-col gap-1 text-xs text-slate-400">
        Drag to preview the trip
        <input
          type="range"
          min={0}
          max={Math.max(safeDistance, 1)}
          step={Math.max(safeDistance / 200, 1)}
          value={clampedPos}
          onChange={(event) => setPosition(Number(event.target.value))}
          aria-label="Trip position preview"
          className="h-2 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-emerald-500"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-full border border-slate-600 px-2 py-1 text-slate-300">
          Position: {clampedPos.toFixed(0)} / {safeDistance.toFixed(0)} km
        </span>
        <span
          className={`flex items-center gap-1 rounded-full border px-2 py-1 ${
            fuelPct <= 15
              ? 'border-red-500/50 bg-red-500/10 text-red-300'
              : fuelPct <= 40
                ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                : 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          <Droplet className="h-3 w-3" aria-hidden="true" />
          Tank: {fuelPct.toFixed(0)}%
        </span>
        {atEnd ? (
          <span className="rounded-full border border-emerald-500/50 bg-emerald-500/10 px-2 py-1 text-emerald-300">
            Arrived
          </span>
        ) : nextMarker !== undefined ? (
          <span className="rounded-full border border-slate-600 px-2 py-1 text-slate-300">
            Next refuel in {toNextKm.toFixed(0)} km (at {nextMarker.toFixed(0)} km)
          </span>
        ) : (
          <span className="rounded-full border border-slate-600 px-2 py-1 text-slate-300">
            No further refuel needed
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * Visual summary card: total fuel cost, total refuels needed, and the
 * interactive route progress bar with exact refuel-stop markers.
 */
export function FuelSummaryCard({ plan, busy }) {
  const currency = new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
  })

  return (
    <section
      aria-label="Fuel plan summary"
      className="flex flex-col gap-5 rounded-xl border border-slate-700 bg-slate-800 p-5"
    >
      <h3 className="flex items-center gap-2 text-lg font-semibold text-white">
        <Calculator className="h-5 w-5 text-emerald-400" aria-hidden="true" />
        Trip Summary
        {busy && (
          <span className="text-xs font-normal text-slate-500">updating…</span>
        )}
      </h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {/* Total fuel cost */}
        <div className="flex flex-col gap-1 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <IndianRupee className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            Total Fuel Cost
          </span>
          <span className="text-2xl font-bold text-emerald-400">
            {currency.format(plan.total_estimated_cost)}
          </span>
          <span className="text-xs text-slate-500">
            {plan.total_fuel_required_liters} L of fuel needed
          </span>
        </div>

        {/* Total refuels */}
        <div className="flex flex-col gap-1 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <Fuel className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            Total Refuels Needed
          </span>
          <span className="text-2xl font-bold text-white">{plan.min_refuel_stops}</span>
          <span className="text-xs text-slate-500">
            {plan.min_refuel_stops === 1 ? 'stop' : 'stops'} on a full tank
            {plan.recommended_refuel_stops !== plan.min_refuel_stops && (
              <> · {plan.recommended_refuel_stops} keeping the 15% reserve</>
            )}
          </span>
        </div>

        {/* Tank spec */}
        <div className="flex flex-col gap-1 rounded-lg border border-slate-700 bg-slate-900/60 p-3">
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <Truck className="h-3.5 w-3.5 text-sky-400" aria-hidden="true" />
            Full-Tank Range
          </span>
          <span className="text-2xl font-bold text-white">
            {plan.full_tank_range_km}
            <span className="ml-1 text-sm font-normal text-slate-400">km</span>
          </span>
          <span className="text-xs text-slate-500">
            {plan.reserve_threshold_liters} L reserve · usable {plan.usable_range_km} km
          </span>
        </div>
      </div>

      {/* Interactive route progress bar */}
      <div className="flex flex-col gap-2 border-t border-slate-700 pt-4">
        <h4 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Navigation className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          Route · {plan.distance_km} km
          <span className="font-normal text-slate-500">
            ({plan.refuel_markers.length} refuel{' '}
            {plan.refuel_markers.length === 1 ? 'stop' : 'stops'} marked)
          </span>
        </h4>
        <RouteProgressBar
          distanceKm={plan.distance_km}
          markers={plan.refuel_markers}
          mileageKpl={plan.mileage_kpl}
          tankLiters={plan.tank_capacity_liters}
        />
      </div>
    </section>
  )
}

/**
 * Fuel calculator: mileage / tank / distance / price controls feeding a
 * debounced POST /api/v1/fuel/plan, summarised in a visual card with an
 * interactive refuel-marker route bar.
 */
function FuelCalculator() {
  const [values, setValues] = useState(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, f.initial])),
  )
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  function updateValue(key, raw) {
    setValues((prev) => ({ ...prev, [key]: raw }))
    setBusy(true) // event handler, not the effect — keeps lint/React happy
  }

  // Debounce so dragging sliders doesn't fire a request per pixel while the
  // backend stays the single source of truth for the maths.
  useEffect(() => {
    const parsed = Object.fromEntries(
      FIELDS.map((field) => [
        field.key,
        // Mileage must be > 0 (backend gt=0); everything else may hit min.
        clampNumber(values[field.key], {
          min: field.min,
          max: field.max,
          fallback: field.min,
        }),
      ]),
    )

    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const response = await planFuel({
          origin: 'Trip start',
          destination: 'Trip end',
          distance_km: parsed.distance,
          mileage_kpl: parsed.mileage,
          tank_capacity_liters: parsed.tank,
          fuel_price_per_liter: parsed.price,
        })
        if (cancelled) return
        setPlan(response)
        setError(null)
      } catch (caught) {
        if (cancelled) return
        setError(caught?.message ?? 'Something went wrong while planning fuel.')
      } finally {
        if (!cancelled) setBusy(false)
      }
    }, 300)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [values])

  return (
    <section aria-label="Fuel calculator" className="flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-4 rounded-xl border border-slate-700 bg-slate-800 p-5">
        <h3 className="flex items-center gap-2 text-lg font-semibold text-white">
          <Fuel className="h-5 w-5 text-emerald-400" aria-hidden="true" />
          Fuel Calculator
        </h3>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
          {FIELDS.map((field) => (
            <SliderField
              key={field.key}
              field={field}
              value={values[field.key]}
              onChange={(raw) => updateValue(field.key, raw)}
            />
          ))}
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

      {plan ? (
        <FuelSummaryCard plan={plan} busy={busy} />
      ) : (
        !error && (
          <p className="text-sm text-slate-500">
            Adjust the sliders to see fuel cost, refuel stops and the route
            breakdown.
          </p>
        )
      )}
    </section>
  )
}

export default FuelCalculator
