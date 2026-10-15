import { FUTURE_SECTIONS } from "@roofing-crm/shared";

/** Roadmap sections, intentionally visible but disabled. */
export function FutureNav() {
  return (
    <div className="future" aria-label="Coming soon">
      {FUTURE_SECTIONS.map((s) => (
        <button
          key={s.id}
          disabled
          aria-disabled="true"
          title={`${s.description} (coming soon)`}
          data-testid={`future-${s.id}`}
        >
          <span aria-hidden>🔒</span> {s.label}
        </button>
      ))}
    </div>
  );
}
