import { keepPreviousData } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { trpc } from "@roofing-crm/api-client/react";
import { AgentView } from "./components/AgentView";
import { CandidateList } from "./components/CandidateList";
import { DetailPanel } from "./components/DetailPanel";
import { FiltersPanel } from "./components/FiltersPanel";
import { FutureNav } from "./components/FutureNav";
import { LeadsView } from "./components/LeadsView";
import { MapView } from "./components/MapView";
import type { Filters, Selection } from "./state";

type Tab = "map" | "leads" | "agent";

export function App({ apiUrl }: { apiUrl: string }) {
  const config = trpc.meta.config.useQuery();
  const snapshot = trpc.meta.snapshot.useQuery();
  const [tab, setTab] = useState<Tab>("map");
  const [filters, setFilters] = useState<Filters | null>(null);
  const [selection, setSelection] = useState<Selection>(null);

  useEffect(() => {
    if (config.data && !filters) {
      setFilters({
        center: config.data.county.center,
        centerSource: "default",
        radiusMiles: config.data.defaults.radiusMiles,
        minRoofAgeYears: config.data.defaults.roofAgeThresholdYears,
        matchMode: "either",
        minOpenYears: 0,
        permitStatuses: [],
        propertySort: "priority",
      });
    }
  }, [config.data, filters]);

  if (config.error) {
    return (
      <div className="boot-error">
        <h2>Cannot reach the CRM API</h2>
        <p>
          Tried <code>{apiUrl}</code>: {config.error.message}
        </p>
        <p>
          Start it with <code>pnpm dev</code> and make sure <code>CRM_DATA_BASE_URL</code> points at a
          pipeline snapshot.
        </p>
      </div>
    );
  }
  if (!config.data || !filters) return <div className="boot">Loading snapshot...</div>;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">▲</span>
          <div>
            <strong>Roofing Lead CRM</strong>
            <span className="muted">
              {config.data.county.name}, {config.data.county.state}
            </span>
          </div>
        </div>
        <nav className="tabs">
          <button className={tab === "map" ? "active" : ""} onClick={() => setTab("map")}>
            Lead map
          </button>
          <button className={tab === "leads" ? "active" : ""} onClick={() => setTab("leads")}>
            CRM leads
          </button>
          <button className={tab === "agent" ? "active" : ""} onClick={() => setTab("agent")}>
            Ask the agent
          </button>
          <FutureNav />
        </nav>
        <div className="snapshot muted" title={snapshot.data?.baseUrl}>
          Snapshot {snapshot.data?.runId ?? "..."} · as of {snapshot.data?.asOfDate ?? "..."}
        </div>
      </header>

      {snapshot.data && snapshot.data.limitations.length > 0 && (
        <details className="limitations">
          <summary>Data notes ({snapshot.data.limitations.length})</summary>
          <ul>
            {snapshot.data.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </details>
      )}

      <main className={`main tab-${tab}`}>
        {tab === "map" && (
          <MapWorkspace
            filters={filters}
            setFilters={setFilters}
            selection={selection}
            setSelection={setSelection}
            bounds={config.data.county.bounds}
            longOpenDays={config.data.defaults.longOpenPermitDays}
          />
        )}
        {tab === "leads" && (
          <LeadsView
            onOpen={(propId) => {
              setSelection({ kind: "property", propId });
              setTab("map");
            }}
          />
        )}
        {tab === "agent" && (
          <AgentView
            filters={filters}
            onShowOnMap={(center, propId) => {
              setFilters({ ...filters, center, centerSource: "agent" });
              if (propId) setSelection({ kind: "property", propId });
              setTab("map");
            }}
          />
        )}
      </main>
    </div>
  );
}

function MapWorkspace(props: {
  filters: Filters;
  setFilters: (f: Filters) => void;
  selection: Selection;
  setSelection: (s: Selection) => void;
  bounds: [number, number, number, number];
  longOpenDays: number;
}) {
  const { filters, setFilters, selection, setSelection } = props;
  const minOpenDays = Math.round(filters.minOpenYears * 365);
  const propertyQuery = trpc.properties.search.useQuery(
    {
      center: filters.center,
      radiusMiles: filters.radiusMiles,
      matchMode: filters.matchMode,
      minRoofAgeYears: filters.minRoofAgeYears,
      minOpenDays,
      sort: filters.propertySort,
      limit: 2000,
    },
    { placeholderData: keepPreviousData },
  );
  const permitQuery = trpc.permits.search.useQuery(
    {
      center: filters.center,
      radiusMiles: filters.radiusMiles,
      openOnly: filters.permitStatuses.length === 0,
      minOpenDays,
      statuses: filters.permitStatuses,
      sort: "open_days_desc",
      limit: 1000,
    },
    { placeholderData: keepPreviousData },
  );
  const selectedPropId = useMemo(
    () => (selection?.kind === "property" ? selection.propId : null),
    [selection],
  );

  return (
    <>
      <FiltersPanel
        filters={filters}
        setFilters={setFilters}
        stats={propertyQuery.data?.stats}
        loading={propertyQuery.isFetching}
      />
      <div className="map-column">
        <MapView
          center={filters.center}
          radiusMiles={filters.radiusMiles}
          bounds={props.bounds}
          properties={propertyQuery.data?.items ?? []}
          longOpenDays={props.longOpenDays}
          selectedPropId={selectedPropId}
          onPin={(center) => setFilters({ ...filters, center, centerSource: "pin" })}
          onSelect={(propId) => setSelection({ kind: "property", propId })}
        />
        <CandidateList
          properties={propertyQuery.data}
          permits={permitQuery.data}
          loading={propertyQuery.isFetching || permitQuery.isFetching}
          error={propertyQuery.error?.message ?? permitQuery.error?.message ?? null}
          sort={filters.propertySort}
          onSort={(propertySort) => setFilters({ ...filters, propertySort })}
          onSelect={setSelection}
          selection={selection}
        />
      </div>
      {selection && (
        <DetailPanel selection={selection} onClose={() => setSelection(null)} onSelect={setSelection} />
      )}
    </>
  );
}
