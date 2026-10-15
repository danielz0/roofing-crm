import { Fragment, useState } from "react";
import { LEAD_STATUS_LABELS, LEAD_STATUSES, type LeadStatus } from "@roofing-crm/shared";
import { trpc } from "@roofing-crm/api-client/react";
import { basisLabel, fmtDate, formatOpenDuration, joinAddr } from "../format";

export function LeadsView({ onOpen }: { onOpen: (propId: string) => void }) {
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const utils = trpc.useUtils();
  const leads = trpc.leads.list.useQuery(status ? { status } : {});
  const invalidate = () => utils.leads.list.invalidate();
  const updateStatus = trpc.leads.updateStatus.useMutation({ onSuccess: invalidate });
  const addNote = trpc.leads.addNote.useMutation({
    onSuccess: () => {
      setNote("");
      return invalidate();
    },
  });
  const remove = trpc.leads.delete.useMutation({ onSuccess: invalidate });

  return (
    <section className="leads">
      <div className="leads-head">
        <h2>CRM leads</h2>
        <label>
          Status{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | "")}>
            <option value="">All</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LEAD_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <button disabled title="Outbound messaging is out of scope (coming soon)">
          🔒 Send outreach
        </button>
      </div>
      {leads.error && <p className="error">{leads.error.message}</p>}
      {leads.data && leads.data.length === 0 && (
        <p className="muted">
          No leads yet. Use “+ Lead” on the map, the candidate list, a permit, or an agent answer.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Priority</th>
            <th>Property</th>
            <th>Signals</th>
            <th>Owner / mailing</th>
            <th>Status</th>
            <th>Updated</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(leads.data ?? []).map((l) => (
            <Fragment key={l.id}>
              <tr
                onClick={() => setExpanded(expanded === l.id ? null : l.id)}
                className={expanded === l.id ? "selected" : ""}
              >
                <td>
                  <span className={`pri pri-${l.priority === "medium" ? "med" : l.priority}`}>
                    {l.priority}
                  </span>
                </td>
                <td>
                  <div>{l.facts.address ?? "(no address)"}</div>
                  <div className="muted small">
                    {joinAddr(l.facts.city, l.facts.zip)} · prop {l.propId}
                  </div>
                </td>
                <td className="small">
                  Roof {l.facts.roofAgeYears ?? "?"} yrs{" "}
                  <span className="muted">({basisLabel(l.facts.roofAgeBasis)})</span>
                  <br />
                  {l.facts.openRoofingPermitCount > 0
                    ? `${l.facts.openRoofingPermitCount} open permit(s), oldest ${formatOpenDuration(l.facts.oldestOpenPermitDays)}`
                    : "no open permits"}
                  {l.permitNumbers.length > 0 && <div className="mono">{l.permitNumbers.join(", ")}</div>}
                </td>
                <td className="small">
                  {l.facts.ownerName ?? "n/a"}
                  <div className="muted">{l.facts.mailingAddress ?? ""}</div>
                </td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select
                    aria-label={`Status for ${l.facts.address ?? l.propId}`}
                    value={l.status}
                    onChange={(e) => updateStatus.mutate({ id: l.id, status: e.target.value as LeadStatus })}
                  >
                    {LEAD_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {LEAD_STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="small">{fmtDate(l.updatedAt)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <button className="chip" onClick={() => onOpen(l.propId)}>
                    Map
                  </button>{" "}
                  <button
                    className="chip danger"
                    onClick={() => {
                      if (confirm("Delete this lead?")) remove.mutate({ id: l.id });
                    }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
              {expanded === l.id && (
                <tr className="notes-row">
                  <td colSpan={7}>
                    <div className="notes">
                      <strong>Notes</strong>
                      {l.notes.length === 0 && <p className="muted small">No notes yet.</p>}
                      <ul>
                        {l.notes.map((n) => (
                          <li key={n.id}>
                            <span className="muted small">{fmtDate(n.createdAt)}</span> {n.text}
                          </li>
                        ))}
                      </ul>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (note.trim()) addNote.mutate({ id: l.id, text: note.trim() });
                        }}
                      >
                        <input
                          value={note}
                          onChange={(e) => setNote(e.target.value)}
                          placeholder="Add a note..."
                        />
                        <button type="submit" disabled={addNote.isPending}>
                          Add note
                        </button>
                      </form>
                      <p className="muted small">
                        Created {fmtDate(l.createdAt)} from {l.source} · snapshot {l.facts.runId ?? "n/a"}
                        {l.facts.sourceUrl && (
                          <>
                            {" · "}
                            <a href={l.facts.sourceUrl} target="_blank" rel="noreferrer">
                              parcel source
                            </a>
                          </>
                        )}
                      </p>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </section>
  );
}
