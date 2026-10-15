import { useState } from "react";
import { trpc } from "@roofing-crm/api-client/react";
import type { GeoPoint } from "@roofing-crm/shared";
import { fmtMiles, formatOpenDuration, joinAddr } from "../format";
import type { Filters } from "../state";
import { AddLeadButton } from "./CandidateList";

const EXAMPLES = [
  "Show me open roofing permits older than five years within five miles of Pflugerville",
  "Roofs older than 25 years within 1 mile of here",
  "Which open permits mention a tear off near Lakeway?",
  'Open roofing permits mentioning "hail" within 10 miles of Austin',
];

export function AgentView(props: {
  filters: Filters;
  onShowOnMap: (center: GeoPoint, propId?: string) => void;
}) {
  const [question, setQuestion] = useState(EXAMPLES[0]!);
  const mode = trpc.agent.mode.useQuery();
  const ask = trpc.agent.ask.useMutation();
  const a = ask.data;

  return (
    <section className="agent">
      <h2>Ask the lead agent</h2>
      <p className="muted small">
        Answers come from retrieval over the current snapshot (geocoding, radius filters, BM25 text search
        over permits)
        {mode.data?.mode === "llm"
          ? ` summarized by ${mode.data.provider}`
          : " (retrieval-only mode: no LLM configured)"}
        . Your map center ({props.filters.center.lat.toFixed(4)}, {props.filters.center.lng.toFixed(4)}) and
        radius ({props.filters.radiusMiles} mi) are passed as context.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask.mutate({ question, center: props.filters.center, radiusMiles: props.filters.radiusMiles });
        }}
      >
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          rows={3}
          aria-label="Question"
        />
        <div className="row wrap">
          <button type="submit" className="primary" disabled={ask.isPending || question.trim().length < 3}>
            {ask.isPending ? "Thinking..." : "Ask"}
          </button>
          {EXAMPLES.map((ex) => (
            <button type="button" key={ex} className="chip" onClick={() => setQuestion(ex)}>
              {ex}
            </button>
          ))}
        </div>
      </form>
      {ask.error && <p className="error">{ask.error.message}</p>}
      {a && (
        <div className="answer">
          <pre className="answer-text">{a.answer}</pre>
          <div className="answer-meta">
            {a.assumptions.length > 0 && (
              <div>
                <h4>Assumptions</h4>
                <ul>
                  {a.assumptions.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
            {a.missingData.length > 0 && (
              <div>
                <h4>Missing data</h4>
                <ul>
                  {a.missingData.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <h4>Citations</h4>
              <div className="row wrap">
                {a.citations.map((c) =>
                  c.url ? (
                    <a
                      key={`${c.kind}-${c.id}`}
                      className="chip"
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {c.kind} {c.id}
                    </a>
                  ) : (
                    <span key={`${c.kind}-${c.id}`} className="chip">
                      {c.kind} {c.id}
                    </span>
                  ),
                )}
              </div>
              <p className="muted small">
                Model: {a.model} · tools: {a.toolCalls.map((t) => t.tool).join(" → ") || "none"}
              </p>
            </div>
          </div>

          {a.permits.length > 0 && (
            <>
              <h4>Retrieved permits ({a.permits.length})</h4>
              <table>
                <thead>
                  <tr>
                    <th>Permit</th>
                    <th>Status</th>
                    <th>Open for</th>
                    <th>Address</th>
                    <th>Contractor</th>
                    <th>Distance</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {a.permits.map((p) => (
                    <tr key={p.permit_number}>
                      <td className="mono small">{p.permit_number}</td>
                      <td>{p.status}</td>
                      <td className={(p.open_days ?? 0) >= 365 ? "long-open" : ""}>
                        {p.is_open ? formatOpenDuration(p.open_days) : "-"}
                      </td>
                      <td className="small">{p.address}</td>
                      <td className="small">{p.contractor_name ?? p.contractor_company_name ?? "n/a"}</td>
                      <td>{fmtMiles(p.distance_miles)}</td>
                      <td>
                        {p.latitude !== null && p.longitude !== null && (
                          <button
                            className="chip"
                            onClick={() =>
                              props.onShowOnMap(
                                { lat: p.latitude!, lng: p.longitude! },
                                p.prop_id ?? undefined,
                              )
                            }
                          >
                            Map
                          </button>
                        )}{" "}
                        <AddLeadButton propId={p.prop_id} permitNumber={p.permit_number} source="agent" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {a.properties.length > 0 && (
            <>
              <h4>Retrieved properties ({a.properties.length})</h4>
              <table>
                <thead>
                  <tr>
                    <th>Property</th>
                    <th>Roof age</th>
                    <th>Open permits</th>
                    <th>Distance</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {a.properties.map((p) => (
                    <tr key={p.prop_id}>
                      <td>
                        {p.situs_address}
                        <div className="muted small">
                          {joinAddr(p.situs_city, p.situs_zip)} · prop {p.prop_id}
                        </div>
                      </td>
                      <td>{p.roof_age_years ?? "?"} yrs</td>
                      <td>
                        {p.open_roofing_permit_count}{" "}
                        {p.oldest_open_roofing_permit_days
                          ? `(${formatOpenDuration(p.oldest_open_roofing_permit_days)})`
                          : ""}
                      </td>
                      <td>{fmtMiles(p.distance_miles)}</td>
                      <td>
                        <button
                          className="chip"
                          onClick={() => props.onShowOnMap({ lat: p.latitude, lng: p.longitude }, p.prop_id)}
                        >
                          Map
                        </button>{" "}
                        <AddLeadButton propId={p.prop_id} source="agent" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </section>
  );
}
