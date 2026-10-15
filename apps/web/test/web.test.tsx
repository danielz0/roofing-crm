import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FUTURE_SECTIONS } from "@roofing-crm/shared";
import { FutureNav } from "../src/components/FutureNav";
import { resolveApiUrl } from "../src/runtimeConfig";

vi.mock("maplibre-gl", () => ({ default: {} }));

describe("future CRM sections", () => {
  it("renders every roadmap section visibly disabled", () => {
    render(<FutureNav />);
    for (const s of FUTURE_SECTIONS) {
      const btn = screen.getByTestId(`future-${s.id}`);
      expect(btn).toBeDisabled();
      expect(btn.textContent).toContain(s.label);
    }
  });
});

describe("map categories", () => {
  it("long-open permits outrank aged roofs", async () => {
    const { categoryOf } = await import("../src/components/MapView");
    const base = {
      open_roofing_permit_count: 1,
      oldest_open_roofing_permit_days: 800,
      signals: { openPermit: true, agedRoof: true },
    } as unknown as Parameters<typeof categoryOf>[0];
    expect(categoryOf(base, 365)).toBe("long_open");
    expect(categoryOf({ ...base, oldest_open_roofing_permit_days: 100 }, 365)).toBe("open");
    expect(
      categoryOf(
        {
          ...base,
          open_roofing_permit_count: 0,
          signals: { openPermit: false, agedRoof: true },
        } as typeof base,
        365,
      ),
    ).toBe("aged");
  });
});

describe("runtime config", () => {
  it("uses /config.json apiUrl when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ apiUrl: "https://api.example.test" }))),
    );
    expect(await resolveApiUrl()).toBe("https://api.example.test");
  });

  it("falls back to localhost", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}")),
    );
    expect(await resolveApiUrl()).toBe("http://localhost:4000");
  });
});
