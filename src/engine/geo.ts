/**
 * The simulation runs on a flat x/y plane in kilometres (east, north), centred on central California.
 * Everything physical (sound travel, ship motion, whale motion) happens on this plane; the map only
 * converts to longitude/latitude for drawing. Over the ~900 km study area the plane differs from true
 * distances by at most ~3%, which does not affect the simulation because it is internally consistent.
 */
export const LAT0 = 35.6;
export const LON0 = -121.5;
const KY = 110.574; // km per degree latitude
const KX = 111.32 * Math.cos((LAT0 * Math.PI) / 180); // km per degree longitude at LAT0

export type XY = [number, number];
export type LonLat = [number, number];

export function toXY(lon: number, lat: number): XY {
  return [(lon - LON0) * KX, (lat - LAT0) * KY];
}

export function toLL(x: number, y: number): LonLat {
  return [LON0 + x / KX, LAT0 + y / KY];
}

export const dist = (a: XY, b: XY): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const KNOT_KMS = 1.852 / 3600; // 1 knot in km per second
export const NM_KM = 1.852;

/** Heading in degrees (0 = north, clockwise) of a direction vector. */
export function headingDeg(dx: number, dy: number): number {
  return ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
}
