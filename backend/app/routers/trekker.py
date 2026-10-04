"""Trek feasibility analysis endpoints for OffWeGo.

Exposes ``POST /api/v1/trekker/analyze``. Given a home location, a base camp,
a summit, the trek's total elevation gain and the planned calendar month it
returns:

1. The total ground distance (Home -> Base Camp -> Summit) plus an estimated
   hiking duration derived from Naismith's rule.
2. A **Feasibility Score** in the range 0-100 built from three weighted
   penalties: expected precipitation, extreme cold and elevation gain.
3. A dynamic gear & clothing checklist grouped into ``Outerwear``,
   ``Base Layers``, ``Footwear`` and ``Safety Gear``, tailored to the
   estimated altitude and weather for the planned month.

Weather model
-------------
The trek happens in a *future* month, so a live OpenWeatherMap reading would
not describe the actual trip conditions. This endpoint therefore derives a
deterministic month + altitude climatology: a sea-level temperature and
precipitation curve keyed by month (season-shifted for the southern
hemisphere), corrected for altitude with the standard 6.5 C/km lapse rate and
orographic precipitation growth. Geocoding is reused from
``app.routers.routes`` (Nominatim with a deterministic offline fallback).
"""

from __future__ import annotations

import hashlib
from datetime import datetime
from typing import Literal

import httpx
from fastapi import APIRouter
from geopy.distance import geodesic
from pydantic import BaseModel, Field

from app.routers.routes import API_V1_PREFIX, GeocodeSource, geocode

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #
# Naismith's rule: flat walking speed on mountain terrain with a pack, plus
# one extra hour of movement for every 600 m of ascent.
TREKKING_SPEED_KMH = 4.0
ASCENT_METRES_PER_HOUR = 600.0
REST_BUFFER_RATIO = 0.15  # 15% contingency for rests and route-finding

# Mean sea-level temperature (C) per month, northern-temperate reference.
_SEA_LEVEL_TEMP_C: dict[int, float] = {
    1: 2.0, 2: 3.0, 3: 7.0, 4: 12.0, 5: 16.0, 6: 20.0,
    7: 22.0, 8: 21.0, 9: 17.0, 10: 12.0, 11: 7.0, 12: 3.0,
}

# Typical monthly precipitation (mm) at sea level for the same reference.
_SEA_LEVEL_PRECIP_MM: dict[int, float] = {
    1: 75.0, 2: 60.0, 3: 65.0, 4: 55.0, 5: 60.0, 6: 55.0,
    7: 45.0, 8: 50.0, 9: 60.0, 10: 85.0, 11: 90.0, 12: 85.0,
}

LAPSE_RATE_C_PER_KM = 6.5       # standard environmental lapse rate
OROGRAPHIC_GAIN_PER_KM = 0.35   # precipitation grows ~35% per km of climb

# Feasibility penalties are capped so their maximum sums to exactly 100.
MAX_PRECIPITATION_PENALTY = 40.0
MAX_COLD_PENALTY = 40.0
MAX_ELEVATION_PENALTY = 20.0

EXTREME_COLD_C = -10.0  # at or below this is classified as extreme cold
FREEZING_C = 0.0        # below this, precipitation falls as snow

# Feasibility penalty scale references (see the penalty helpers below).
_PRECIP_REFERENCE_LOW = 40.0     # mm/month: negligible precipitation
_PRECIP_REFERENCE_HIGH = 200.0   # mm/month: full precipitation penalty
_ELEVATION_REFERENCE_LOW = 500.0   # m: negligible elevation penalty
_ELEVATION_KNEE = 2500.0          # m: altitude-sickness risk accelerates
_ELEVATION_REFERENCE_HIGH = 4000.0  # m: full elevation penalty
_ALTITUDE_SERIOUS = 2500.0        # m: acclimatisation advised

FEASIBILITY_RATING = Literal[
    "Favorable", "Manageable", "Challenging", "Strenuous", "Not Recommended"
]

# The four required checklist categories, in display order.
GEAR_CATEGORIES = ("Outerwear", "Base Layers", "Footwear", "Safety Gear")

