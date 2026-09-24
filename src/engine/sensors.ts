/**
 * The sensor network: low-cost hydrophone buoys laid out on a hexagonal grid along the shipping corridor.
 * "Network" mode = thousands of sensors a few km apart (can locate whales).
 * "Single buoy" mode = one buoy per hotspot (today's approach: detects whales, cannot locate them).
 */
import type { Route } from "./route";
import { toLL, toXY, type XY, type LonLat } from "./geo";
import type { DepthModel } from "./bathy";
import type { Rng } from "./rng";

export interface Sensor {
  id: number;
  pos: XY;
  ll: LonLat;
  phase: number; // for the blinking animation
}

/** Spatial hash for fast "which sensors are within R km" queries. */
export class SensorIndex {
  private cells = new Map<string, Sensor[]>();
  constructor(readonly sensors: Sensor[], private cell = 20) {
    for (const s of sensors) {
      const k = this.key(s.pos[0], s.pos[1]);
      const arr = this.cells.get(k);
      if (arr) arr.push(s);
      else this.cells.set(k, [s]);
    }
  }
  private key(x: number, y: number) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }
  within(p: XY, r: number): Sensor[] {
    const out: Sensor[] = [];
    const c0x = Math.floor((p[0] - r) / this.cell);
    const c1x = Math.floor((p[0] + r) / this.cell);
    const c0y = Math.floor((p[1] - r) / this.cell);
    const c1y = Math.floor((p[1] + r) / this.cell);
    for (let i = c0x; i <= c1x; i++)
      for (let j = c0y; j <= c1y; j++) {
        const arr = this.cells.get(`${i},${j}`);
        if (!arr) continue;
        for (const s of arr) if (Math.hypot(s.pos[0] - p[0], s.pos[1] - p[1]) <= r) out.push(s);
      }
    return out;
  }
}

/** Hex-grid sensors within `corridorKm` of the route, in water deeper than 30 m, about `target` in total. */
export function networkSensors(route: Route, depth: DepthModel, target: number, corridorKm: number, rng: Rng): Sensor[] {
  // area of the corridor (approx.) -> hex spacing that gives ~target sensors
  const area = route.length * 2 * corridorKm;
  let spacing = Math.sqrt((2 * area) / (Math.sqrt(3) * target));
  let result: Sensor[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    result = [];
    const xs = route.pts.map((p) => p[0]);
    const ys = route.pts.map((p) => p[1]);
    const x0 = Math.min(...xs) - corridorKm;
    const x1 = Math.max(...xs) + corridorKm;
    const y0 = Math.min(...ys) - corridorKm;
    const y1 = Math.max(...ys) + corridorKm;
    const dy = (spacing * Math.sqrt(3)) / 2;
    let row = 0;
    for (let y = y0; y <= y1; y += dy, row++) {
      for (let x = x0 + (row % 2 ? spacing / 2 : 0); x <= x1; x += spacing) {
        // small placement jitter so the field looks deployed, not printed
        const px = x + rng.gauss(0, spacing * 0.08);
        const py = y + rng.gauss(0, spacing * 0.08);
        if (route.project([px, py]).dist > corridorKm) continue;
        const ll = toLL(px, py);
        if (depth.elevation(ll[0], ll[1]) > -30) continue;
        result.push({ id: result.length, pos: [px, py], ll, phase: rng.next() * Math.PI * 2 });
      }
    }
    const ratio = result.length / target;
    if (ratio > 0.9 && ratio < 1.1) break;
    spacing *= Math.sqrt(ratio);
  }
  return result;
}

/** Today's approach: one listening buoy per hotspot (like Whale Safe's single buoys). */
export function singleBuoys(points: LonLat[]): Sensor[] {
  return points.map((ll, i) => ({ id: i, pos: toXY(ll[0], ll[1]), ll, phase: 0 }));
}

export function spacingKm(sensors: Sensor[]): number {
  if (sensors.length < 2) return Infinity;
  const idx = new SensorIndex(sensors, 10);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < sensors.length; i += Math.max(1, Math.floor(sensors.length / 200))) {
    const s = sensors[i];
    let best = Infinity;
    for (const o of idx.within(s.pos, 40)) if (o !== s) best = Math.min(best, Math.hypot(o.pos[0] - s.pos[0], o.pos[1] - s.pos[1]));
    if (isFinite(best)) {
      sum += best;
      n++;
    }
  }
  return n ? sum / n : Infinity;
}
