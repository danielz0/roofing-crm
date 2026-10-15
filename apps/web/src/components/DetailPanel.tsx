import { trpc, type RouterOutputs } from "@roofing-crm/api-client/react";
import type { BbbStatus } from "@roofing-crm/shared";
import { basisLabel, fmtDate, fmtMoney, formatOpenDuration, joinAddr } from "../format";
import type { Selection } from "../state";
import { AddLeadButton } from "./CandidateList";

type Permit = RouterOutputs["properties"]["get"]["permits"][number];
type ContractorDetail = RouterOutputs["properties"]["get"]["contractors"][number];

export function BbbBadge({
  bbb,
  permitRating,
}: {
  bbb: BbbStatus | undefined;
  permitRating?: string | null;
}) {
  if (bbb?.state === "available") {
    return (
      <span className="bbb ok" title={bbb.profile.name ?? undefined}>
        BBB {bbb.profile.rating ?? "unrated"}
        {bbb.profile.accredited ? " · accredited" : ""}
        {bbb.profile.profile_url && (
          <>
            {" "}
            <a href={bbb.profile.profile_url} target="_blank" rel="noreferrer">
              profile
            </a>
          </>
        )}
      </span>
    );
  }
  if (permitRating) return <span className="bbb ok">BBB {permitRating}</span>;
  return (
    <span className="bbb na" title={bbb && "reason" in bbb ? bbb.reason : undefined}>
      BBB rating not available
    </span>
  );
}

function ContractorCard({ c }: { c: ContractorDetail }) {
  if (!c.contractor) return null;
  const k = c.contractor;
  return (
    <div className="card">
      <div className="card-head">
        <strong>{k.display_name}</strong>
        <BbbBadge bbb={c.bbb} />
      </div>
      <div className="small muted">
        {k.roofing_permit_count ?? 0} roofing permits ({k.open_roofing_permit_count ?? 0} open) ·{" "}
        {k.permit_count ?? 0} permits total · active {fmtDate(k.first_permit_issued)} →{" "}
        {fmtDate(k.last_permit_issued)}
      </div>
      {k.phones.length > 0 && <div className="small">Phone: {k.phones.join(", ")}</div>}
      {k.trades.length > 0 && <div className="small">Trades: {k.trades.join(", ")}</div>}
      {k.taxpayer_number && (
        <div className="small">
          TX taxpayer {k.taxpayer_number} <span className="muted">({k.business_match_method})</span>
        </div>
      )}
      {c.bbb.state !== "available" && "reason" in c.bbb && <div className="small muted">{c.bbb.reason}</div>}
    </div>
  );
}

function PermitRow({ p, contractors }: { p: Permit; contractors: ContractorDetail[] }) {
  const c = contractors.find((x) => x.contractor?.contractor_id === p.contractor_id);
  return (
    <div className={`permit ${p.is_open ? "open" : ""}`}>
      <div className="permit-head">
        <span className="mono">{p.permit_number}</span>
        <span className={`status ${p.is_open ? "open" : ""}`}>{p.status ?? "n/a"}</span>
        {p.is_open && (
          <span className={(p.open_days ?? 0) >= 365 ? "long-open" : ""}>
            open {formatOpenDuration(p.open_days)}
          </span>
        )}
        {p.expired_without_final && <span className="tag warn">expired without final inspection</span>}
        <AddLeadButton propId={p.prop_id} permitNumber={p.permit_number} source="permit" />
      </div>
      <div className="small">{p.description ?? "(no description)"}</div>
      <div className="small muted">
        {p.permit_class} · {p.work_class} · applied {fmtDate(p.applied_date)} · issued{" "}
        {fmtDate(p.issued_date)} · status {fmtDate(p.status_date)}
        {p.completed_date && ` · completed ${fmtDate(p.completed_date)}`} · valuation{" "}
        {fmtMoney(p.total_job_valuation)}
      </div>
      <div className="small">
        Contractor:{" "}
        <strong>
          {p.contractor_name ?? p.contractor_company_name ?? p.contractor_full_name ?? "not listed"}
        </strong>
        {p.contractor_phone && ` · ${p.contractor_phone}`}{" "}
        <BbbBadge bbb={c?.bbb} permitRating={p.contractor_bbb_rating} />
      </div>
      <div className="small muted">
        Source:{" "}
        {p.permit_link ? (
          <a href={p.permit_link} target="_blank" rel="noreferrer">
            permit record
          </a>
        ) : (
          "n/a"
        )}
        {p.source_url && (
          <>
            {" · "}
            <a href={p.source_url} target="_blank" rel="noreferrer">
              dataset row
            </a>
          </>
        )}{" "}
        · collected {fmtDate(p.collected_at)} · run {p.last_changed_run ?? "n/a"}
      </div>
    </div>
  );
}

