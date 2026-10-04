import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Geolocation state for the browser's navigator.geolocation API.
 *
 * - `requestOnce()`   one-shot fix (returns the coords or null), for
 *                     populating inputs.
 * - `startWatching()` continuous `watchPosition` stream so the UI (e.g. the
 *                     map) tracks the user in real time until `stopWatching()`
 *                     or unmount.
 *
 * Never throws: permission denials and unsupported browsers are surfaced
 * through the human-readable `error` string.
 */
export function useGeolocation() {
  const [coords, setCoords] = useState(null) // { lat, lng, accuracy, timestamp }
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [watching, setWatching] = useState(false)
  const watchIdRef = useRef(null)

  const supported =
    typeof navigator !== 'undefined' && Boolean(navigator.geolocation)

  const describeError = useCallback((err) => {
    if (err?.code === 1) return 'Location permission denied. Please allow access and try again.'
    if (err?.code === 2) return 'Your location is unavailable right now.'
    if (err?.code === 3) return 'Getting your location timed out. Please try again.'
    return err?.message ?? 'Could not read your location.'
  }, [])

  const onPosition = useCallback((position) => {
    setCoords({
      lat: position.coords.latitude,
      lng: position.coords.longitude,
      accuracy: position.coords.accuracy,
      timestamp: position.timestamp,
    })
    setError(null)
    setLoading(false)
  }, [])

  const onFailure = useCallback(
    (err) => {
      setError(describeError(err))
      setLoading(false)
    },
    [describeError],
  )

  const requestOnce = useCallback(() => {
    if (!supported) {
      setError('Geolocation is not supported by this browser.')
      return Promise.resolve(null)
    }
    setLoading(true)
    setError(null)
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          onPosition(position)
          resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
          })
        },
        (err) => {
          onFailure(err)
          resolve(null)
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
      )
    })
  }, [supported, onPosition, onFailure])

  const startWatching = useCallback(() => {
    if (!supported || watchIdRef.current !== null) return
    setWatching(true)
    setError(null)
    watchIdRef.current = navigator.geolocation.watchPosition(
      onPosition,
      onFailure,
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 },
    )
  }, [supported, onPosition, onFailure])

  const stopWatching = useCallback(() => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current)
      watchIdRef.current = null
    }
    setWatching(false)
  }, [])

  // Always release the watch when the component unmounts.
  useEffect(() => stopWatching, [stopWatching])

  return {
    coords,
    error,
    loading,
    watching,
    supported,
    requestOnce,
    startWatching,
    stopWatching,
  }
}

export default useGeolocation
