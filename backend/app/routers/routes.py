"""Route calculation endpoints for OffWeGo.

Exposes ``POST /api/v1/routes/calculate``, which:

1. Geocodes the origin and destination (Nominatim, with a deterministic
   offline fallback when the geocoder is unreachable).
2. Fetches live weather for the destination from OpenWeatherMap, falling back
   to deterministic mock weather when ``OPENWEATHER_API_KEY`` is unset.
3. Returns the distance plus base and weather-adjusted travel times for every
   supported transport mode.
4. Suggests tourist spots near a destination via Wikipedia's geosearch API
   (deterministic SHA-256 fallback when the API is unreachable).

Weather Speed Adjustment Engine
-------------------------------
* Walking -> 25% slower during rain or snow.
* Driving -> 15% slower during heavy storms (thunderstorms / heavy rain).
* Bus, Train and Flight keep their base speed -- per the product requirements
  only walking and driving are weather-adjusted.
"""

from __future__ import annotations

import hashlib
import os
from typing import Literal

import httpx
from fastapi import APIRouter, Query
from fastapi.concurrency import run_in_threadpool
from geopy.distance import geodesic
from geopy.geocoders import Nominatim
from pydantic import BaseModel, Field

API_V1_PREFIX = "/api/v1"

# The five modes we estimate, in the order they are returned.
TravelMode = Literal["Driving", "Bus", "Train", "Flight", "Walking"]
MODE_ORDER: tuple[TravelMode, ...] = ("Driving", "Bus", "Train", "Flight", "Walking")

# Average door-to-door speed for each mode (km/h).
_BASE_SPEED_KMH: dict[str, float] = {
    "Driving": 60.0,
    "Bus": 30.0,
    "Train": 80.0,
    "Flight": 800.0,
    "Walking": 5.0,
}

# Ground travel is rarely a straight line while flights stay close to the
# great-circle route. Applied to the straight-line distance to obtain each
# mode's effective travel distance.
_DETOUR_FACTOR: dict[str, float] = {
    "Driving": 1.30,
    "Bus": 1.30,
    "Train": 1.15,
    "Flight": 1.05,
    "Walking": 1.20,
}

WeatherSource = Literal["openweathermap", "mock"]
GeocodeSource = Literal["coordinates", "nominatim", "mock"]

# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class RouteRequest(BaseModel):
    """Payload for ``POST /api/v1/routes/calculate``."""

    origin: str = Field(
        ...,
        min_length=1,
        description="Start of the journey: a place name or a 'lat,lon' pair.",
    )
    destination: str = Field(
        ...,
        min_length=1,
        description="End of the journey: a place name or a 'lat,lon' pair.",
    )
    preferred_mode: TravelMode = Field(
        ...,
        description="Transport mode the traveller prefers.",
    )


class WeatherReading(BaseModel):
    """Normalised weather snapshot for the destination."""

    source: WeatherSource
    condition: str
    description: str
    temperature_c: float | None = None
    is_rain: bool = False
    is_snow: bool = False
    is_storm: bool = False


class ModeEstimate(BaseModel):
    """Travel estimate for a single transport mode."""

    mode: TravelMode
    distance_km: float = Field(..., description="Mode-adjusted travel distance.")
    base_speed_kmh: float
    adjusted_speed_kmh: float
    base_time_minutes: float = Field(..., description="Time with no weather penalty.")
    weather_adjusted_time_minutes: float = Field(
        ..., description="Time after the Weather Speed Adjustment Engine."
    )
    weather_delay_minutes: float = Field(
        ..., description="weather_adjusted_time_minutes - base_time_minutes."
    )
    speed_adjustment_percent: float = Field(
        ..., description="Negative percentage applied to the base speed."
    )
    is_preferred: bool


