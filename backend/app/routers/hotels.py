"""Hotel search endpoints for OffWeGo.

Exposes ``GET /api/v1/hotels/search``, which filters a hotel catalogue by
location, lodging style and nightly budget:

* ``hotel_type="transit"``         -- convenient one-night stays; distance is
  measured to the nearest **station**.
* ``hotel_type="basecamp_lodge"``  -- trekking lodging; distance is measured
  to the nearest **trailhead**.

No hotel provider is configured for this project (``.env.example`` only lists
OpenWeatherMap and Nominatim), so -- mirroring the deterministic mock-weather
fallback in ``routes.py`` -- results are generated locally from a SHA-256 seed
of the location. The same query always returns the same hotels, prices,
ratings, distances and amenities, and the endpoint never needs the network.
Every hotel therefore reports ``source="deterministic-mock"``.
"""

from __future__ import annotations

import hashlib
from typing import Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from app.routers.routes import API_V1_PREFIX

# --------------------------------------------------------------------------- #
# Types & constants
# --------------------------------------------------------------------------- #
HotelType = Literal["transit", "basecamp_lodge"]
HotelSource = Literal["deterministic-mock"]
Landmark = Literal["station", "trailhead"]

CURRENCY = "INR"

# Nightly prices are generated in rupees; the bands below keep their original
# USD targets converted at this rate so the amounts read as real INR prices.
USD_TO_INR = 83.0

# Candidates generated before the budget filter is applied. The name pool is
# sized so every catalogue entry in one response gets a unique name.
_CATALOGUE_SIZE = 10
_AMENITY_COUNT = 5
_RATING_MIN = 3.0
_RATING_MAX = 5.0

# Nightly price bands (per hotel type) used to spread the catalogue, in INR.
_PRICE_RANGE: dict[str, tuple[float, float]] = {
    "transit": (45.0 * USD_TO_INR, 160.0 * USD_TO_INR),        # ~₹3,735-13,280
    "basecamp_lodge": (60.0 * USD_TO_INR, 260.0 * USD_TO_INR), # ~₹4,980-21,580
}

# Distance bands to the type's landmark: transit -> station, lodge -> trailhead.
_DISTANCE_RANGE: dict[str, tuple[float, float]] = {
    "transit": (0.05, 2.5),        # km to the station
    "basecamp_lodge": (0.1, 5.0),  # km to the trailhead
}

_LANDMARK: dict[str, Landmark] = {
    "transit": "station",
    "basecamp_lodge": "trailhead",
}


# --------------------------------------------------------------------------- #
# Deterministic helpers
# --------------------------------------------------------------------------- #
def _stable_unit(seed: str) -> float:
    """Return a deterministic float in ``[0, 1)`` derived from ``seed``."""
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) / 0x100000000


