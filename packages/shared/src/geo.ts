export type GeoPoint = { lat: number; lng: number };
export type BoundingBox = { minLat: number; maxLat: number; minLng: number; maxLng: number };

export const EARTH_RADIUS_MILES = 3958.7613;
const MILES_PER_DEGREE_LAT = 69.0;

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in miles (haversine). Mirrors the SQL used by the API. */
export function haversineMiles(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Conservative bounding box around a center for a radius in miles. Used as a cheap prefilter
 * before the exact haversine predicate; it always contains the full circle.
 */
export function boundingBox(center: GeoPoint, radiusMiles: number): BoundingBox {
  const dLat = radiusMiles / MILES_PER_DEGREE_LAT;
  const cosLat = Math.max(Math.cos(toRad(center.lat)), 1e-6);
  const dLng = radiusMiles / (MILES_PER_DEGREE_LAT * cosLat);
  return {
    minLat: center.lat - dLat,
    maxLat: center.lat + dLat,
    minLng: center.lng - dLng,
    maxLng: center.lng + dLng,
  };
}

/** Polygon ring approximating a circle, as [lng, lat] pairs (GeoJSON order), closed. */
export function circleRing(center: GeoPoint, radiusMiles: number, steps = 64): [number, number][] {
  const ring: [number, number][] = [];
  const angular = radiusMiles / EARTH_RADIUS_MILES;
  const lat1 = toRad(center.lat);
  const lng1 = toRad(center.lng);
  for (let i = 0; i <= steps; i++) {
    const bearing = (2 * Math.PI * i) / steps;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
    );
    const lng2 =
      lng1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
        Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
      );
    ring.push([(lng2 * 180) / Math.PI, (lat2 * 180) / Math.PI]);
  }
  return ring;
}