class RouteResponse(BaseModel):
    """Full result of a route calculation."""

    origin: str
    destination: str
    preferred_mode: TravelMode
    straight_line_distance_km: float
    origin_geocode_source: GeocodeSource
    destination_geocode_source: GeocodeSource
    weather: WeatherReading
    modes: list[ModeEstimate]


# --------------------------------------------------------------------------- #
# Weather Speed Adjustment Engine
# --------------------------------------------------------------------------- #
class WeatherSpeedAdjustmentEngine:
    """Converts weather conditions into a per-mode speed multiplier.

    Kept as a pure function of ``(mode, weather)`` so it can be unit-tested
    without any network access.
    """

    WALKING_RAIN_SNOW_PENALTY = 0.25  # walking is 25% slower in rain/snow
    DRIVING_STORM_PENALTY = 0.15  # driving is 15% slower in heavy storms

    @classmethod
    def multiplier(cls, mode: str, weather: WeatherReading) -> float:
        """Return the multiplier to apply to ``mode``'s base speed."""
        if mode == "Walking" and (weather.is_rain or weather.is_snow):
            return 1.0 - cls.WALKING_RAIN_SNOW_PENALTY
        if mode == "Driving" and weather.is_storm:
            return 1.0 - cls.DRIVING_STORM_PENALTY
        return 1.0

    @classmethod
    def speeds(
        cls, mode: str, base_speed_kmh: float, weather: WeatherReading
    ) -> tuple[float, float]:
        """Return ``(base_speed, weather_adjusted_speed)`` for ``mode``."""
        adjusted = base_speed_kmh * cls.multiplier(mode, weather)
        return base_speed_kmh, round(adjusted, 2)


# --------------------------------------------------------------------------- #
# Weather
# --------------------------------------------------------------------------- #
def _classify(condition: str, description: str) -> tuple[bool, bool, bool]:
    """Derive ``(is_rain, is_snow, is_storm)`` from an OpenWeatherMap payload."""
    cond = condition.strip().lower()
    desc = description.strip().lower()

    is_rain = cond in {"rain", "drizzle"} or "rain" in desc or "drizzle" in desc
    is_snow = cond == "snow" or "snow" in desc
    heavy = any(marker in desc for marker in ("heavy", "torrential", "downpour"))
    is_storm = (
        cond in {"thunderstorm", "squall", "tornado"}
        or "thunder" in desc
        or "storm" in desc
        or (heavy and (is_rain or is_snow))
    )
    return is_rain, is_snow, is_storm


# Deterministic sample conditions used when no OpenWeatherMap key is supplied.
_MOCK_CONDITIONS: tuple[tuple[str, str, float], ...] = (
    ("Clear", "clear sky", 22.0),
    ("Clouds", "overcast clouds", 18.0),
    ("Rain", "moderate rain", 15.0),
    ("Drizzle", "light intensity drizzle", 14.0),
    ("Snow", "light snow", -2.0),
    ("Thunderstorm", "thunderstorm with heavy rain", 17.0),
    ("Mist", "mist", 16.0),
    ("Clouds", "scattered clouds", 20.0),
)


