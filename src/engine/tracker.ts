/**
 * Whale tracker: a constant-velocity Kalman filter per whale.
 * Each located call updates the track; between calls the uncertainty grows, which is what the
 * "probable region" on the map shows. Calls are assigned to tracks by statistical distance (gating),
 * so the tracker never uses the true identity of a whale.
 */
import type { Fix } from "./localize";
import type { SpeciesId } from "./physics";

export interface Track {
  id: number;
  // state [x, y, vx, vy] in km and km/s
  s: [number, number, number, number];
  P: number[][]; // 4x4 covariance
  t: number; // time of state, s
  lastUpdate: number;
  nFixes: number;
  sightings?: number; // thermal-camera sightings (direct observations)
  /** species, from the call type (frequency band); a track only ever takes fixes of its own species */
  species?: SpeciesId;
  history: { t: number; x: number; y: number }[];
}

// Process noise (random acceleration, km²/s³), calibrated by simulating the whale model (tests/forecast.test.ts) over
// 30-60 min forecasts. Sideways (heading wander ~0.7 rad/h): q ≈ 3.3e-11·v². Along the path (speed drift, which
// saturates): q ≈ 1.45e-10·v^0.85 (v in knots). E.g. after an hour a 2 kn whale is ~1.4 km off sideways and ~1.8 km
// along its path; a 6 kn whale ~4.0 km sideways and ~3.0 km along.
const Q_LAT = 3.3e-11;
const Q_ALONG = 1.45e-10;
const V0_VAR = (2.2 / 1000) ** 2; // initial velocity uncertainty: ~2.2 m/s (≈4 kn)
const GATE = 16; // Mahalanobis² gate for assigning a fix to a track
export const TRACK_TIMEOUT_S = 40 * 60;
/** A fix this close to a recent track of the same species re-attaches to it instead of starting a new track. */
const REATTACH_KM = 3;
/** Same-species tracks closer than this are merged (one whale seen twice). */
const MERGE_KM = 1;

const zeros = (n: number) => Array.from({ length: n }, () => new Array(n).fill(0));

function predictState(tr: Track, t: number): { s: number[]; P: number[][] } {
  const dt = Math.max(0, t - tr.t);
  const F = [
    [1, 0, dt, 0],
    [0, 1, 0, dt],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const s = [tr.s[0] + dt * tr.s[2], tr.s[1] + dt * tr.s[3], tr.s[2], tr.s[3]];
  // P' = F P Fᵀ + Q
  const FP = zeros(4);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) FP[i][j] += F[i][k] * tr.P[k][j];
  const P = zeros(4);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) P[i][j] += FP[i][k] * F[j][k];
  // Process noise, split along and across the whale's direction of travel (see Q_* below): heading wander pushes a
  // whale sideways, speed changes push it along its path. Where the heading is still unknown, use the larger of the two.
  const vx = tr.s[2], vy = tr.s[3];
  const v = Math.hypot(vx, vy);
  const kn = Math.max(v / 0.000514444, 1.5);
  const qLat = Q_LAT * kn * kn;
  const qAlong = Q_ALONG * Math.pow(kn, 0.85);
  const vStd = Math.sqrt(Math.max(tr.P[2][2] + tr.P[3][3], 0) / 2);
  let qxx: number, qxy: number, qyy: number;
  if (v > 1e-6 && vStd < 0.5 * v) {
    const ux = vx / v, uy = vy / v; // along-track unit vector; across = (-uy, ux)
    qxx = qAlong * ux * ux + qLat * uy * uy;
    qyy = qAlong * uy * uy + qLat * ux * ux;
    qxy = (qAlong - qLat) * ux * uy;
  } else {
    qxx = qyy = Math.max(qLat, qAlong);
    qxy = 0;
  }
  const dt2 = dt * dt;
  const dt3 = dt2 * dt;
  const Qc = [[qxx, qxy], [qxy, qyy]];
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) {
    P[i][j] += (Qc[i][j] * dt3) / 3; // position
    P[i][j + 2] += (Qc[i][j] * dt2) / 2; // position-velocity
    P[i + 2][j] += (Qc[i][j] * dt2) / 2;
    P[i + 2][j + 2] += Qc[i][j] * dt; // velocity
  }
  return { s, P };
}

/** Predicted position mean and 2x2 covariance [vxx, vxy, vyy] at time t. */
export function predictPosition(tr: Track, t: number): { x: number; y: number; vx: number; vy: number; cov: [number, number, number] } {
  const { s, P } = predictState(tr, t);
  return { x: s[0], y: s[1], vx: s[2], vy: s[3], cov: [P[0][0], P[0][1], P[1][1]] };
}