_MONTH_NAMES = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class TrekkerRequest(BaseModel):
    """Payload for ``POST /api/v1/trekker/analyze``."""

    home_location: str = Field(
        ..., min_length=1,
        description="Trek start: a place name or a 'lat,lon' pair.",
    )
    base_camp: str = Field(
        ..., min_length=1,
        description="Base camp: a place name or a 'lat,lon' pair.",
    )
    summit_location: str = Field(
        ..., min_length=1,
        description="Summit: a place name or a 'lat,lon' pair.",
    )
    elevation_meters: float = Field(
        ..., ge=0, le=9000,
        description="Total elevation gain of the trek in metres.",
    )
    planned_month: int = Field(
        ..., ge=1, le=12,
        description="Calendar month of the trek (1 = January ... 12 = December).",
    )


class TrekLeg(BaseModel):
    """One segment of the Home -> Base Camp -> Summit route."""

    name: str
    from_location: str
    to_location: str
    distance_km: float


class WeatherContext(BaseModel):
    """Estimated conditions for the planned month at the trek altitude."""

    month: int
    month_name: str
    hemisphere: Literal["northern", "southern"]
    altitude_meters: float
    estimated_temperature_c: float
    estimated_precipitation_mm: float
    is_freezing: bool
    is_extreme_cold: bool
    frozen_precipitation: bool
    source: Literal["seasonal-climatology"]


class FeasibilityScore(BaseModel):
    """0-100 score with the penalty breakdown that produced it."""

    score: int = Field(..., ge=0, le=100)
    rating: FEASIBILITY_RATING
    precipitation_penalty: float
    cold_penalty: float
    elevation_penalty: float
    notes: list[str]


class GearChecklist(BaseModel):
    """Dynamic checklist grouped into the four required categories."""

    outerwear: list[str]
    base_layers: list[str]
    footwear: list[str]
    safety_gear: list[str]

    def as_categories(self) -> dict[str, list[str]]:
        """Return the items keyed by their display category name."""
        return {
            "Outerwear": self.outerwear,
            "Base Layers": self.base_layers,
            "Footwear": self.footwear,
            "Safety Gear": self.safety_gear,
        }


class TrekkerResponse(BaseModel):
    """Full result of a trek feasibility analysis."""

    home_location: str
    base_camp: str
    summit_location: str
    elevation_meters: float
    planned_month: int
    total_distance_km: float
    estimated_duration_hours: float
    estimated_duration_minutes: float
    legs: list[TrekLeg]
    weather: WeatherContext
    feasibility: FeasibilityScore
    gear_checklist: dict[str, list[str]]
    geocode_sources: dict[str, GeocodeSource]


# --------------------------------------------------------------------------- #
# Schemas for POST /trekker/plan (start + destination only)
# --------------------------------------------------------------------------- #
class TrekSpot(BaseModel):
    """One generated trekking waypoint with its fetched elevation."""

    name: str
    lat: float
    lng: float
    elevation_meters: float = Field(..., description="Elevation at this spot.")
    distance_from_start_km: float


class TrekPlanRequest(BaseModel):
    """Payload for ``POST /api/v1/trekker/plan`` — only two inputs."""

    start: str = Field(
        ...,
        min_length=1,
        description="Trek starting point: a place name or a 'lat,lon' pair.",
    )
    destination: str = Field(
        ...,
        min_length=1,
        description="Trek final destination: a place name or a 'lat,lon' pair.",
    )
    planned_month: int | None = Field(
        None, ge=1, le=12,
        description="Calendar month (1-12); defaults to the current month.",
    )


class TrekPlanResponse(BaseModel):
    """Generated trekking spots + full feasibility analysis for a two-point trek."""

    start: str
    destination: str
    planned_month: int
    distance_km: float
    total_elevation_gain_meters: float
    highest_point_meters: float
    estimated_duration_hours: float
    estimated_duration_minutes: float
    elevation_source: Literal["open-meteo", "synthetic"]
    spots: list[TrekSpot]
    geocode_sources: dict[str, GeocodeSource]
    weather: WeatherContext
    feasibility: FeasibilityScore
    gear_checklist: dict[str, list[str]]


