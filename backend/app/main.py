import os

from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app.routers.fuel import router as fuel_router
from app.routers.hotels import router as hotels_router
from app.routers.routes import router as routes_router
from app.routers.trekker import router as trekker_router

load_dotenv()

API_V1_PREFIX = "/api/v1"

app = FastAPI(
    title="OffWeGo API",
    version="1.0.0",
    docs_url="/docs",  # interactive Swagger UI
    redoc_url="/redoc",
    openapi_url=f"{API_V1_PREFIX}/openapi.json",
)

# Allow the Vite dev server to call the API during development.
# Always allow the Vite dev server, even if CORS_ORIGINS is overridden.
_origins = {o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()}
_origins.update({"http://localhost:5173", "http://127.0.0.1:5173"})

app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class HealthResponse(BaseModel):
    status: str


router = APIRouter(prefix=API_V1_PREFIX)


@router.get("/health", response_model=HealthResponse, tags=["health"])
async def health() -> HealthResponse:
    return HealthResponse(status="ok")


app.include_router(router)
app.include_router(routes_router)  # POST /api/v1/routes/calculate
app.include_router(trekker_router)  # POST /api/v1/trekker/analyze
app.include_router(fuel_router)  # POST /api/v1/fuel/plan
app.include_router(hotels_router)  # GET /api/v1/hotels/search


@app.get("/", include_in_schema=False)
async def root() -> dict[str, str]:
    return {"message": "Welcome to the OffWeGo API"}
