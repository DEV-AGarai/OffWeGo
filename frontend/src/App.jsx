import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Compass, Fuel, Hotel, MapPin, Mountain, Route, Server } from 'lucide-react'
import RouteSearch from './components/RouteSearch.jsx'
import TrekkerModule from './components/TrekkerModule.jsx'
import FuelCalculator from './components/FuelCalculator.jsx'
import Accommodations from './components/Accommodations.jsx'
import heroBg from './assets/hero-bg.jpg'

/**
 * Sidebar tabs: each entry owns one feature component so only the active
 * module is mounted (its state resets when you switch away and back).
 */
const TABS = [
  { id: 'routes', label: 'Routes', icon: Route, Component: RouteSearch },
  { id: 'trekker', label: 'Trek', icon: Mountain, Component: TrekkerModule },
  { id: 'fuel', label: 'Fuel', icon: Fuel, Component: FuelCalculator },
  { id: 'hotels', label: 'Hotels', icon: Hotel, Component: Accommodations },
]

function App() {
  const [status, setStatus] = useState('checking...')
  const [activeTab, setActiveTab] = useState('routes')
  const plannerRef = useRef(null)

  useEffect(() => {
    fetch('/api/v1/health')
      .then((res) => res.json())
      .then((data) => setStatus(data.status))
      .catch(() => setStatus('unreachable'))
  }, [])

  const active = TABS.find((tab) => tab.id === activeTab) ?? TABS[0]
  const ActiveComponent = active.Component

  /** Smoothly scroll from the landing hero down to the planner dashboard. */
  const handleGetStarted = () => {
    plannerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="bg-slate-900 text-white">
      {/* ---------- Full-screen landing hero ---------- */}
      <section className="relative flex h-screen min-h-[560px] w-full items-center justify-center overflow-hidden bg-[#151c17]">
        {/* Background artwork (assets/hero-bg.jpg) */}
        <img
          src={heroBg}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* Dark gradient scrim keeps the copy readable over the artwork */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, rgba(2,6,23,0.55) 0%, rgba(2,6,23,0.78) 38%, rgba(2,6,23,0.90) 66%, #0f172a 100%)',
          }}
        />

        <div className="relative z-10 mx-auto flex w-full max-w-3xl flex-col items-center gap-5 px-6 text-center sm:gap-6">
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/30 bg-emerald-500/10 px-4 py-1.5 text-xs font-semibold uppercase tracking-widest text-emerald-300 sm:text-sm">
            <MapPin className="h-3.5 w-3.5 sm:h-4 sm:w-4" aria-hidden="true" />
            Multimodal Trip Planner
          </span>

          <h1 className="text-4xl font-extrabold leading-[1.1] tracking-tight [text-shadow:0_2px_24px_rgba(0,0,0,0.65)] sm:text-5xl lg:text-7xl">
            Explore Without Limits
            <span className="block text-emerald-400">with OffWeGo</span>
          </h1>

          <p className="max-w-2xl text-base text-slate-300 sm:text-xl">
            Compare flights, trains, buses, drives and walks — then plan treks, budget fuel and
            find stays. Every journey, one dashboard.
          </p>

          <button
            type="button"
            onClick={handleGetStarted}
            className="group mt-1 inline-flex items-center gap-3 rounded-xl bg-emerald-500 px-8 py-4 text-lg font-bold text-slate-950 shadow-xl shadow-emerald-500/25 transition hover:bg-emerald-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900"
          >
            Plan Your Trip
            <Compass
              className="h-6 w-6 transition-transform duration-300 group-hover:rotate-45"
              aria-hidden="true"
            />
          </button>

          <button
            type="button"
            onClick={handleGetStarted}
            className="inline-flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-slate-200"
          >
            Scroll to the planner
            <ChevronDown className="h-4 w-4 animate-bounce" aria-hidden="true" />
          </button>
        </div>
      </section>

      {/* ---------- Multimodal / Trekker planner dashboard ---------- */}
      <div id="planner" ref={plannerRef} className="flex min-h-screen bg-slate-900 text-white">
        {/* Sidebar navigation */}
        <nav
          aria-label="Sections"
          className="flex w-14 flex-col gap-1 border-r border-slate-800 bg-slate-950/60 p-2 sm:w-48 sm:p-3"
        >
          <div className="flex items-center gap-2 px-2 py-3">
            <MapPin className="h-7 w-7 shrink-0 text-emerald-400" aria-hidden="true" />
            <span className="hidden text-lg font-bold sm:block">OffWeGo</span>
          </div>

          <ul className="flex flex-col gap-1">
            {TABS.map((tab) => {
              const Icon = tab.icon
              const isActive = tab.id === activeTab
              return (
                <li key={tab.id}>
                  <button
                    type="button"
                    aria-current={isActive ? 'page' : undefined}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                      isActive
                        ? 'bg-emerald-500/15 text-emerald-400'
                        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <span className="hidden sm:block">{tab.label}</span>
                  </button>
                </li>
              )
            })}
          </ul>

          <p className="mt-auto flex items-center gap-2 px-2 py-3 text-xs text-slate-400">
            <Server className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="hidden sm:block">
              API: <span className="font-mono text-emerald-400">{status}</span>
            </span>
          </p>
        </nav>

        {/* Active feature module */}
        <main className="flex flex-1 flex-col items-center gap-6 overflow-x-auto p-4 sm:p-8">
          <header className="flex w-full max-w-5xl items-center gap-3">
            <active.icon className="h-6 w-6 text-emerald-400" aria-hidden="true" />
            <h2 className="text-2xl font-bold">{active.label}</h2>
          </header>
          <ActiveComponent />
        </main>
      </div>
    </div>
  )
}

export default App