def _stable_index(seed: str, modulus: int) -> int:
    """Stable (process-independent) index derived from ``seed``."""
    digest = hashlib.sha256(seed.strip().lower().encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % modulus


def _mock_weather(seed: str) -> WeatherReading:
    """Deterministic mock weather so the endpoint works without an API key."""
    condition, description, temperature = _MOCK_CONDITIONS[
        _stable_index(seed, len(_MOCK_CONDITIONS))
    ]
    is_rain, is_snow, is_storm = _classify(condition, description)
    return WeatherReading(
        source="mock",
        condition=condition,
        description=description,
        temperature_c=temperature,
        is_rain=is_rain,
        is_snow=is_snow,
        is_storm=is_storm,
    )


async def fetch_destination_weather(destination: str, lat: float, lon: float) -> WeatherReading:
    """Fetch live weather for the destination, falling back to a mock reading.

    The mock fallback is used when ``OPENWEATHER_API_KEY`` is not configured
    and also when the OpenWeatherMap request itself fails, so route
    calculation never hard-fails because of weather.
    """
    api_key = os.getenv("OPENWEATHER_API_KEY", "").strip()
    if not api_key:
        return _mock_weather(destination)

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                "https://api.openweathermap.org/data/2.5/weather",
                params={"lat": lat, "lon": lon, "appid": api_key, "units": "metric"},
            )
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError):
        return _mock_weather(destination)

    entries = payload.get("weather") or []
    condition = entries[0].get("main", "Unknown") if entries else "Unknown"
    description = entries[0].get("description", "") if entries else ""
    temperature = (payload.get("main") or {}).get("temp")

    is_rain, is_snow, is_storm = _classify(condition, description)
    return WeatherReading(
        source="openweathermap",
        condition=condition,
        description=description,
        temperature_c=float(temperature) if temperature is not None else None,
        is_rain=is_rain,
        is_snow=is_snow,
        is_storm=is_storm,
    )

# --------------------------------------------------------------------------- #
# Geocoding
# --------------------------------------------------------------------------- #
def _parse_coord_pair(raw: str) -> tuple[float, float] | None:
    """Parse a ``'lat,lon'`` string, or return ``None`` if it is not one."""
    parts = [part.strip() for part in raw.split(",")]
    if len(parts) != 2:
        return None
    try:
        lat, lon = float(parts[0]), float(parts[1])
    except ValueError:
        return None
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return None
    return lat, lon


def _deterministic_coords(location: str) -> tuple[float, float]:
    """Deterministic placeholder coordinates so the endpoint works offline."""
    digest = hashlib.sha256(location.strip().lower().encode("utf-8")).hexdigest()
    lat = (int(digest[:8], 16) / 0xFFFFFFFF) * 180.0 - 90.0
    lon = (int(digest[8:16], 16) / 0xFFFFFFFF) * 360.0 - 180.0
    return round(lat, 6), round(lon, 6)


async def _geocode_nominatim(location: str) -> tuple[float, float] | None:
    """Resolve ``location`` via the Nominatim search API."""
    user_agent = os.getenv("NOMINATIM_USER_AGENT", "offwego-route-calculator")
    try:
        async with httpx.AsyncClient(timeout=10.0, headers={"User-Agent": user_agent}) as client:
            response = await client.get(
                "https://nominatim.openstreetmap.org/search",
                params={"q": location, "format": "jsonv2", "limit": 1},
            )
            response.raise_for_status()
            results = response.json()
    except (httpx.HTTPError, ValueError):
        return None

    if not results:
        return None
    try:
        return float(results[0]["lat"]), float(results[0]["lon"])
    except (KeyError, TypeError, ValueError, IndexError):
        return None


async def geocode(location: str) -> tuple[tuple[float, float], GeocodeSource]:
    """Resolve ``location`` to coordinates plus the source that produced them."""
    direct = _parse_coord_pair(location)
    if direct is not None:
        return direct, "coordinates"

    live = await _geocode_nominatim(location)
    if live is not None:
        return live, "nominatim"

    return _deterministic_coords(location), "mock"


# --------------------------------------------------------------------------- #
# Estimation
# --------------------------------------------------------------------------- #
def _estimate_modes(
    straight_line_km: float,
    weather: WeatherReading,
    preferred_mode: TravelMode,
) -> list[ModeEstimate]:
    """Build the per-mode estimates with base and weather-adjusted times."""
    estimates: list[ModeEstimate] = []
    for mode in MODE_ORDER:
        distance_km = round(straight_line_km * _DETOUR_FACTOR[mode], 2)
        base_speed, adjusted_speed = WeatherSpeedAdjustmentEngine.speeds(
            mode, _BASE_SPEED_KMH[mode], weather
        )

        base_time = round(distance_km / base_speed * 60.0, 1) if base_speed else 0.0
        adjusted_time = round(distance_km / adjusted_speed * 60.0, 1) if adjusted_speed else 0.0

        estimates.append(
            ModeEstimate(
                mode=mode,
                distance_km=distance_km,
                base_speed_kmh=base_speed,
                adjusted_speed_kmh=adjusted_speed,
                base_time_minutes=base_time,
                weather_adjusted_time_minutes=adjusted_time,
                weather_delay_minutes=round(adjusted_time - base_time, 1),
                speed_adjustment_percent=round(
                    (WeatherSpeedAdjustmentEngine.multiplier(mode, weather) - 1.0) * 100.0, 1
                ),
                is_preferred=mode == preferred_mode,
            )
        )
    return estimates


