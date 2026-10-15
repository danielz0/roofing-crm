import { formatOpenDuration, ROOF_AGE_BASIS_LABELS } from "@roofing-crm/shared";

export { formatOpenDuration };

export const fmtMiles = (m: number | null | undefined) =>
  m === null || m === undefined ? "" : `${m.toFixed(m < 10 ? 2 : 1)} mi`;
export const fmtMoney = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "n/a"
    : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
export const fmtDate = (v: string | null | undefined) => (v ? v.slice(0, 10) : "n/a");
export const basisLabel = (b: string | null | undefined) => (b ? (ROOF_AGE_BASIS_LABELS[b] ?? b) : "n/a");
export const joinAddr = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(", ");
