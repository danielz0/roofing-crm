import { useState } from "react";
import { MAX_RADIUS_MILES, type LeadMatchMode } from "@roofing-crm/shared";
import { trpc } from "@roofing-crm/api-client/react";
import type { Filters } from "../state";

type Stats = {
  inRadius: number;
  agedRoofs: number;
  withOpenPermits: number;
  withLongOpenPermits: number;
  matches: number;
};

const MATCH_MODES: { value: LeadMatchMode; label: string }[] = [
  { value: "either", label: "Aged roof OR open permit" },
  { value: "aged_roof", label: "Aged roof only" },
  { value: "open_permit", label: "Open roofing permit only" },
  { value: "both", label: "Aged roof AND open permit" },
];

const CENTER_LABEL: Record<Filters["centerSource"], string> = {
  default: "County default center",
  gps: "Your GPS location",
  pin: "Dropped pin",
  agent: "Agent result",
};

export function FiltersPanel(props: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  stats?: Stats;
  loading: boolean;
}) {
  const { filters, setFilters, stats } = props;
  const statuses = trpc.permits.statuses.useQuery();
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [gpsBusy, setGpsBusy] = useState(false);
  const update = (patch: Partial<Filters>) => setFilters({ ...filters, ...patch });

  const useGps = () => {
    if (!("geolocation" in navigator)) {
      setGpsError("Geolocation is not available in this browser.");
      return;
    }
    setGpsBusy(true);
    setGpsError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsBusy(false);
        update({ center: { lat: pos.coords.latitude, lng: pos.coords.longitude }, centerSource: "gps" });
      },
      (err) => {
        setGpsBusy(false);
        setGpsError(err.message || "Location permission denied.");
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  return (
    <aside className="filters">
      <section>
        <h3>Search center</h3>
        <p className="center-line">
          <strong>{CENTER_LABEL[filters.centerSource]}</strong>
          <span className="muted mono">
            {filters.center.lat.toFixed(5)}, {filters.center.lng.toFixed(5)}
          </span>
        </p>
        <button onClick={useGps} disabled={gpsBusy}>
          {gpsBusy ? "Locating..." : "Use my GPS location"}
        </button>
        <p className="hint">Or click anywhere on the map / drag the pin.</p>
        {gpsError && <p className="error">{gpsError}</p>}
      </section>

      <section>
        <label htmlFor="radius">
          Radius <strong>{filters.radiusMiles} mi</strong>
        </label>
        <input
          id="radius"
          type="range"
          min={0.25}
          max={Math.min(25, MAX_RADIUS_MILES)}
          step={0.25}
          value={filters.radiusMiles}
          onChange={(e) => update({ radiusMiles: Number(e.target.value) })}
        />
        <input
          type="number"
          min={0.1}
          max={MAX_RADIUS_MILES}
          step={0.1}
          value={filters.radiusMiles}
          aria-label="Radius in miles"
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v > 0 && v <= MAX_RADIUS_MILES) update({ radiusMiles: v });
          }}
        />
      </section>

      <section>
        <h3>Lead criteria</h3>
        <label htmlFor="mode">Show properties with</label>
        <select
          id="mode"
          value={filters.matchMode}
          onChange={(e) => update({ matchMode: e.target.value as LeadMatchMode })}
        >
          {MATCH_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        <label htmlFor="roofage">Roof older than (years)</label>
        <input
          id="roofage"
          type="number"
          min={0}
          max={100}
          value={filters.minRoofAgeYears}
          onChange={(e) => update({ minRoofAgeYears: Math.max(0, Math.round(Number(e.target.value))) })}
        />

        <label htmlFor="openyears">Permit open at least (years)</label>
        <select
          id="openyears"
          value={filters.minOpenYears}
          onChange={(e) => update({ minOpenYears: Number(e.target.value) })}
        >
          {[0, 0.5, 1, 2, 3, 5, 10].map((y) => (
            <option key={y} value={y}>
              {y === 0 ? "Any open permit" : `${y}+ years`}
            </option>
          ))}
        </select>

        <label htmlFor="statuses">Permit list status</label>
        <select
          id="statuses"
          multiple
          size={Math.min(6, Math.max(3, statuses.data?.length ?? 3))}
          value={filters.permitStatuses}
          onChange={(e) =>
            update({ permitStatuses: Array.from(e.target.selectedOptions).map((o) => o.value) })
          }
        >
          {(statuses.data ?? []).map((s) => (
            <option key={s.status} value={s.status}>
              {s.status} ({s.count.toLocaleString()})
            </option>
          ))}
        </select>
        <p className="hint">
          {filters.permitStatuses.length ? (
            <button className="link" onClick={() => update({ permitStatuses: [] })}>
              Clear status filter (back to open permits)
            </button>
          ) : (
            "None selected = currently open permits."
          )}
        </p>
      </section>

      <section className="stats">
        <h3>In this radius {props.loading && <span className="spinner" aria-label="loading" />}</h3>
        {stats ? (
          <dl>
            <dt>Properties</dt>
            <dd>{stats.inRadius.toLocaleString()}</dd>
            <dt>Roof ≥ {filters.minRoofAgeYears} yrs</dt>
            <dd>{stats.agedRoofs.toLocaleString()}</dd>
            <dt>Open roofing permits</dt>
            <dd>{stats.withOpenPermits.toLocaleString()}</dd>
            <dt>Long-open permits</dt>
            <dd>{stats.withLongOpenPermits.toLocaleString()}</dd>
            <dt>Lead candidates</dt>
            <dd>
              <strong>{stats.matches.toLocaleString()}</strong>
            </dd>
          </dl>
        ) : (
          <p className="muted">...</p>
        )}
      </section>
    </aside>
  );
}
