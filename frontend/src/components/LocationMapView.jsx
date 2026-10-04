import { useEffect } from 'react'
import L from 'leaflet'
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet'

/**
 * Client-only map view. Only ever reached through a dynamic import from
 * LocationMap.jsx, so importing leaflet here is safe (no window on server).
 */

const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

// Custom div-icon: leaflet's default marker images 404 under bundlers.
const PIN_ICON = L.divIcon({
  className: '',
  html: '<span style="display:block;width:18px;height:18px;border-radius:50%;background:#10b981;border:3px solid #ffffff;box-shadow:0 0 0 2px rgba(16,185,129,0.45)"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
})

/** Pick a zoom level that keeps the pin visible given GPS accuracy. */
function zoomForAccuracy(accuracy) {
  if (!Number.isFinite(accuracy)) return 15
  if (accuracy > 10000) return 9
  if (accuracy > 2000) return 12
  if (accuracy > 300) return 14
  return 16
}

/** Re-centre the map whenever the live position updates. */
function FollowPosition({ lat, lng, zoom }) {
  const map = useMap()
  useEffect(() => {
    map.setView([lat, lng], zoom)
  }, [map, lat, lng, zoom])
  return null
}

export default function LocationMapView({ coords, label }) {
  const center = [coords.lat, coords.lng]
  const zoom = zoomForAccuracy(coords.accuracy)

  return (
    <MapContainer center={center} zoom={zoom} className="h-full w-full">
      <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} />
      <Marker position={center} icon={PIN_ICON}>
        <Popup>
          {label ? `${label}` : 'Your current location'}
          <br />
          {coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}
          {Number.isFinite(coords.accuracy) && (
            <>
              <br />
              ±{Math.round(coords.accuracy)} m accuracy
            </>
          )}
        </Popup>
      </Marker>
      <FollowPosition lat={coords.lat} lng={coords.lng} zoom={zoom} />
    </MapContainer>
  )
}