# --------------------------------------------------------------------------- #
# Seasonal climatology (temperature + precipitation for the planned month)
# --------------------------------------------------------------------------- #
def _seasonal_month(planned_month: int, latitude: float) -> int:
    """Shift the month by six for southern-hemisphere seasonality."""
    if latitude >= 0:
        return planned_month
    return ((planned_month - 1 + 6) % 12) + 1


def estimate_weather(
    elevation_meters: float, planned_month: int, latitude: float
) -> WeatherContext:
    """Derive temperature/precipitation for the planned month at altitude.

    Deterministic: keyed only on month, hemisphere and altitude, so the same
    request always produces the same conditions (important for trip planning).
    """
    seasonal_month = _seasonal_month(planned_month, latitude)
    sea_level_temp = _SEA_LEVEL_TEMP_C[seasonal_month]
    sea_level_precip = _SEA_LEVEL_PRECIP_MM[seasonal_month]

    # Standard environmental lapse rate: ~6.5 C cooler per km of altitude.
    altitude_km = elevation_meters / 1000.0
    temp = sea_level_temp - LAPSE_RATE_C_PER_KM * altitude_km
    # Orographic effect: higher terrain receives more precipitation.
    precip = sea_level_precip * (1.0 + OROGRAPHIC_GAIN_PER_KM * altitude_km)

    is_freezing = temp <= FREEZING_C
    return WeatherContext(
        month=planned_month,
        month_name=_MONTH_NAMES[planned_month - 1],
        hemisphere="northern" if latitude >= 0 else "southern",
        altitude_meters=elevation_meters,
        estimated_temperature_c=round(temp, 1),
        estimated_precipitation_mm=round(precip, 1),
        is_freezing=is_freezing,
        is_extreme_cold=temp <= EXTREME_COLD_C,
        frozen_precipitation=is_freezing,
        source="seasonal-climatology",
    )


# --------------------------------------------------------------------------- #
# Feasibility Score (0-100)
# --------------------------------------------------------------------------- #
def _precipitation_penalty(precip_mm: float) -> float:
    """Scale expected precipitation to a 0-40 penalty.

    ~40 mm/month is treated as negligible; 200 mm/month or more is saturated.
    """
    if precip_mm <= _PRECIP_REFERENCE_LOW:
        raw = 0.0
    else:
        span = _PRECIP_REFERENCE_HIGH - _PRECIP_REFERENCE_LOW
        raw = min((precip_mm - _PRECIP_REFERENCE_LOW) / span, 1.0)
    return round(raw * MAX_PRECIPITATION_PENALTY, 1)


def _cold_penalty(temp_c: float) -> float:
    """Scale temperature to a 0-40 penalty.

    Freezing (0 C) begins the penalty; extreme cold (-10 C) and below is full.
    """
    if temp_c >= FREEZING_C:
        raw = 0.0
    elif temp_c <= EXTREME_COLD_C:
        raw = 1.0
    else:
        raw = (FREEZING_C - temp_c) / (FREEZING_C - EXTREME_COLD_C)
    return round(raw * MAX_COLD_PENALTY, 1)


def _elevation_penalty(elevation_meters: float) -> float:
    """Scale elevation gain to a 0-20 penalty.

    500 m or less is negligible; 4000 m or more saturates the penalty, with a
    steeper slope above 2500 m where altitude sickness risk climbs sharply.
    """
    if elevation_meters <= _ELEVATION_REFERENCE_LOW:
        raw = 0.0
    elif elevation_meters >= _ELEVATION_REFERENCE_HIGH:
        raw = 1.0
    elif elevation_meters <= _ELEVATION_KNEE:
        span = _ELEVATION_KNEE - _ELEVATION_REFERENCE_LOW
        raw = 0.5 * (elevation_meters - _ELEVATION_REFERENCE_LOW) / span
    else:
        span = _ELEVATION_REFERENCE_HIGH - _ELEVATION_KNEE
        raw = 0.5 + 0.5 * (elevation_meters - _ELEVATION_KNEE) / span
    return round(raw * MAX_ELEVATION_PENALTY, 1)


def _rating(score: int) -> FEASIBILITY_RATING:
    """Map a 0-100 score onto a human-readable rating."""
    if score >= 80:
        return "Favorable"
    if score >= 60:
        return "Manageable"
    if score >= 40:
        return "Challenging"
    if score >= 20:
        return "Strenuous"
    return "Not Recommended"


