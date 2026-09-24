/**
 * Whale tracker: a constant-velocity Kalman filter per whale.
 * Each located call updates the track; between calls the uncertainty grows, which is what the
 * "probable region" on the map shows. Calls are assigned to tracks by statistical distance (gating),
 * so the tracker never uses the true identity of a whale.
 */
import type { Fix } from "./localize";

export interface Track {
  id: number;
  // state [x, y, vx, vy] in km and km/s
  s: [number, number, number, number];
  P: number[][]; // 4x4 covariance
  t: number; // time of state, s
  lastUpdate: number;
  nFixes: number;
  history: { t: number; x: number; y: number }[];
}

// Process noise (random acceleration, km²/s³). Calibrated to whale behaviour: heading wanders ~0.7 rad per hour
// at 2-4 kn, i.e. velocity changes of ~1 m/s per hour -> q ≈ (0.0013 km/s)² / 3600 s ≈ 5e-10.
const Q_ACC = 5e-10;
const V0_VAR = (2.2 / 1000) ** 2; // initial velocity uncertainty: ~2.2 m/s (≈4 kn)
const GATE = 16; // Mahalanobis² gate for assigning a fix to a track
export const TRACK_TIMEOUT_S = 40 * 60;

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
  const q = Q_ACC;
  const dt2 = dt * dt;
  const dt3 = dt2 * dt;
  P[0][0] += (q * dt3) / 3;
  P[1][1] += (q * dt3) / 3;
  P[0][2] += (q * dt2) / 2;
  P[2][0] += (q * dt2) / 2;
  P[1][3] += (q * dt2) / 2;
  P[3][1] += (q * dt2) / 2;
  P[2][2] += q * dt;
  P[3][3] += q * dt;
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

  /** Assign a fix to the best track (or start a new one). Returns the updated track. */
  addFix(fix: Fix, t: number): Track {
    let best: Track | null = null;
    let bestD = GATE;
    for (const tr of this.tracks) {
      const d = mahalanobis2(tr, fix, t);
      if (d < bestD) {
        bestD = d;
        best = tr;
      }
    }
    const R = [
      [Math.max(fix.cov[0], 1e-4), fix.cov[1]],
      [fix.cov[1], Math.max(fix.cov[2], 1e-4)],
    ];
    if (!best) {
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
  }
}
