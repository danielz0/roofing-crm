import { useMemo, useState } from "react";
import { trpc, type RouterOutputs } from "@roofing-crm/api-client/react";
import { basisLabel, fmtMiles, formatOpenDuration, joinAddr } from "../format";
import type { Filters, Selection } from "../state";

type PropertyResult = RouterOutputs["properties"]["search"];
type PermitResult = RouterOutputs["permits"]["search"];

export function useLeadActions() {
  const utils = trpc.useUtils();
  const leads = trpc.leads.list.useQuery({});
  const create = trpc.leads.create.useMutation({ onSuccess: () => utils.leads.list.invalidate() });
  const leadPropIds = useMemo(() => new Set((leads.data ?? []).map((l) => l.propId)), [leads.data]);
  return { create, leadPropIds };
}

export function AddLeadButton(props: {
  propId: string | null;
  permitNumber?: string;
  source: "map" | "list" | "permit" | "agent";
}) {
  const { create, leadPropIds } = useLeadActions();
  if (!props.propId)
    return (
      <span className="muted small" title="Permit is not linked to a parcel">
        no parcel
      </span>
    );
  const exists = leadPropIds.has(props.propId);
  const pending = create.isPending && create.variables?.propId === props.propId;
  return (
    <button
      className={exists ? "chip ok" : "chip primary"}
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation();
        create.mutate({ propId: props.propId!, permitNumber: props.permitNumber, source: props.source });
      }}
      title={exists ? "Lead exists; click to attach this permit" : "Create a CRM lead"}
    >
      {pending ? "Saving..." : exists ? "✓ Lead" : "+ Lead"}
    </button>
  );
}

const PRIORITY_CLASS = { high: "pri-high", medium: "pri-med", low: "pri-low" } as const;

