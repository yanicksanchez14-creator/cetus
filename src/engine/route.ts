/**
 * Ship routes and the ship's position along them.
 *
 * A "plan" modifies the base route with (a) speed zones and (b) an optional smooth sideways offset
 * (a small course change that rejoins the lane). Everything is expressed along-route distance s (km).
 */
import { toXY, type XY, type LonLat, KNOT_KMS, headingDeg } from "./geo";

export interface RouteDef {
  id: string;
  name: string;
  from: string;
  to: string;
  waypoints: LonLat[];
}

// Approximate real traffic lanes (charts: San Francisco TSS southern approach, coastal route offshore of
// Monterey Bay and Big Sur, Santa Barbara Channel TSS, Los Angeles/Long Beach approach). Every segment is
// checked against the GMRT depth data in the tests (min depth 40 m).
export const ROUTES: RouteDef[] = [
  {
    id: "oak-lb",
    name: "Oakland → Long Beach",
    from: "Port of Oakland",
    to: "Port of Long Beach",
    waypoints: [
      [-122.332, 37.801], [-122.350, 37.802], [-122.380, 37.803], [-122.395, 37.815], [-122.44, 37.818], [-122.478, 37.812],
      [-122.53, 37.797], [-122.62, 37.76],
      [-122.70, 37.66], [-122.66, 37.45], [-122.56, 37.20], [-122.42, 36.95], [-122.36, 36.72],
      [-122.20, 36.40], [-121.98, 36.10], [-121.68, 35.75], [-121.30, 35.35], [-120.95, 34.95],
      [-120.80, 34.60], [-120.55, 34.35], [-120.10, 34.28], [-119.55, 34.15], [-119.10, 33.98],
      [-118.60, 33.80], [-118.33, 33.68], [-118.215, 33.72], [-118.205, 33.745],
    ],
  },
  {
    id: "oak-asia",
    name: "Oakland → Asia (westbound)",
    from: "Port of Oakland",
    to: "Trans-Pacific (to Asia)",
    waypoints: [
      [-122.332, 37.801], [-122.350, 37.802], [-122.380, 37.803], [-122.395, 37.815], [-122.44, 37.818], [-122.478, 37.812],
      [-122.53, 37.797], [-122.62, 37.76],
      [-122.78, 37.72], [-123.05, 37.62], [-123.45, 37.50], [-124.0, 37.34], [-124.8, 37.12], [-126.4, 36.72],
    ],
  },
];

export interface SpeedZone {
  s0: number;
  s1: number;
  v: number; // knots
}
export interface Offset {
  s0: number; // start of the turn away from the lane
  s1: number; // end of the gradual return to the lane
  d: number; // km, + = to the right of the direction of travel
  ramp: number; // km over which the ship eases out (turn away)
  rampBack?: number; // km over which it eases back (defaults to ramp); longer = gentler rejoin
  /** Sideways offset at s0 (non-zero when a new plan starts mid-manoeuvre, from where the ship actually is). */
  d0?: number;
}

/** Along-track distance needed to shift d km sideways with a heading change of at most maxDeg degrees.
 *  The smoothstep profile's steepest slope is 1.5·d/ramp, so ramp = 1.5·d / tan(maxDeg). */
export function rampForAngle(d: number, maxDeg: number): number {
  return (1.5 * Math.abs(d)) / Math.tan((maxDeg * Math.PI) / 180);
}
export interface Plan {
  baseSpeed: number; // knots
  zones: SpeedZone[];
  offset: Offset | null;
}

export class Route {
  readonly def: RouteDef;
  readonly pts: XY[];
  readonly cum: number[]; // cumulative distance at each waypoint, km
  readonly length: number;