function PropertyDetailView({ propId }: { propId: string }) {
  const q = trpc.properties.get.useQuery({ propId });
  if (q.isLoading) return <p>Loading...</p>;
  if (q.error) return <p className="error">{q.error.message}</p>;
  if (!q.data) return null;
  const { property: p, permits, contractors, provenance, signals } = q.data;
  return (
    <>
      <h2>{p.situs_address ?? "(no situs address)"}</h2>
      <p className="muted">
        {joinAddr(p.situs_city, p.situs_zip)} · prop {p.prop_id} · geo {p.geo_id ?? "n/a"}
      </p>
      <div className="row">
        <span className={`pri pri-${signals.priority === "medium" ? "med" : signals.priority}`}>
          {signals.priority} priority
        </span>
        <AddLeadButton
          propId={p.prop_id}
          permitNumber={p.oldest_open_roofing_permit_number ?? undefined}
          source="map"
        />
      </div>
      {signals.reasons.length > 0 && (
        <ul className="reasons">
          {signals.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}

      <h3>Roof</h3>
      <dl className="kv">
        <dt>Roof age</dt>
        <dd>
          {p.roof_age_years ?? "unknown"} yrs (roof year {p.roof_year ?? "n/a"}, confidence{" "}
          {p.roof_age_confidence ?? "n/a"})
        </dd>
        <dt>Basis</dt>
        <dd>{basisLabel(p.roof_age_basis)}</dd>
        <dt>Evidence</dt>
        <dd>
          {p.roof_evidence_permit_number ? (
            <span className="mono">{p.roof_evidence_permit_number}</span>
          ) : (
            "none"
          )}
          {p.roof_evidence_date && ` (${fmtDate(p.roof_evidence_date)})`} · year built {p.year_built ?? "n/a"}
        </dd>
      </dl>

      <h3>Owner</h3>
      <dl className="kv">
        <dt>Owner</dt>
        <dd>
          {p.owner_name ?? "n/a"}
          {p.owner_care_of && <span className="muted"> c/o {p.owner_care_of}</span>}
        </dd>
        <dt>Mailing</dt>
        <dd>{joinAddr(p.mail_address, p.mail_city, p.mail_state, p.mail_zip) || "n/a"}</dd>
        <dt>Owner location</dt>
        <dd>
          {p.owner_location_class ?? "n/a"}
          {p.absentee_owner_signal && <span className="tag">absentee signal</span>}
        </dd>
        <dt>Value</dt>
        <dd>
          market {fmtMoney(p.market_value)} · land use {p.land_use_state_code ?? "n/a"} · tax year{" "}
          {p.tax_year ?? "n/a"}
        </dd>
        <dt>Last deed</dt>
        <dd>
          {p.last_deed_date ? (
            fmtDate(p.last_deed_date)
          ) : (
            <span className="muted">
              not available{p.ownership_tenure_basis ? ` (${p.ownership_tenure_basis})` : ""}
            </span>
          )}
        </dd>
      </dl>

      <h3>Roofing permits ({permits.length})</h3>
      {permits.length === 0 && <p className="muted">No roofing permits linked to this parcel.</p>}
      {permits.map((pm) => (
        <PermitRow key={pm.permit_number} p={pm} contractors={contractors} />
      ))}

      {contractors.some((c) => c.contractor) && <h3>Contractors</h3>}
      {contractors.map((c) =>
        c.contractor ? <ContractorCard key={c.contractor.contractor_id} c={c} /> : null,
      )}

      <h3>Provenance</h3>
      <dl className="kv small">
        <dt>Snapshot run</dt>
        <dd className="mono">
          {provenance.runId ?? "n/a"} (as of {provenance.asOfDate ?? "n/a"})
        </dd>
        <dt>Parcel source</dt>
        <dd>
          {provenance.sourceUrl ? (
            <a href={provenance.sourceUrl} target="_blank" rel="noreferrer">
              {provenance.sourceId ?? "source"}
            </a>
          ) : (
            "n/a"
          )}{" "}
          · collected {fmtDate(provenance.collectedAt)}
        </dd>
        <dt>Raw sha256</dt>
        <dd className="mono">{provenance.rawSha256?.slice(0, 16) ?? "n/a"}</dd>
      </dl>
    </>
  );
}

function PermitDetailView({
  permitNumber,
  onSelect,
}: {
  permitNumber: string;
  onSelect: (s: Selection) => void;
}) {
  const q = trpc.permits.get.useQuery({ permitNumber });
  if (q.isLoading) return <p>Loading...</p>;
  if (q.error) return <p className="error">{q.error.message}</p>;
  if (!q.data) return null;
  const { permit, contractor } = q.data;
  return (
    <>
      <h2 className="mono">{permit.permit_number}</h2>
      <p className="muted">{joinAddr(permit.address, permit.city, permit.zip)}</p>
      {permit.prop_id && (
        <button className="link" onClick={() => onSelect({ kind: "property", propId: permit.prop_id! })}>
          Open property {permit.prop_id}
        </button>
      )}
      <PermitRow p={permit} contractors={[contractor]} />
      {contractor.contractor ? (
        <ContractorCard c={contractor} />
      ) : (
        <p className="muted">No reconciled contractor record.</p>
      )}
    </>
  );
}

export function DetailPanel(props: {
  selection: NonNullable<Selection>;
  onClose: () => void;
  onSelect: (s: Selection) => void;
}) {
  return (
    <aside className="detail" aria-label="Detail panel">
      <button className="close" onClick={props.onClose} aria-label="Close">
        ×
      </button>
      {props.selection.kind === "property" ? (
        <PropertyDetailView propId={props.selection.propId} />
      ) : (
        <PermitDetailView permitNumber={props.selection.permitNumber} onSelect={props.onSelect} />
      )}
    </aside>
  );
}