def _stable_index(seed: str, modulus: int) -> int:
    """Return a deterministic index in ``[0, modulus)`` derived from ``seed``."""
    digest = hashlib.sha256(seed.encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % modulus


# Name pools: 8 adjectives x 8 nouns = 64 unique combinations, comfortably
# more than _CATALOGUE_SIZE, so names never repeat within a single response.
_NAME_ADJECTIVES: dict[str, tuple[str, ...]] = {
    "transit": (
        "Central", "Riverside", "Junction", "Clocktower",
        "Gateway", "Union", "Harbour", "Old Town",
    ),
    "basecamp_lodge": (
        "Granite", "Timberline", "Alpine", "Larch",
        "Glacier", "Eagle Crest", "Sunrise", "Marmot",
    ),
}
_NAME_NOUNS: dict[str, tuple[str, ...]] = {
    "transit": ("Hotel", "Inn", "Suites", "Lodge", "Rest", "Stay", "House", "Rooms"),
    "basecamp_lodge": ("Lodge", "Chalet", "Cabins", "Hut", "Retreat", "Refuge", "Base", "Chalets"),
}

# Amenity pools: 10 options each, 5 are selected per hotel.
_AMENITIES: dict[str, tuple[str, ...]] = {
    "transit": (
        "Free Wi-Fi",
        "24h reception",
        "Luggage storage",
        "Express check-in",
        "Airport shuttle",
        "Breakfast included",
        "Laundry service",
        "Quiet rooms",
        "Laptop-safe",
        "Train timetable display",
    ),
    "basecamp_lodge": (
        "Hot showers",
        "Sauna",
        "Drying room",
        "Gear storage",
        "Packed lunch",
        "Communal fireplace",
        "Boot warmers",
        "Trail maps",
        "Home-cooked meals",
        "Early breakfast",
    ),
}


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class Hotel(BaseModel):
    """A single hotel matching a search."""

    id: str
    name: str
    hotel_type: HotelType
    location: str = Field(..., description="Echo of the searched location.")
    price_per_night: float = Field(..., ge=0, description="Nightly room rate.")
    currency: str = Field(..., description="Currency of price_per_night.")
    rating: float = Field(..., ge=0, le=5, description="Guest rating from 0 to 5.")
    nearest_landmark: Landmark = Field(
        ..., description="'station' for transit hotels, 'trailhead' for basecamp lodges."
    )
    distance_to_landmark_km: float = Field(
        ..., ge=0, description="Walking distance to nearest_landmark."
    )
    amenities: list[str] = Field(..., description="On-site facilities.")
    source: HotelSource


# --------------------------------------------------------------------------- #
# Catalogue generation (deterministic, offline)
# --------------------------------------------------------------------------- #
def _build_hotel(location: str, hotel_type: HotelType, index: int) -> Hotel:
    """Build one deterministic hotel for ``location``/``hotel_type``.

    ``index`` walks a 64-cell name grid (8 adjectives x 8 nouns) so names stay
    unique within a response while still varying per location.
    """
    seed = f"{location.strip().lower()}|{hotel_type}|{index}"

    adjectives = _NAME_ADJECTIVES[hotel_type]
    nouns = _NAME_NOUNS[hotel_type]
    # Offset is seeded WITHOUT the index so consecutive indices walk a
    # contiguous, collision-free path around the 64-cell name grid.
    name_offset = _stable_index(
        f"{location.strip().lower()}|{hotel_type}|name", len(adjectives) * len(nouns)
    )
    cell = (name_offset + index) % (len(adjectives) * len(nouns))
    name = f"{adjectives[cell % len(adjectives)]} {nouns[cell // len(adjectives)]}"

    price_lo, price_hi = _PRICE_RANGE[hotel_type]
    dist_lo, dist_hi = _DISTANCE_RANGE[hotel_type]
    price = price_lo + (price_hi - price_lo) * _stable_unit(f"{seed}|price")
    rating = _RATING_MIN + (_RATING_MAX - _RATING_MIN) * _stable_unit(f"{seed}|rating")
    distance = dist_lo + (dist_hi - dist_lo) * _stable_unit(f"{seed}|dist")

    # Pick 5 distinct amenities: a seeded offset plus a stride that is coprime
    # with the pool size (10), guaranteeing no repeats within one hotel.
    pool = _AMENITIES[hotel_type]
    offset = _stable_index(f"{seed}|amen", len(pool))
    stride = (1, 3, 7, 9)[_stable_index(f"{seed}|stride", 4)]
    picked = [pool[(offset + i * stride) % len(pool)] for i in range(_AMENITY_COUNT)]

    return Hotel(
        id=f"{hotel_type}-{index}-{_stable_index(seed, 1_000_000):06d}",
        name=name,
        hotel_type=hotel_type,
        location=location,
        price_per_night=round(price, 2),
        currency=CURRENCY,
        rating=round(rating, 1),
        nearest_landmark=_LANDMARK[hotel_type],
        distance_to_landmark_km=round(distance, 2),
        amenities=picked,
        source="deterministic-mock",
    )


def search_hotels(
    location: str, hotel_type: HotelType, budget_max: float
) -> list[Hotel]:
    """Generate the catalogue, drop anything over budget, then sort by rating."""
    candidates = [
        _build_hotel(location, hotel_type, i) for i in range(_CATALOGUE_SIZE)
    ]
    affordable = [h for h in candidates if h.price_per_night <= budget_max]
    # Best rated first; break ties on price so ordering is fully deterministic.
    affordable.sort(key=lambda h: (-h.rating, h.price_per_night, h.name))
    return affordable


# --------------------------------------------------------------------------- #
# Router
# --------------------------------------------------------------------------- #
router = APIRouter(prefix=API_V1_PREFIX, tags=["hotels"])


@router.get("/hotels/search", response_model=list[Hotel])
async def search_hotels_endpoint(
    location: str = Query(..., min_length=1, description="Place to search for hotels."),
    hotel_type: HotelType = Query(
        ...,
        description=(
            "Kind of stay: 'transit' (near the station) or "
            "'basecamp_lodge' (near the trailhead)."
        ),
    ),
    budget_max: float = Query(
        ..., ge=0, description="Maximum nightly budget for a room."
    ),
) -> list[Hotel]:
    """Return the list of hotels for ``location`` within ``budget_max``."""
    return search_hotels(location, hotel_type, budget_max)
