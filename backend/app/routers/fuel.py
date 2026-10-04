"""Fuel planning endpoints for OffWeGo.

Exposes ``POST /api/v1/fuel/plan``. Given a trip's origin, destination and
explicit ``distance_km``, plus the vehicle's economy (km per litre), tank
size and the local fuel price, it returns:

1. The total fuel required (litres) for the trip and its estimated cost.
2. The **minimum** number of refuelling stops required to complete the trip
   (a hard feasibility bound computed against the full tank range).
3. Distance markers (in km) at which refuelling is recommended so the tank
   never drops below a 15% reserve.

Why two different stop counts?
-------------------------------
``min_refuel_stops`` assumes you are willing to run the tank to empty -- it is
the fewest stops that still let you arrive. ``refuel_markers`` is the
conservative, safety-oriented schedule: it keeps a 15% reserve at all times,
so it can require *more* stops than the hard minimum. The relationship
``refuel_markers >= min_refuel_stops`` always holds.

Both are pure functions of the inputs, so the endpoint is fully deterministic
and needs no network calls.
"""

from __future__ import annotations

import math

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.routers.routes import API_V1_PREFIX

# Refuel before the tank drops below this fraction of its capacity.
RESERVE_FRACTION = 0.15

# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class FuelRequest(BaseModel):
    """Payload for ``POST /api/v1/fuel/plan``."""

    origin: str = Field(..., min_length=1, description="Start of the trip.")
    destination: str = Field(..., min_length=1, description="End of the trip.")
    distance_km: float = Field(..., ge=0, description="Trip distance in kilometres.")
    mileage_kpl: float = Field(
        ..., gt=0, description="Vehicle fuel economy in kilometres per litre."
    )
    tank_capacity_liters: float = Field(..., gt=0, description="Usable tank capacity.")
    fuel_price_per_liter: float = Field(
        ..., ge=0, description="Local price of one litre of fuel."
    )


class FuelPlan(BaseModel):
    """Fuel and refuelling plan for a single trip."""

    origin: str
    destination: str
    distance_km: float
    mileage_kpl: float
    tank_capacity_liters: float
    fuel_price_per_liter: float
    full_tank_range_km: float = Field(..., description="Distance one full tank covers.")
    usable_range_km: float = Field(
        ..., description="Distance covered before hitting the 15% reserve."
    )
    reserve_threshold_liters: float = Field(
        ..., description="Litres remaining when the 15% reserve is reached."
    )
    total_fuel_required_liters: float
    total_estimated_cost: float
    min_refuel_stops: int = Field(
        ..., description="Fewest stops needed to finish without running dry."
    )
    refuel_markers: list[float] = Field(
        ...,
        description=(
            "Distance markers (km) where refuelling is recommended before the "
            "tank reaches its 15% reserve."
        ),
    )
    recommended_refuel_stops: int = Field(
        ..., description="len(refuel_markers): stops under the 15% reserve policy."
    )


# --------------------------------------------------------------------------- #
# Calculations
# --------------------------------------------------------------------------- #
def compute_fuel_plan(request: FuelRequest) -> FuelPlan:
    """Derive fuel usage, cost and both refuelling strategies for a trip."""
    distance = request.distance_km

    # Fuel consumed over the whole trip, and what it costs.
    total_fuel_liters = distance / request.mileage_kpl
    total_cost = total_fuel_liters * request.fuel_price_per_liter

    # Tank ranges.
    full_range = request.tank_capacity_liters * request.mileage_kpl
    usable_range = full_range * (1.0 - RESERVE_FRACTION)
    reserve_threshold = request.tank_capacity_liters * RESERVE_FRACTION

    # Hard minimum: start with a full tank, every stop refills to full, and we
    # only need enough fuel to arrive (tank may end empty). Never below 0.
    min_stops = 0
    if full_range > 0 and distance > 0:
        min_stops = max(0, math.ceil(distance / full_range) - 1)

    # Conservative schedule: refuel at each multiple of the usable range that
    # falls strictly before the destination, so the reserve is never touched.
    markers: list[float] = []
    if usable_range > 0:
        step = 1
        while step * usable_range < distance:
            markers.append(round(step * usable_range, 2))
            step += 1

    return FuelPlan(
        origin=request.origin,
        destination=request.destination,
        distance_km=distance,
        mileage_kpl=request.mileage_kpl,
        tank_capacity_liters=request.tank_capacity_liters,
        fuel_price_per_liter=request.fuel_price_per_liter,
        full_tank_range_km=round(full_range, 2),
        usable_range_km=round(usable_range, 2),
        reserve_threshold_liters=round(reserve_threshold, 2),
        total_fuel_required_liters=round(total_fuel_liters, 2),
        total_estimated_cost=round(total_cost, 2),
        min_refuel_stops=min_stops,
        refuel_markers=markers,
        recommended_refuel_stops=len(markers),
    )


# --------------------------------------------------------------------------- #
# Router
# --------------------------------------------------------------------------- #
router = APIRouter(prefix=API_V1_PREFIX, tags=["fuel"])


@router.post("/fuel/plan", response_model=FuelPlan)
async def plan_fuel(request: FuelRequest) -> FuelPlan:
    """Compute fuel, cost and refuelling stops for a trip."""
    return compute_fuel_plan(request)
