/**
 * Real ship traffic (AIS, NOAA/BOEM MarineCadastre) replayed as a moving sensor network.
 *
 * Every large ship carries (a) a towed hydrophone ~500 m astern and (b) a thermal-infrared whale camera.
 * Its own engine/propeller noise raises the noise at its hydrophone, so a ship hears whales at a
 * shorter range than a quiet seafloor station - worst for humpbacks, whose song band is quiet.
 */
import { toXY, headingDeg, type XY } from "./geo";
import { shipSourceLevel, shipBandOffset, type Species } from "./physics";

export type ShipClass = "cargo" | "tanker" | "passenger";

export interface TrafficFile {
  source: string;
  t0Utc: string;
  stepS: number;
  steps: number;
  synthetic?: boolean;
  ships: { id: number; n: string; c: ShipClass; L: number; seg: { s: number; lo: number[]; la: number[]; v: number[] }[] }[];
}

export interface TrafficShip {
  idx: number;
  name: string;
  cls: ShipClass;
  lengthM: number;
  x: Float32Array; // km, NaN = not present
  y: Float32Array;
  v: Float32Array; // knots
}

export interface ShipState {
  idx: number;
  pos: XY;
  v: number;
  heading: number;
}

// ---- ship-borne sensor assumptions (all shown in the app's Method tab) ----
/** Towed hydrophone distance behind the ship (m). Towed arrays are typically a few hundred m astern. */
export const ARRAY_DISTANCE_M = 500;
/** Noise rejection from beamforming away from the towing ship's own propeller (dB). Assumption. */
export const ARRAY_GAIN_DB = 15;
/** Thermal-camera whale detection range (km): up to ~6.5 km in trials on Matson ships (WHOI 2024). */
export const CAMERA_RANGE_KM = 6.5;

/** Own-ship noise at its towed hydrophone, in a species' call band (dB re 1 µPa). */
export function selfNoiseDb(sp: Species, speedKn: number): number {
  return shipSourceLevel(speedKn) + shipBandOffset(sp) - 20 * Math.log10(ARRAY_DISTANCE_M) - ARRAY_GAIN_DB;
}

/** Probability the thermal camera spots a surfacing whale at distance d km. */
export function cameraDetectionProb(dKm: number): number {
  if (dKm > CAMERA_RANGE_KM) return 0;
  return 0.9 - 0.6 * (dKm / CAMERA_RANGE_KM);
}

export class Traffic {
  readonly ships: TrafficShip[];
  readonly stepS: number;
  readonly steps: number;
  constructor(readonly file: TrafficFile) {
    this.stepS = file.stepS;
    this.steps = file.steps;
    this.ships = file.ships.map((s, idx) => {
      const x = new Float32Array(file.steps).fill(NaN);
      const y = new Float32Array(file.steps).fill(NaN);
      const v = new Float32Array(file.steps).fill(NaN);
      for (const seg of s.seg) {
        let lo = 0;
        let la = 0;
        for (let k = 0; k < seg.lo.length; k++) {
          lo += seg.lo[k];
          la += seg.la[k];
          const [px, py] = toXY(lo / 1e4, la / 1e4);
          x[seg.s + k] = px;
          y[seg.s + k] = py;
          v[seg.s + k] = seg.v[k];
        }
      }
      // AIS glitches (duplicate MMSIs, bad GPS) make positions jump back and forth: drop any step implying
      // more than ~40 knots from the previous one
      const maxJump = (40 * 1.852 * file.stepS) / 3600;
      let px = NaN, py = NaN, rejected = 0;
      for (let k = 0; k < file.steps; k++) {
        if (Number.isNaN(x[k])) { px = NaN; continue; }
        const far = !Number.isNaN(px) && Math.hypot(x[k] - px, y[k] - py) > maxJump * (1 + rejected);
        if (far && rejected < 3) { x[k] = NaN; y[k] = NaN; v[k] = NaN; rejected++; continue; }
        px = x[k]; py = y[k]; rejected = 0; // (after 3 rejections, trust the new position: the anchor was the glitch)
      }
      return { idx, name: s.n, cls: s.c, lengthM: s.L, x, y, v };
    });
  }

  /** Positions of all ships present at time t (s since voyage start), linearly interpolated. */
  at(t: number): ShipState[] {
    const f = t / this.stepS;
    const k = Math.floor(f);
    if (k < 0 || k + 1 >= this.steps) return [];
    const a = f - k;
    const out: ShipState[] = [];
    for (const s of this.ships) {
      const x0 = s.x[k], x1 = s.x[k + 1];
      if (Number.isNaN(x0) || Number.isNaN(x1)) continue;
      const y0 = s.y[k], y1 = s.y[k + 1];
      const dx = x1 - x0, dy = y1 - y0;
      out.push({
        idx: s.idx,
        pos: [x0 + dx * a, y0 + dy * a],
        v: s.v[k] + (s.v[k + 1] - s.v[k]) * a,
        heading: Math.hypot(dx, dy) > 0.01 ? headingDeg(dx, dy) : NaN,
      });
    }
    return out;
  }

  /** Number of distinct ships present at any time in [t0, t1]. */
  countPresent(t0: number, t1: number): number {
    const k0 = Math.max(0, Math.floor(t0 / this.stepS));
    const k1 = Math.min(this.steps - 1, Math.ceil(t1 / this.stepS));
    let n = 0;
    for (const s of this.ships) {
      for (let k = k0; k <= k1; k++) if (!Number.isNaN(s.x[k])) { n++; break; }
    }
    return n;
  }
}
