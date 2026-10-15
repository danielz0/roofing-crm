import type { Feature, FeatureCollection } from "geojson";
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { circleRing, type GeoPoint } from "@roofing-crm/shared";
import type { RouterOutputs } from "@roofing-crm/api-client/react";

type PropertyItem = RouterOutputs["properties"]["search"]["items"][number];

/** Free, key-less vector basemap (OpenFreeMap, OSM data). */
const BASEMAP_STYLE =
  import.meta.env.VITE_BASEMAP_STYLE_URL || "https://tiles.openfreemap.org/styles/liberty";

export function categoryOf(p: PropertyItem, longOpenDays: number): "long_open" | "open" | "aged" | "other" {
  if (p.open_roofing_permit_count > 0 && (p.oldest_open_roofing_permit_days ?? 0) >= longOpenDays)
    return "long_open";
  if (p.signals.openPermit) return "open";
  if (p.signals.agedRoof) return "aged";
  return "other";
}

function toFeatures(items: PropertyItem[], longOpenDays: number): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: items.map((p) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [p.longitude, p.latitude] },
      properties: { prop_id: p.prop_id, category: categoryOf(p, longOpenDays), score: p.signals.score },
    })),
  };
}

function radiusFeature(center: GeoPoint, radiusMiles: number): Feature {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [circleRing(center, radiusMiles)] },
  };
}

export function MapView(props: {
  center: GeoPoint;
  radiusMiles: number;
  bounds: [number, number, number, number];
  properties: PropertyItem[];
  longOpenDays: number;
  selectedPropId: string | null;
  onPin: (p: GeoPoint) => void;
  onSelect: (propId: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const loaded = useRef(false);
  const handlers = useRef({ onPin: props.onPin, onSelect: props.onSelect });
  handlers.current = { onPin: props.onPin, onSelect: props.onSelect };
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    if (!container.current) return;
    const map = new maplibregl.Map({
      container: container.current,
      style: BASEMAP_STYLE,
      bounds: props.bounds,
      fitBoundsOptions: { padding: 20 },
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-left");

    const marker = new maplibregl.Marker({ color: "#111827", draggable: true })
      .setLngLat([props.center.lng, props.center.lat])
      .addTo(map);
    marker.on("dragend", () => {
      const ll = marker.getLngLat();
      handlers.current.onPin({ lat: ll.lat, lng: ll.lng });
    });
    markerRef.current = marker;

    map.on("load", () => {
      loaded.current = true;
      const p = latest.current;
      map.addSource("radius", { type: "geojson", data: radiusFeature(p.center, p.radiusMiles) });
      map.addLayer({
        id: "radius-fill",
        type: "fill",
        source: "radius",
        paint: { "fill-color": "#2563eb", "fill-opacity": 0.06 },
      });
      map.addLayer({
        id: "radius-line",
        type: "line",
        source: "radius",
        paint: { "line-color": "#2563eb", "line-width": 1.5, "line-dasharray": [2, 2] },
      });
      map.addSource("props", { type: "geojson", data: toFeatures(p.properties, p.longOpenDays) });
      map.addLayer({
        id: "props",
        type: "circle",
        source: "props",
        paint: {
          "circle-radius": [
            "interpolate",
            ["linear"],
            ["zoom"],
            10,
            ["match", ["get", "category"], "long_open", 5, 3],
            16,
            ["match", ["get", "category"], "long_open", 10, 7],
          ],
          "circle-color": [
            "match",
            ["get", "category"],
            "long_open",
            "#dc2626",
            "open",
            "#f59e0b",
            "aged",
            "#2563eb",
            "#6b7280",
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1,
        },
      });
      map.addLayer({
        id: "props-selected",
        type: "circle",
        source: "props",
        filter: ["==", ["get", "prop_id"], ""],
        paint: {
          "circle-radius": 12,
          "circle-color": "rgba(0,0,0,0)",
          "circle-stroke-color": "#111827",
          "circle-stroke-width": 3,
        },
      });
      map.on("click", "props", (e) => {
        const id = e.features?.[0]?.properties?.prop_id;
        if (typeof id === "string") handlers.current.onSelect(id);
      });
      map.on("mouseenter", "props", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "props", () => (map.getCanvas().style.cursor = ""));
    });

    // Click on empty map = drop a pin (re-center the search).
    map.on("click", (e) => {
      const hit = loaded.current ? map.queryRenderedFeatures(e.point, { layers: ["props"] }) : [];
      if (hit.length === 0) handlers.current.onPin({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      loaded.current = false;
    };
    // The map is created once; later prop changes are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    markerRef.current?.setLngLat([props.center.lng, props.center.lat]);
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    (map.getSource("radius") as GeoJSONSource | undefined)?.setData(
      radiusFeature(props.center, props.radiusMiles),
    );
    const bounds = new maplibregl.LngLatBounds();
    for (const [lng, lat] of circleRing(props.center, props.radiusMiles, 16)) bounds.extend([lng, lat]);
    map.fitBounds(bounds, { padding: 40, duration: 600, maxZoom: 16 });
  }, [props.center, props.radiusMiles]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    (map.getSource("props") as GeoJSONSource | undefined)?.setData(
      toFeatures(props.properties, props.longOpenDays),
    );
  }, [props.properties, props.longOpenDays]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded.current) return;
    map.setFilter("props-selected", ["==", ["get", "prop_id"], props.selectedPropId ?? ""]);
  }, [props.selectedPropId]);

  return (
    <div className="map-wrap">
      <div ref={container} className="map" data-testid="map" />
      <div className="legend">
        <span>
          <i style={{ background: "#dc2626" }} /> Long-open permit (≥{" "}
          {Math.round((props.longOpenDays / 365) * 10) / 10} yr)
        </span>
        <span>
          <i style={{ background: "#f59e0b" }} /> Open roofing permit
        </span>
        <span>
          <i style={{ background: "#2563eb" }} /> Aged roof
        </span>
        <span className="muted">Click the map or drag the pin to move the search center</span>
      </div>
    </div>
  );
}