# --------------------------------------------------------------------------- #
# Router
# --------------------------------------------------------------------------- #
router = APIRouter(prefix=API_V1_PREFIX, tags=["routes"])


@router.post("/routes/calculate", response_model=RouteResponse)
async def calculate_route(request: RouteRequest) -> RouteResponse:
    """Calculate distance and travel times for every supported transport mode."""
    (origin_lat, origin_lon), origin_source = await geocode(request.origin)
    (dest_lat, dest_lon), dest_source = await geocode(request.destination)

    straight_line_km = round(geodesic((origin_lat, origin_lon), (dest_lat, dest_lon)).km, 2)

    weather = await fetch_destination_weather(request.destination, dest_lat, dest_lon)

    return RouteResponse(
        origin=request.origin,
        destination=request.destination,
        preferred_mode=request.preferred_mode,
        straight_line_distance_km=straight_line_km,
        origin_geocode_source=origin_source,
        destination_geocode_source=dest_source,
        weather=weather,
        modes=_estimate_modes(straight_line_km, weather, request.preferred_mode),
    )


# --------------------------------------------------------------------------- #
# Reverse geocoding (geopy + Nominatim)
# --------------------------------------------------------------------------- #
class ReverseGeocodeResponse(BaseModel):
    """Readable place name for a pair of coordinates."""

    lat: float
    lng: float
    label: str = Field(..., description="City/address text for the coordinates.")
    source: Literal["nominatim", "coordinates"]


def _reverse_geocode_blocking(lat: float, lng: float) -> str | None:
    """Resolve coordinates with geopy's Nominatim geocoder (blocking call)."""
    user_agent = os.getenv("NOMINATIM_USER_AGENT", "offwego-route-calculator")
    geolocator = Nominatim(user_agent=user_agent, timeout=10)
    location = geolocator.reverse((lat, lng), language="en")
    return location.address if location else None


async def reverse_geocode_label(
    lat: float, lng: float
) -> tuple[str, Literal["nominatim", "coordinates"]]:
    """Reverse-geocode coordinates, falling back to a formatted pair.

    geopy is synchronous, so it runs in the threadpool to keep the event loop
    free; any failure (offline, rate-limited, timed out) degrades to the
    coordinates themselves instead of failing the request.
    """
    try:
        address = await run_in_threadpool(_reverse_geocode_blocking, lat, lng)
    except Exception:  # noqa: BLE001 - degrade gracefully like the forward geocoder
        address = None
    if address:
        return address, "nominatim"
    return f"{lat:.5f}, {lng:.5f}", "coordinates"


@router.get("/routes/reverse-geocode", response_model=ReverseGeocodeResponse)
async def reverse_geocode(
    lat: float = Query(..., ge=-90, le=90, description="Latitude in decimal degrees."),
    lng: float = Query(..., ge=-180, le=180, description="Longitude in decimal degrees."),
) -> ReverseGeocodeResponse:
    """Convert lat/lng into a readable city/address name (geopy + Nominatim)."""
    label, source = await reverse_geocode_label(lat, lng)
    return ReverseGeocodeResponse(lat=lat, lng=lng, label=label, source=source)


