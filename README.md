# RouteVerse — AI Multimodal Travel & Trekking Planner

![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=flat-square&logo=fastapi&logoColor=white)
![React](https://img.shields.io/badge/React-19-20232A?style=flat-square&logo=react&logoColor=61DAFB)
![Vite](https://img.shields.io/badge/Vite-8-646CFF?style=flat-square&logo=vite&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-0B1120?style=flat-square&logo=tailwindcss&logoColor=38BDF8)
![Leaflet](https://img.shields.io/badge/Leaflet-1.9-20232A?style=flat-square&logo=leaflet&logoColor=199900)
![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=flat-square&logo=python&logoColor=white)
![Uvicorn](https://img.shields.io/badge/Uvicorn-009688?style=flat-square&logo=uvicorn&logoColor=white)

## Overview

**RouteVerse** is a full-stack travel companion that plans a journey end-to-end — from
comparing **how** you travel to deciding **what you'll do when you arrive**. It compares
Flight, Train, Bus, Drive and Walk side-by-side with **weather-adjusted** arrival times,
auto-plans treks with real elevation data, budgets fuel in ₹, finds stays inside your
budget, tracks your live GPS position on a map, and suggests tourist spots at your
destination — all from a single tabbed dashboard behind a full-screen landing hero.

The whole platform runs **out of the box with zero API keys**: every external service
(geocoding, weather, tourist data, hotels) degrades gracefully to deterministic,
SHA-256-seeded mock data, so a judge can clone, run two commands, and click through
every feature offline. When keys *are* provided, live data flows through automatically.

> **Naming note:** the UI brand and the OpenAPI service title read **“OffWeGo”** inside
> the codebase (e.g. `OffWeGo API`, sidebar logo); the project itself is presented as
> **RouteVerse**. Functionally they are the same app.

## Key Features

- **🌤 Multimodal routing, weather-aware** — `POST /routes/calculate` geocodes both ends
  (Nominatim), pulls live weather (OpenWeatherMap) and returns distance plus base and
  weather-adjusted ETAs for **Flight · Train · Bus · Drive · Walk**. Walking slows 25% in
  rain/snow, driving slows 15% in storms; cards highlight delays and the destination
  weather alert badge.
- **🥾 Trekker module** — two modes: *Analyze* an existing Home → Base Camp → Summit trek
  (feasibility score, distance, duration, gear checklist from the planned month), or
  *Plan* a trek from just two endpoints and get auto-generated waypoints with **fetched
  real elevations** plus a full feasibility analysis.
- **⛽ Fuel calculator** — distance + mileage + tank size + ₹/litre → total litres, total
  cost in **INR**, minimum refuel stops and refuel markers for the route.
- **🏨 Accommodations** — stay search within a **₹ budget** for two stay types
  (`transit` near the station, `basecamp_lodge` near the trailhead), filtered by budget
  and sorted by rating; fully deterministic catalogue, INR pricing.
- **📍 Live GPS location tracking** — one-click *Use Current Location* via the browser
  Geolocation API, upgraded to a readable address through reverse-geocoding, rendered on
  a **Leaflet** map that keeps watching your position in real time.
- **🧭 Tourist-spot suggestions** — every route search also fetches nearby attractions
  from **Wikipedia's geosearch API** (name, description, photo, distance, article link),
  noise-filtered and sorted by distance, with an offline fallback.
- **🖼 Landing experience** — full-screen hero (gradient-scrimmed artwork, headline, CTA)
  with smooth-scroll into the tabbed dashboard.

## Tech Stack

| Layer     | Technology |
| --------- | ---------- |
| **Frontend** | React 19, Vite 8, Tailwind CSS 4, Leaflet + React-Leaflet, Axios, lucide-react icons, oxlint |
| **Backend**  | FastAPI, Python **3.10+**, Pydantic v2, Uvicorn, Geopy (Nominatim), HTTPX, python-dotenv |
| **Data / APIs** | Nominatim (geocoding), OpenWeatherMap (optional), Wikipedia geosearch (tourist spots), deterministic SHA-256 mock fallbacks for everything else |
| **Tooling**  | Vite dev-server proxy (`/api → 127.0.0.1:8000`), interactive Swagger/OpenAPI docs, `concurrently` root runner (Windows) |

## Prerequisites

| Tool | Minimum | Tested with |
| ---- | ------- | ----------- |
| Python | **3.10+** | 3.13.0 |
| Node.js | **20 LTS+** (required by Vite 8) | 22.17.0 |
| npm | 9+ | 10.9.2 |
| pip / venv | bundled with Python | — |

**Linux (Ubuntu / Debian):**

```bash
sudo apt update
sudo apt install -y python3 python3-venv python3-pip curl

# Node 20+ via NodeSource (distro apt ships an outdated Node)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
# …or install nvm first: https://github.com/nvm-sh/nvm  →  nvm install --lts
```

**macOS (Homebrew):**

```bash
brew install python node
# or, if you prefer version managers:
brew install nvm && nvm install --lts
```

Verify:

```bash
python3 --version   # Python 3.10+
node -v             # v20+
npm -v
```

## Environment Variables (`.env`)

**No environment variables are required to run the app.** Every variable is optional and
each external dependency has a deterministic mock fallback when its key is missing.

### Backend — `backend/.env`

Copy the template and edit only what you need:

```bash
cp backend/.env.example backend/.env
```

| Variable | Default | Purpose | If left blank / unset |
| -------- | ------- | ------- | --------------------- |
| `OPENWEATHER_API_KEY` | *(empty)* | Live weather for the destination (OpenWeatherMap, metric) | **Deterministic mock weather** seeded per destination (SHA-256) — rain/snow/storm flags still drive the speed engine |
| `NOMINATIM_USER_AGENT` | `offwego-route-calculator` | User-Agent sent to Nominatim (forward + reverse geocoding) | Built-in default is used; if the geocoder is unreachable, coordinates fall back to a deterministic hash-based location |
| `CORS_ORIGINS` | *(empty)* | Extra comma-separated origins allowed to call the API (e.g. `http://localhost:5174`) | `http://localhost:5173` and `http://127.0.0.1:5173` are **always** allowed regardless |

Example `backend/.env`:

```dotenv
CORS_ORIGINS=http://localhost:5173
OPENWEATHER_API_KEY=
NOMINATIM_USER_AGENT=offwego-route-calculator
```

> The `.env` file is loaded by the backend at startup (`python-dotenv`) and is
> git-ignored. The Vite dev-server proxy makes CORS a non-issue for the frontend.

### Frontend — `frontend/.env` (optional)

| Variable | Default | Purpose |
| -------- | ------- | ------- |
| `VITE_API_BASE_URL` | `/api/v1` (same-origin) | Absolute API base, e.g. `https://api.example.com/api/v1`, for deployments **without** the Vite proxy. In development you should leave it unset — requests go through the proxy at `vite.config.js` → `http://127.0.0.1:8000`. |

Services that need **no key at all**: hotels catalogue, fuel maths, trek analysis, and
tourist-spot suggestions (live Wikipedia geosearch, with a seeded offline fallback).

## Project Structure

```
.
├── backend/
│   ├── .env.example          # environment template
│   ├── requirements.txt      # fastapi, uvicorn, pydantic, httpx, python-dotenv, geopy
│   └── app/
│       ├── main.py           # FastAPI app, CORS, /api/v1/health, router mounting
│       └── routers/
│           ├── routes.py     # multimodal calculate, reverse-geocode, tourist spots
│           ├── trekker.py    # trek analysis + auto planning (real elevations)
│           ├── fuel.py       # fuel / cost / refuel-stop planner (INR)
│           └── hotels.py     # budget stay search (INR)
├── frontend/
│   ├── index.html
│   ├── vite.config.js        # React + Tailwind plugins, /api dev proxy
│   └── src/
│       ├── App.jsx           # full-screen hero + tabbed dashboard shell
│       ├── main.jsx / index.css
│       ├── components/
│       │   ├── RouteSearch.jsx        # multimodal cards + tourist spots
│       │   ├── TrekkerModule.jsx
│       │   ├── FuelCalculator.jsx
│       │   ├── Accommodations.jsx
│       │   └── LocationMap.jsx / LocationMapView.jsx   # Leaflet map
│       ├── hooks/useGeolocation.js    # live GPS tracking
│       ├── services/api.js            # Axios client + typed endpoint wrappers
│       └── assets/                    # hero artwork
├── package.json              # root convenience scripts (Windows: npm run dev)
└── README.md
```

## Setup & Run

You need **two terminals** — one for the backend (port `8000`), one for the frontend
(port `5173`). No environment file is required for a first run.

### 1. Get the code

```bash
git clone <your-repo-url>
cd <repo-directory>
```

### 2. Backend — FastAPI on `http://localhost:8000` *(Terminal 1)*

```bash
cd backend

# Create and activate a virtual environment
python3 -m venv venv
source venv/bin/activate          # Linux / macOS
# Windows (PowerShell):  venv\Scripts\Activate.ps1

# Install dependencies
pip install --upgrade pip
pip install -r requirements.txt

# (Optional) configure environment
cp .env.example .env              # works fine with all keys left blank

# Launch the API
python -m uvicorn app.main:app --reload --port 8000
```

Expected output:

```text
INFO:     Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
INFO:     Application startup complete.
```

Verify it answers:

```bash
curl http://localhost:8000/api/v1/health
# {"status":"ok"}
```

> Interactive API docs are live at **<http://localhost:8000/docs>** (Swagger UI) and
> **<http://localhost:8000/redoc>** (ReDoc).

### 3. Frontend — Vite on `http://localhost:5173` *(Terminal 2)*

```bash
cd frontend
npm install
npm run dev
```

Vite prints:

```text
  VITE  v8.x  ready in xxx ms
  ➜  Local:   http://localhost:5173/
```

Open **<http://localhost:5173>** — the hero appears first; press **Plan Your Trip** (or
scroll) to reach the dashboard. The sidebar footer should read **`API: ok`**, which
means the browser reached FastAPI through the dev proxy.

> **How the pieces connect:** the Vite dev server proxies every `/api/*` request to
> `http://127.0.0.1:8000` (see `frontend/vite.config.js`), so the frontend always calls
> its own origin — no CORS setup needed. Keep the backend's port at `8000` (or update
> the proxy to match).

### 4. Smoke-test in 30 seconds

1. Open <http://localhost:5173> → sidebar shows **`API: ok`**.
2. **Routes tab** → search e.g. `Kanpur` → `Agra` → five mode cards + weather badge +
   tourist-spot suggestions appear.
3. **Trek / Fuel / Hotels tabs** → each renders results with no configuration.

### Notes

- **Windows:** the root `package.json` ships a one-shot runner
  (`npm run install:all`, then `npm run dev` via `concurrently`). Its backend script
  uses the Windows venv path — on **Linux/macOS** simply run the two terminal flows
  above instead.
- **Ports busy?** Run `python -m uvicorn app.main:app --reload --port 8001` and point
  the proxy at `8001`, or `npm run dev -- --port 5174` (the proxy follows the page
  origin automatically).
- **Production build:** `cd frontend && npm run build` (output in `frontend/dist/`),
  served by any static host that proxies `/api` to the API.

## API Endpoints Summary

**Base URL:** `http://localhost:8000/api/v1` · **OpenAPI JSON:**
`/api/v1/openapi.json` · **Swagger UI:** `/docs`

| Method | Endpoint | Description | Inputs |
| ------ | -------- | ----------- | ------ |
| `GET`  | `/api/v1/health` | Liveness probe → `{"status":"ok"}` | — |
| `POST` | `/api/v1/routes/calculate` | Distance + base & weather-adjusted ETAs for Flight/Train/Bus/Drive/Walk, plus destination weather | body: `origin`, `destination` (place or `"lat,lon"`), `preferred_mode` (`Driving\|Bus\|Train\|Flight\|Walking`) |
| `GET`  | `/api/v1/routes/reverse-geocode` | Coordinates → readable address (Nominatim) | query: `lat`, `lng` |
| `GET`  | `/api/v1/routes/tourist-spots` | Up to 12 attractions near a destination (Wikipedia geosearch + offline fallback) | query: `place` |
| `POST` | `/api/v1/trekker/analyze` | Feasibility score, distance, duration and gear checklist for a Home → Base Camp → Summit trek | body: `home_location`, `base_camp`, `summit_location`, `elevation_meters`, `planned_month` (1–12) |
| `POST` | `/api/v1/trekker/plan` | Auto-generates trek waypoints (with fetched elevations) + full feasibility analysis | body: `start`, `destination`, `planned_month?` (defaults to current month) |
| `POST` | `/api/v1/fuel/plan` | Total fuel (L), cost (**₹ INR**), minimum refuel stops and refuel markers | body: `origin`, `destination`, `distance_km`, `mileage_kpl`, `tank_capacity_liters`, `fuel_price_per_liter` |
| `GET`  | `/api/v1/hotels/search` | Stays within a nightly ₹ budget, sorted by rating | query: `location`, `hotel_type` (`transit` \| `basecamp_lodge`), `budget_max` |

### Quick `curl` examples

```bash
# Health
curl http://localhost:8000/api/v1/health

# Multimodal route with weather-adjusted ETAs
curl -X POST http://localhost:8000/api/v1/routes/calculate \
  -H 'Content-Type: application/json' \
  -d '{"origin":"Kanpur","destination":"Agra","preferred_mode":"Driving"}'

# Reverse geocode
curl 'http://localhost:8000/api/v1/routes/reverse-geocode?lat=26.51&lng=80.23'

# Tourist spots near a destination
curl 'http://localhost:8000/api/v1/routes/tourist-spots?place=Agra'

# Trek feasibility analysis
curl -X POST http://localhost:8000/api/v1/trekker/analyze \
  -H 'Content-Type: application/json' \
  -d '{"home_location":"Manali","base_camp":"Solang Valley","summit_location":"Beas Kund","elevation_meters":1400,"planned_month":6}'

# Trek auto-planning from just two points
curl -X POST http://localhost:8000/api/v1/trekker/plan \
  -H 'Content-Type: application/json' \
  -d '{"start":"Manali","destination":"Solang","planned_month":6}'

# Fuel budget (INR)
curl -X POST http://localhost:8000/api/v1/fuel/plan \
  -H 'Content-Type: application/json' \
  -d '{"origin":"Kanpur","destination":"Agra","distance_km":243,"mileage_kpl":15,"tank_capacity_liters":45,"fuel_price_per_liter":102.5}'

# Hotels within budget (INR)
curl 'http://localhost:8000/api/v1/hotels/search?location=Manali&hotel_type=basecamp_lodge&budget_max=4000'
```

**Response conventions**

- Every response is snake_case JSON validated by Pydantic models.
- Resources that depend on external services expose a `source` field
  (e.g. weather `source: "openweathermap" | "mock"`, spots
  `source: "wikipedia" | "mock"`, geocode `source: "nominatim" | "coordinates" | "mock"`)
  so clients can tell live data from deterministic fallbacks.
- Validation failures return FastAPI's standard `422` payload; the frontend surfaces
  the first few field errors inline.

## Built with Cline

This project was built end-to-end with **Cline**, an autonomous AI coding agent, acting
as a pair-programmer that drives the entire development loop inside the editor:

- **Repository exploration & planning** — before writing a line of code, Cline scanned
  the existing codebase (imports, conventions, router patterns, component style) and
  proposed an implementation plan that matched the project's established architecture,
  including naming, error-handling and file layout decisions.
- **Full-stack scaffolding** — Cline generated the FastAPI application
  (`main.py`, four routers, Pydantic request/response models, CORS, `.env.example`)
  and the React dashboard (tabbed shell, five feature components, Axios service layer,
  the Geolocation hook, and the full-screen landing hero) directly from natural-language
  prompts in chat.
- **Autonomous verification loops** — every change was validated by Cline itself before
  being handed over: it ran `oxlint` to zero warnings, `vite build` to a clean bundle,
  server-side-render smoke tests that assert the rendered markup, live `curl`/HTTP checks
  against all eight endpoints, and single-listener checks on port `8000` after every
  backend restart.
- **Self-directed debugging** — Cline diagnosed production issues from first principles
  with its own diagnostic scripts: it traced a mystery *“Cannot reach the OffWeGo API”*
  to a proxy/CORS/IPv6 mismatch (and moved the client to same-origin proxy calls), and
  found that Wikipedia's edge was returning `403` because the `User-Agent` lacked a
  project URL — fixing it after a systematic header-variant experiment. Temporary debug
  files were cleaned up automatically after each investigation.
- **Iterative collaboration** — features (weather badges, tourist-spot suggestions,
  hero redesign, INR pricing) were refined through follow-up chat messages, with Cline
  re-reading only the relevant files, applying targeted edits, and re-running the full
  validation suite each time.

The result is a coherent, convention-consistent codebase where the agent handled
scaffolding, implementation, testing and debugging while the human stayed focused on
product decisions.

## Troubleshooting

| Symptom | Fix |
| ------- | --- |
| Sidebar shows `API: unreachable` | Is the backend running in Terminal 1? `curl http://localhost:8000/api/v1/health` must return `{"status":"ok"}`. |
| `Address already in use` on 8000 | Stop the old process (`pkill -f uvicorn`) or start on another port and update `frontend/vite.config.js`. |
| `vite` starts on `5174` | Port 5173 is occupied — that's fine, the proxy works on any port; or free 5173 first. |
| `python3: command not found` / `venv` missing | Install `python3-venv` (Debian/Ubuntu) or `brew install python`. |
| Wikipedia/tourist spots show *offline picks* | The geocoder or Wikipedia was unreachable — fallbacks are intentional and deterministic; retry later for live data. |
| `npm install` fails on old Node | Upgrade to Node 20+ (`nvm install --lts`). |

---

<p align="center"><b>RouteVerse — plan the route, pack the trek, enjoy the trip.</b><br>Built with React · FastAPI · Cline</p>