export function CandidateList(props: {
  properties?: PropertyResult;
  permits?: PermitResult;
  loading: boolean;
  error: string | null;
  sort: Filters["propertySort"];
  onSort: (s: Filters["propertySort"]) => void;
  onSelect: (s: Selection) => void;
  selection: Selection;
}) {
  const [view, setView] = useState<"properties" | "permits">("properties");
  const [permitSort, setPermitSort] = useState<"open" | "distance">("open");
  const permits = useMemo(() => {
    const items = [...(props.permits?.items ?? [])];
    return permitSort === "open"
      ? items.sort((a, b) => (b.open_days ?? -1) - (a.open_days ?? -1))
      : items.sort((a, b) => (a.distance_miles ?? 0) - (b.distance_miles ?? 0));
  }, [props.permits, permitSort]);

  const sortHeader = (key: Filters["propertySort"], label: string) => (
    <th>
      <button className={`sort ${props.sort === key ? "on" : ""}`} onClick={() => props.onSort(key)}>
        {label}
        {props.sort === key ? " ▾" : ""}
      </button>
    </th>
  );

  return (
    <section className="candidates">
      <div className="candidates-head">
        <div className="seg">
          <button className={view === "properties" ? "active" : ""} onClick={() => setView("properties")}>
            Lead properties ({props.properties?.total.toLocaleString() ?? "..."})
          </button>
          <button className={view === "permits" ? "active" : ""} onClick={() => setView("permits")}>
            Roofing permits ({props.permits?.total.toLocaleString() ?? "..."})
          </button>
        </div>
        {props.loading && <span className="spinner" aria-label="loading" />}
        {view === "properties" && props.properties?.truncated && (
          <span className="muted small">
            Showing top {props.properties.items.length.toLocaleString()}; narrow the radius to see all.
          </span>
        )}
        {view === "permits" && props.permits?.truncated && (
          <span className="muted small">Showing top {props.permits.items.length.toLocaleString()}.</span>
        )}
      </div>
      {props.error && <p className="error">{props.error}</p>}

      <div className="table-scroll">
        {view === "properties" ? (
          <table>
            <thead>
              <tr>
                {sortHeader("priority", "Priority")}
                <th>Address</th>
                {sortHeader("roof_age_desc", "Roof age")}
                {sortHeader("open_days_desc", "Oldest open permit")}
                {sortHeader("distance_asc", "Distance")}
                <th>Owner</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(props.properties?.items ?? []).map((p) => (
                <tr
                  key={p.prop_id}
                  className={
                    props.selection?.kind === "property" && props.selection.propId === p.prop_id
                      ? "selected"
                      : ""
                  }
                  onClick={() => props.onSelect({ kind: "property", propId: p.prop_id })}
                >
                  <td>
                    <span className={`pri ${PRIORITY_CLASS[p.signals.priority]}`}>{p.signals.priority}</span>
                  </td>
                  <td>
                    <div>{p.situs_address ?? "(no situs address)"}</div>
                    <div className="muted small">
                      {joinAddr(p.situs_city, p.situs_zip)} · prop {p.prop_id}
                    </div>
                  </td>
                  <td title={basisLabel(p.roof_age_basis)}>
                    {p.roof_age_years ?? "?"} yrs
                    {p.signals.roofAgeInferred && <span className="muted small"> (est.)</span>}
                  </td>
                  <td>
                    {p.open_roofing_permit_count > 0 ? (
                      <span className={p.signals.longOpenPermit ? "long-open" : ""}>
                        {formatOpenDuration(p.oldest_open_roofing_permit_days)}
                        {p.open_roofing_permit_count > 1 && (
                          <span className="muted small"> ({p.open_roofing_permit_count} open)</span>
                        )}
                      </span>
                    ) : (
                      <span className="muted">-</span>
                    )}
                  </td>
                  <td>{fmtMiles(p.distance_miles)}</td>
                  <td className="small">{p.owner_name ?? "n/a"}</td>
                  <td>
                    <AddLeadButton
                      propId={p.prop_id}
                      permitNumber={p.oldest_open_roofing_permit_number ?? undefined}
                      source="list"
                    />
                  </td>
                </tr>
              ))}
              {props.properties && props.properties.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No properties match. Widen the radius or relax the criteria.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Permit</th>
                <th>Status</th>
                <th>
                  <button
                    className={`sort ${permitSort === "open" ? "on" : ""}`}
                    onClick={() => setPermitSort("open")}
                  >
                    Open for{permitSort === "open" ? " ▾" : ""}
                  </button>
                </th>
                <th>Address</th>
                <th>Contractor</th>
                <th>
                  <button
                    className={`sort ${permitSort === "distance" ? "on" : ""}`}
                    onClick={() => setPermitSort("distance")}
                  >
                    Distance{permitSort === "distance" ? " ▾" : ""}
                  </button>
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {permits.map((p) => (
                <tr
                  key={p.permit_number}
                  onClick={() =>
                    props.onSelect(
                      p.prop_id
                        ? { kind: "property", propId: p.prop_id }
                        : { kind: "permit", permitNumber: p.permit_number },
                    )
                  }
                >
                  <td className="mono small">{p.permit_number}</td>
                  <td>
                    {p.status ?? "n/a"}
                    {p.expired_without_final && <span className="tag warn">expired, no final</span>}
                  </td>
                  <td className={(p.open_days ?? 0) >= 365 ? "long-open" : ""}>
                    {p.is_open ? formatOpenDuration(p.open_days) : "-"}
                  </td>
                  <td className="small">{p.address ?? "n/a"}</td>
                  <td className="small">
                    {p.contractor_name ?? p.contractor_company_name ?? p.contractor_full_name ?? "n/a"}
                  </td>
                  <td>{fmtMiles(p.distance_miles)}</td>
                  <td>
                    <AddLeadButton propId={p.prop_id} permitNumber={p.permit_number} source="permit" />
                  </td>
                </tr>
              ))}
              {props.permits && props.permits.items.length === 0 && (
                <tr>
                  <td colSpan={7} className="muted">
                    No roofing permits match in this radius.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