# --------------------------------------------------------------------------- #
# Tourist spot suggestions (Wikipedia geosearch + deterministic fallback)
# --------------------------------------------------------------------------- #
class TouristSpot(BaseModel):
    """A single attraction near the destination."""

    name: str
    description: str | None = Field(None, description="Short subtitle, e.g. 'Museum in Paris'.")
    summary: str | None = Field(None, description="One-sentence overview of the spot.")
    image_url: str | None = None
    info_url: str | None = None
    distance_km: float = Field(..., description="Straight-line distance from the destination.")


class TouristSpotResponse(BaseModel):
    """Attraction suggestions for a destination."""

    place: str
    lat: float
    lng: float
    source: Literal["wikipedia", "mock"]
    spots: list[TouristSpot]


# Deterministic stand-ins used when the geocoder or Wikipedia is unavailable.
_SPOT_ARCHETYPES: tuple[str, ...] = (
    "Old Town of {place}",
    "National Museum of {place}",
    "{place} Botanical Gardens",
    "Central Market of {place}",
    "Riverside Promenade, {place}",
    "{place} Observation Deck",
    "Heritage Temple, {place}",
    "{place} Art Gallery",
    "City Park of {place}",
    "{place} History Walk",
    "Lakeside Gardens, {place}",
    "{place} Fort and Ramparts",
)

_SPOT_KINDS: tuple[str, ...] = (
    "Historic landmark",
    "Museum & culture",
    "Green space & views",
    "Local food & culture",
    "Riverside walk",
    "Panoramic viewpoint",
)

_MAX_SPOTS = 12


def _mock_spots(place: str) -> list[TouristSpot]:
    """Deterministic suggestion list seeded by the destination name (SHA-256)."""
    label = place.strip() or "your destination"
    start = _stable_index(label, len(_SPOT_ARCHETYPES))
    spots: list[TouristSpot] = []
    for offset in range(min(_MAX_SPOTS, len(_SPOT_ARCHETYPES))):
        archetype = _SPOT_ARCHETYPES[(start + offset) % len(_SPOT_ARCHETYPES)]
        distance_km = 0.5 + _stable_index(f"{label}:{offset}", 250) / 10.0
        spots.append(
            TouristSpot(
                name=archetype.format(place=label.title()),
                description=_SPOT_KINDS[offset % len(_SPOT_KINDS)],
                summary=f"A popular pick for travellers visiting {label}.",
                image_url=None,
                info_url=None,
                distance_km=round(distance_km, 1),
            )
        )
    spots.sort(key=lambda spot: spot.distance_km)
    return spots[:_MAX_SPOTS]


# Wikipedia's free geosearch API: notable articles within a radius of a point.
# Wikimedia's edge rejects user-agents without a project URL + contact in the
# UA string itself, so this one follows their official UA policy exactly.
_WIKIPEDIA_GEOSEARCH_URL = "https://en.wikipedia.org/w/api.php"
_WIKIPEDIA_USER_AGENT = (
    "OffWeGoBot/1.0 (https://github.com/offwego/offwego; contact@offwego.dev) Python-httpx"
)


# Titles that geosearch returns near a city centre but nobody visits on
# purpose — filtered out so suggestions stay tourist-relevant.
_SPOT_TITLE_NOISE: tuple[str, ...] = (
    "constituency",
    " division",
    " province",
    "geography of",
    "district",
    "history of",
    "economy of",
    "demographics",
    "transport in",
    "education in",
    "list of",
    "outline of",
    "timeline of",
    "portal:",
    "category:",
    "disambiguation",
    "metro station",
    "railway station",
    "bus station",
    "hospital",
    "battle of",
    "siege of",
    "capture of",
    "treaty of",
    "metro",
    "college",
    "school",
    "university",
    "department)",
    "commune of",
)


def _is_spot_noise(title: str) -> bool:
    """True when the article title is administrative rather than a sight."""
    lowered = title.casefold()
    return any(marker in lowered for marker in _SPOT_TITLE_NOISE)