  constructor(def: RouteDef) {
    this.def = def;
    this.pts = def.waypoints.map(([lon, lat]) => toXY(lon, lat));
    this.cum = [0];
    for (let i = 1; i < this.pts.length; i++) {
      const [a, b] = [this.pts[i - 1], this.pts[i]];
      this.cum.push(this.cum[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    this.length = this.cum[this.cum.length - 1];
  }

  private seg(s: number): number {
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Point on the base route and unit direction at distance s. */
  at(s: number): { p: XY; dir: XY } {
    const sc = Math.min(Math.max(s, 0), this.length);
    const i = this.seg(sc);
    const a = this.pts[i];
    const b = this.pts[i + 1] ?? a;
    const L = this.cum[i + 1] - this.cum[i] || 1;
    const f = (sc - this.cum[i]) / L;
    const dir: XY = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    // smooth the heading near waypoints so the ship doesn't snap
    return { p: [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])], dir };
  }

  /** Closest along-route distance s and signed lateral distance (km, + = right of travel) of a point. */
  project(q: XY): { s: number; lateral: number; dist: number } {
    let best = { s: 0, lateral: 0, dist: Infinity };
    for (let i = 0; i < this.pts.length - 1; i++) {
      const a = this.pts[i];
      const b = this.pts[i + 1];
      const L = this.cum[i + 1] - this.cum[i];
      const ux = (b[0] - a[0]) / L;
      const uy = (b[1] - a[1]) / L;
      const t = Math.min(Math.max((q[0] - a[0]) * ux + (q[1] - a[1]) * uy, 0), L);
      const px = a[0] + ux * t;
      const py = a[1] + uy * t;
      const d = Math.hypot(q[0] - px, q[1] - py);
      if (d < best.dist) {
        // right-hand normal of (ux, uy) is (uy, -ux)
        const lat = (q[0] - px) * uy + (q[1] - py) * -ux;
        best = { s: this.cum[i] + t, lateral: lat, dist: d };
      }
    }
    return best;
  }
}

const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export function offsetAt(plan: Plan, s: number): number {
  const o = plan.offset;
  if (!o || s >= o.s1) return 0;
  const d0 = o.d0 ?? 0;
  if (s <= o.s0) return d0;
  const out = s < o.s0 + o.ramp ? d0 + (o.d - d0) * smooth((s - o.s0) / o.ramp) : o.d;
  const back = o.rampBack ?? o.ramp;
  return s > o.s1 - back ? out * smooth((o.s1 - s) / back) : out;
}

/** Last along-route distance where the plan's sideways offset is non-zero. */
export function offsetEnd(plan: Plan): number {
  return plan.offset ? plan.offset.s1 : 0;
}

export function speedAt(plan: Plan, s: number): number {
  let v = plan.baseSpeed;
  for (const z of plan.zones) if (s >= z.s0 && s <= z.s1) v = Math.min(v, z.v);
  return v;
}

/** Ship position (with any offset) at along-route distance s. */
export function shipPos(route: Route, plan: Plan, s: number): XY {
  const { p } = route.at(s);
  const off = offsetAt(plan, s);
  if (Math.abs(off) < 1e-9) return p;
  // Offset along a smoothed normal: at a bend in the lane the sideways direction turns gradually,
  // so an offset track rounds the corner instead of kinking.
  const n = smoothDir(route, s, Math.min(8, 1.5 * Math.abs(off) + 2));
  return [p[0] + n[1] * off, p[1] - n[0] * off];
}

function smoothDir(route: Route, s: number, half: number): XY {
  const a = route.at(Math.max(0, s - half)).p;
  const b = route.at(Math.min(route.length, s + half)).p;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  return [dx / L, dy / L];
}

export function shipHeading(route: Route, plan: Plan, s: number): number {
  const a = shipPos(route, plan, s - 0.3);
  const b = shipPos(route, plan, s + 0.3);
  return headingDeg(b[0] - a[0], b[1] - a[1]);
}

export interface TrajPoint {
  t: number;
  s: number;
  x: number;
  y: number;
  v: number;
}

/**
 * Integrate the ship forward from (s, t) under a plan, on a fixed time step, until s reaches sEnd.
 * The path is longer when offset, so progress along s is slowed by the path's stretch factor.
 */
export function integrate(route: Route, plan: Plan, s0: number, t0: number, sEnd: number, dt: number): TrajPoint[] {
  const out: TrajPoint[] = [];
  let s = s0;
  let t = t0;
  let guard = 0;
  while (guard++ < 200000) {
    const [x, y] = shipPos(route, plan, s);
    const v = speedAt(plan, s);
    out.push({ t, s, x, y, v });
    if (s >= sEnd) break;
    const ds0 = 0.2;
    const d1 = offsetAt(plan, s + ds0) - offsetAt(plan, s);
    const stretch = Math.sqrt(1 + (d1 / ds0) ** 2);
    const step = (v * KNOT_KMS * dt) / stretch;
    s = Math.min(s + step, sEnd);
    t += dt;
  }
  return out;
}