def compute_feasibility(weather: WeatherContext) -> FeasibilityScore:
    """Combine the three capped penalties into a 0-100 feasibility score."""
    precip_p = _precipitation_penalty(weather.estimated_precipitation_mm)
    cold_p = _cold_penalty(weather.estimated_temperature_c)
    elev_p = _elevation_penalty(weather.altitude_meters)

    score = int(round(max(0.0, 100.0 - precip_p - cold_p - elev_p)))

    notes: list[str] = []
    if weather.estimated_precipitation_mm > _PRECIP_REFERENCE_HIGH:
        notes.append(
            f"High precipitation (~{weather.estimated_precipitation_mm:.0f} mm) increases "
            "trail hazards and pack weight."
        )
    if weather.is_extreme_cold:
        notes.append(
            f"Extreme cold ({weather.estimated_temperature_c:.1f} C) risks frostbite; "
            "limit exposed time."
        )
    elif weather.is_freezing:
        notes.append(
            f"Sub-zero temperatures ({weather.estimated_temperature_c:.1f} C) with "
            "frozen precipitation expected."
        )
    if weather.altitude_meters >= _ALTITUDE_SERIOUS:
        notes.append(
            f"{weather.altitude_meters:.0f} m gain: allow extra acclimatisation time "
            "for altitude sickness."
        )
    if not notes:
        notes.append("Conditions are within conventional safety margins.")

    return FeasibilityScore(
        score=score,
        rating=_rating(score),
        precipitation_penalty=precip_p,
        cold_penalty=cold_p,
        elevation_penalty=elev_p,
        notes=notes,
    )


# --------------------------------------------------------------------------- #
# Dynamic gear & clothing checklist
# --------------------------------------------------------------------------- #
def build_gear_checklist(weather: WeatherContext) -> GearChecklist:
    """Generate a checklist tailored to the estimated altitude and weather.

    Items are appended conditionally so a warm, low, dry trek gets a short
    list while a high, freezing, wet one gets full alpine kit. Order within a
    category is stable so responses stay deterministic.
    """
    temp = weather.estimated_temperature_c
    freezing = weather.is_freezing
    extreme_cold = weather.is_extreme_cold
    wet = weather.estimated_precipitation_mm >= _PRECIP_REFERENCE_LOW
    high_altitude = weather.altitude_meters >= _ALTITUDE_SERIOUS

    # --- Outerwear ---------------------------------------------------------
    outerwear = ["Waterproof hardshell jacket"]
    if temp <= 10:
        outerwear.append("Insulated down or synthetic jacket")
    if extreme_cold:
        outerwear.append("Expedition-grade belay parka")
    elif freezing:
        outerwear.append("Heavy fleece or softshell mid-layer")
    if wet:
        outerwear.append("Rain over-trousers")
    if high_altitude:
        outerwear.append("Windproof hardshell with hood")

    # --- Base layers -------------------------------------------------------
    base_layers = ["Moisture-wicking base-layer top"]
    if temp <= 15:
        base_layers.append("Long-sleeve merino base layer")
    if freezing:
        base_layers.append("Thermal leggings")
    if extreme_cold:
        base_layers.append("Heavyweight expedition thermals (top + bottom)")
    if wet:
        base_layers.append("Spare base layer in a dry bag")

    # --- Footwear ----------------------------------------------------------
    footwear = ["Broken-in waterproof hiking boots"]
    if wet:
        footwear.append("Gaiters to keep water and mud out")
    if freezing:
        footwear.append("Insulated winter mountaineering boots")
    if weather.frozen_precipitation:
        footwear.append("Crampons or microspikes for icy traction")
    if wet or weather.frozen_precipitation:
        footwear.append("Camp shoes kept dry for evenings")

    # --- Safety gear -------------------------------------------------------
    safety_gear = ["First-aid kit", "Headlamp with spare batteries"]
    if extreme_cold:
        safety_gear.append("Emergency bivvy and chemical hand warmers")
    elif freezing:
        safety_gear.append("Insulated sleeping pad and emergency blanket")
    if wet:
        safety_gear.append("Dry bags for electronics and sleeping bag")
    if high_altitude:
        safety_gear.extend(
            [
                "Altitude-sickness medication (consult a physician)",
                "Portable pulse oximeter",
            ]
        )
    safety_gear.append("Map, compass and fully charged GPS")

    return GearChecklist(
        outerwear=outerwear,
        base_layers=base_layers,
        footwear=footwear,
        safety_gear=safety_gear,
    )


