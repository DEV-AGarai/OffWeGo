import { useEffect, useState } from 'react'

/**
 * Interactive Leaflet map centred on the user's live coordinates.
 *
 * Leaflet touches `window` at import time, so the actual map view (and
 * leaflet/react-leaflet/CSS) is loaded via dynamic import inside an effect —
 * this module stays safe to import during SSR/Node and code-splits the map
 * out of the main bundle.
 */
export default function LocationMap({ coords, label }) {
  const [MapView, setMapView] = useState(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      import('./LocationMapView.jsx'),
      import('leaflet/dist/leaflet.css'),
    ])
      .then(([module]) => {
        if (!cancelled) setMapView(() => module.default)
      })
      .catch(() => {
        // Map chunk failed to load; the page keeps working without it.
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!coords) return null

  if (!MapView) {
    return (
      <div
        role="status"
        aria-label="Loading map"
        className="flex h-64 items-center justify-center rounded-xl border border-slate-700 bg-slate-800 text-sm text-slate-500 sm:h-80"
      >
        Loading map…
      </div>
    )
  }

  return (
    <div className="h-64 overflow-hidden rounded-xl border border-slate-700 sm:h-80">
      <MapView coords={coords} label={label} />
    </div>
  )
}