async def _fetch_wikipedia_spots(lat: float, lng: float) -> list[TouristSpot] | None:
    """Nearby notable Wikipedia articles as tourist-spot candidates.

    Two-step lookup: ``list=geosearch`` provides every hit's coordinates and
    exact distance, then ``prop=...`` enriches the batch with descriptions,
    thumbnails, links and one-sentence extracts. Returns ``None`` when the
    search itself cannot be reached so callers can fall back to the
    deterministic suggestions instead of failing the request.
    """
    headers = {"User-Agent": _WIKIPEDIA_USER_AGENT}
    try:
        async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
            search = await client.get(
                _WIKIPEDIA_GEOSEARCH_URL,
                params={
                    "action": "query",
                    "format": "json",
                    "formatversion": "2",
                    "list": "geosearch",
                    "gscoord": f"{lat}|{lng}",
                    "gsradius": "10000",
                    "gslimit": "30",
                },
            )
            search.raise_for_status()
            hits = (search.json().get("query") or {}).get("geosearch") or []
            if not hits:
                return []

            page_ids = [str(hit["pageid"]) for hit in hits if hit.get("pageid")]
            pages: dict[int, dict] = {}
            try:
                details = await client.get(
                    _WIKIPEDIA_GEOSEARCH_URL,
                    params={
                        "action": "query",
                        "format": "json",
                        "formatversion": "2",
                        "pageids": "|".join(page_ids),
                        "prop": "pageimages|description|info|extracts",
                        "piprop": "thumbnail",
                        "pithumbsize": "480",
                        "inprop": "url",
                        "exintro": "1",
                        "explaintext": "1",
                        "exsentences": "1",
                        "exlimit": "max",
                    },
                )
                details.raise_for_status()
                pages = {
                    page.get("pageid"): page
                    for page in ((details.json().get("query") or {}).get("pages") or [])
                }
            except (httpx.HTTPError, ValueError):
                pages = {}  # names + distances still work without the extras
    except (httpx.HTTPError, ValueError, KeyError, TypeError):
        return None

    spots: list[TouristSpot] = []
    for hit in hits:
        title = (hit.get("title") or "").strip()
        if not title or _is_spot_noise(title):
            continue
        page = pages.get(hit.get("pageid")) or {}
        thumbnail = page.get("thumbnail") or {}
        spots.append(
            TouristSpot(
                name=title,
                description=page.get("description"),
                summary=(page.get("extract") or "").strip() or None,
                image_url=thumbnail.get("source"),
                info_url=page.get("fullurl"),
                distance_km=round(float(hit.get("dist") or 0.0) / 1000.0, 1),
            )
        )
    spots.sort(key=lambda spot: spot.distance_km)
    return spots[:_MAX_SPOTS]


@router.get("/routes/tourist-spots", response_model=TouristSpotResponse)
async def tourist_spots(
    place: str = Query(
        ...,
        min_length=1,
        description="Destination: a place name or a 'lat,lon' pair.",
    ),
) -> TouristSpotResponse:
    """Suggest tourist spots near a destination.

    Geocodes the destination, then asks Wikipedia's geosearch API for notable
    landmarks within 10 km. When the place cannot be geocoded, or Wikipedia is
    unreachable, deterministic SHA-256-seeded suggestions are returned instead
    so the section always renders.
    """
    (lat, lng), geocode_source = await geocode(place)
    spots: list[TouristSpot] | None = None
    if geocode_source != "mock":
        spots = await _fetch_wikipedia_spots(lat, lng)

    if spots:
        return TouristSpotResponse(
            place=place,
            lat=round(lat, 5),
            lng=round(lng, 5),
            source="wikipedia",
            spots=spots,
        )
    return TouristSpotResponse(
        place=place,
        lat=round(lat, 5),
        lng=round(lng, 5),
        source="mock",
        spots=_mock_spots(place),
    )