# --------------------------------------------------------------------------- #
# Router
# --------------------------------------------------------------------------- #
router = APIRouter(prefix=API_V1_PREFIX, tags=["trekker"])


@router.post("/trekker/analyze", response_model=TrekkerResponse)
async def analyze_trek(request: TrekkerRequest) -> TrekkerResponse:
    """Analyse a Home -> Base Camp -> Summit trek for feasibility and gear."""
    (home_lat, home_lon), home_source = await geocode(request.home_location)
    (base_lat, base_lon), base_source = await geocode(request.base_camp)
    (summit_lat, summit_lon), summit_source = await geocode(request.summit_location)

    home_to_base = round(geodesic((home_lat, home_lon), (base_lat, base_lon)).km, 2)
    base_to_summit = round(geodesic((base_lat, base_lon), (summit_lat, summit_lon)).km, 2)
    total_distance = round(home_to_base + base_to_summit, 2)

    legs = [
        TrekLeg(
            name="Home -> Base Camp",
            from_location=request.home_location,
            to_location=request.base_camp,
            distance_km=home_to_base,
        ),
        TrekLeg(
            name="Base Camp -> Summit",
            from_location=request.base_camp,
            to_location=request.summit_location,
            distance_km=base_to_summit,
        ),
    ]

    # Naismith's rule: flat time + one hour per 600 m of ascent, plus a 15%
    # contingency for rests, navigation and slow-going terrain.
    moving_hours = (
        total_distance / TREKKING_SPEED_KMH
        + request.elevation_meters / ASCENT_METRES_PER_HOUR
    )
    total_hours = round(moving_hours * (1.0 + REST_BUFFER_RATIO), 2)

    # Estimate conditions at the summit latitude for the planned month.
    weather = estimate_weather(
        request.elevation_meters, request.planned_month, summit_lat
    )
    feasibility = compute_feasibility(weather)
    checklist = build_gear_checklist(weather)

    return TrekkerResponse(
        home_location=request.home_location,
        base_camp=request.base_camp,
        summit_location=request.summit_location,
        elevation_meters=request.elevation_meters,
        planned_month=request.planned_month,
        total_distance_km=total_distance,
        estimated_duration_hours=total_hours,
        estimated_duration_minutes=round(total_hours * 60.0, 1),
        legs=legs,
        weather=weather,
        feasibility=feasibility,
        gear_checklist=checklist.as_categories(),
        geocode_sources={
            "home_location": home_source,
            "base_camp": base_source,
            "summit_location": summit_source,
        },
    )


# --------------------------------------------------------------------------- #
# Trekking-spot generation + elevation fetching (POST /trekker/plan)
# --------------------------------------------------------------------------- #
# Waypoints generated along the route: fraction of the way + display name.
_TREK_SPOTS: tuple[tuple[float, str], ...] = (
    (0.00, "Trailhead"),
    (0.25, "Forest Camp"),
    (0.50, "Base Camp"),
    (0.75, "High Ridge"),
    (1.00, "Summit"),
)


async def _fetch_open_meteo_elevations(
    points: list[tuple[float, float]],
) -> list[float] | None:
    """Batch-fetch elevations from Open-Meteo (free, no API key).

    Returns ``None`` on any failure so callers can fall back to the
    deterministic synthetic profile — the same real-API-with-fallback
    philosophy used elsewhere in the codebase.
    """
    if not points:
        return None
    lats = ",".join(f"{lat:.6f}" for lat, _ in points)
    lngs = ",".join(f"{lng:.6f}" for _, lng in points)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                "https://api.open-meteo.com/v1/elevation",
                params={"latitude": lats, "longitude": lngs},
            )
            response.raise_for_status()
            elevations = response.json().get("elevation")
    except (httpx.HTTPError, ValueError):
        return None

    if not isinstance(elevations, list) or len(elevations) != len(points):
        return None
    try:
        values = [float(value) for value in elevations]
    except (TypeError, ValueError):
        return None
    return values if all(value == value for value in values) else None  # reject NaN