function mahalanobis2(tr: Track, fix: Fix, t: number): number {
  const p = predictPosition(tr, t);
  const sxx = p.cov[0] + fix.cov[0];
  const sxy = p.cov[1] + fix.cov[1];
  const syy = p.cov[2] + fix.cov[2];
  const det = sxx * syy - sxy * sxy;
  const dx = fix.x - p.x;
  const dy = fix.y - p.y;
  return (syy * dx * dx - 2 * sxy * dx * dy + sxx * dy * dy) / det;
}

export class Tracker {
  tracks: Track[] = [];
  private nextId = 1;

  /** Assign a fix to the best track, or start a new one if `allowNew`. Returns the track (null if dropped). */
  addFix(fix: Fix, t: number, allowNew = true, species?: SpeciesId): Track | null {
    let best: Track | null = null;
    let bestD = GATE;
    const same = (tr: Track) => !species || !tr.species || tr.species === species; // never mix species
    for (const tr of this.tracks) {
      if (!same(tr)) continue;
      const d = mahalanobis2(tr, fix, t);
      if (d < bestD) {
        bestD = d;
        best = tr;
      }
    }
    // Outside every gate, but a recent track of the same species is within ~3 km: it's almost certainly the same
    // whale that turned or sped up. Re-attach it (and loosen its velocity) instead of starting a duplicate track.
    if (!best) {
      let bestKm = REATTACH_KM;
      for (const tr of this.tracks) {
        if (!same(tr) || t - tr.lastUpdate > 15 * 60) continue;
        const p = predictPosition(tr, t);
        const km = Math.hypot(fix.x - p.x, fix.y - p.y);
        if (km < bestKm) { bestKm = km; best = tr; }
      }
      if (best) {
        best.P[2][2] += V0_VAR; best.P[3][3] += V0_VAR;
        best.P[0][0] += bestKm * bestKm; best.P[1][1] += bestKm * bestKm;
      }
    }
    const R = [
      [Math.max(fix.cov[0], 1e-4), fix.cov[1]],
      [fix.cov[1], Math.max(fix.cov[2], 1e-4)],
    ];
    if (!best) {
      if (!allowNew) return null;
      const tr: Track = {
        id: this.nextId++,
        s: [fix.x, fix.y, 0, 0],
        P: [
          [R[0][0], R[0][1], 0, 0],
          [R[1][0], R[1][1], 0, 0],
          [0, 0, V0_VAR, 0],
          [0, 0, 0, V0_VAR],
        ],
        t,
        lastUpdate: t,
        nFixes: 1,
        species,
        history: [{ t, x: fix.x, y: fix.y }],
      };
      this.tracks.push(tr);
      return tr;
    }
    const { s, P } = predictState(best, t);
    // Kalman update with H = [I2 0]
    const S = [
      [P[0][0] + R[0][0], P[0][1] + R[0][1]],
      [P[1][0] + R[1][0], P[1][1] + R[1][1]],
    ];
    const det = S[0][0] * S[1][1] - S[0][1] * S[1][0];
    const Si = [
      [S[1][1] / det, -S[0][1] / det],
      [-S[1][0] / det, S[0][0] / det],
    ];
    const K = zeros(4).map((_, i) => [P[i][0] * Si[0][0] + P[i][1] * Si[1][0], P[i][0] * Si[0][1] + P[i][1] * Si[1][1]]);
    const y = [fix.x - s[0], fix.y - s[1]];
    const ns = s.map((v, i) => v + K[i][0] * y[0] + K[i][1] * y[1]);
    const nP = zeros(4);
    for (let i = 0; i < 4; i++)
      for (let j = 0; j < 4; j++) nP[i][j] = P[i][j] - (K[i][0] * P[0][j] + K[i][1] * P[1][j]);
    // symmetrize
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) nP[i][j] = nP[j][i] = (nP[i][j] + nP[j][i]) / 2;
    best.s = ns as [number, number, number, number];
    best.P = nP;
    best.t = t;
    best.lastUpdate = t;
    best.nFixes++;
    best.history.push({ t, x: fix.x, y: fix.y });
    if (best.history.length > 400) best.history.shift();
    return best;
  }

  prune(t: number): void {
    this.tracks = this.tracks.filter((tr) => t - tr.lastUpdate < TRACK_TIMEOUT_S);
    // two tracks of the same species on top of each other are one whale: keep the one with more fixes
    const drop = new Set<Track>();
    for (const a of this.tracks) for (const b of this.tracks) {
      if (a === b || drop.has(a) || drop.has(b) || a.species !== b.species || a.nFixes < b.nFixes) continue;
      const pa = predictPosition(a, t), pb = predictPosition(b, t);
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < MERGE_KM) {
        drop.add(b);
        a.sightings = (a.sightings ?? 0) + (b.sightings ?? 0) || a.sightings;
      }
    }
    if (drop.size) this.tracks = this.tracks.filter((tr) => !drop.has(tr));
  }
}