def _synthetic_elevations(
    points: list[tuple[float, float]], seed: int
) -> list[float]:
    """Deterministic rising elevation profile used when the API is unreachable."""
    if not points:
        return []
    start_elev = 300.0 + seed % 500
    summit_elev = start_elev + 1000.0 + seed % 1500
    last = len(points) - 1
    values = []
    for index in range(len(points)):
        fraction = index / last if last else 0.0
        base = start_elev + (summit_elev - start_elev) * fraction
        if 0 < index < last:
            base += ((seed >> (index * 3)) % 61) - 30  # deterministic wobble ±30 m
        values.append(round(base, 1))
    return values

@router.post("/trekker/plan", response_model=TrekPlanResponse)
async def plan_trek(request: TrekPlanRequest) -> TrekPlanResponse:
    """Generate trekking spots (with fetched elevations) between two points.

    The user only supplies a start and a destination: waypoints are
    interpolated along the route, their elevations fetched from Open-Meteo
    (deterministic synthetic fallback offline), and the total ascent feeds the
    shared weather/feasibility/gear helpers.
    """
    (start_lat, start_lng), start_source = await geocode(request.start)
    (end_lat, end_lng), end_source = await geocode(request.destination)

    # Interpolate waypoints along the route (linear in lat/lng — fine for
    # trek-scale distances).
    route_points = [
        (
            start_lat + (end_lat - start_lat) * fraction,
            start_lng + (end_lng - start_lng) * fraction,
        )
        for fraction, _ in _TREK_SPOTS
    ]

    elevations = await _fetch_open_meteo_elevations(route_points)
    elevation_source: Literal["open-meteo", "synthetic"] = "open-meteo"
    if elevations is None:
        seed_text = f"{start_lat:.4f},{start_lng:.4f},{end_lat:.4f},{end_lng:.4f}"
        seed = int(hashlib.sha256(seed_text.encode()).hexdigest()[:8], 16)
        elevations = _synthetic_elevations(route_points, seed)
        elevation_source = "synthetic"

    # Build the spot list with cumulative distance from the start.
    spots: list[TrekSpot] = []
    cumulative = 0.0
    previous: tuple[float, float] | None = None
    for (_, name), (lat, lng), elevation in zip(_TREK_SPOTS, route_points, elevations):
        if previous is not None:
            cumulative += geodesic(previous, (lat, lng)).km
        spots.append(
            TrekSpot(
                name=name,
                lat=round(lat, 6),
                lng=round(lng, 6),
                elevation_meters=round(elevation, 1),
                distance_from_start_km=round(cumulative, 2),
            )
        )
        previous = (lat, lng)
    total_distance = round(cumulative, 2)

    # Total ascent = sum of positive elevation steps between consecutive spots.
    total_gain = round(
        sum(
            max(0.0, later - earlier)
            for earlier, later in zip(elevations, elevations[1:])
        ),
        1,
    )
    highest_point = round(max(elevations), 1)

    # Naismith's rule with the same contingency as /trekker/analyze.
    moving_hours = (
        total_distance / TREKKING_SPEED_KMH + total_gain / ASCENT_METRES_PER_HOUR
    )
    total_hours = round(moving_hours * (1.0 + REST_BUFFER_RATIO), 2)

    planned_month = request.planned_month or datetime.now().month
    mean_lat = sum(lat for lat, _ in route_points) / len(route_points)
    weather = estimate_weather(highest_point, planned_month, mean_lat)

    return TrekPlanResponse(
        start=request.start,
        destination=request.destination,
        planned_month=planned_month,
        distance_km=total_distance,
        total_elevation_gain_meters=total_gain,
        highest_point_meters=highest_point,
        estimated_duration_hours=total_hours,
        estimated_duration_minutes=round(total_hours * 60.0, 1),
        elevation_source=elevation_source,
        spots=spots,
        geocode_sources={"start": start_source, "destination": end_source},
        weather=weather,
        feasibility=compute_feasibility(weather),
        gear_checklist=build_gear_checklist(weather).as_categories(),
    )

