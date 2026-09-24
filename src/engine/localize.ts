/**
 * Locating a whale call from arrival-time differences (TDOA / "multilateration").
 *
 * A call made at unknown position (x, y) and unknown time t0 reaches sensor i at
 *     t_i = t0 + |p - s_i| / c  (+ timing error)
 * With 3+ sensors we solve for (x, y, t0) by non-linear least squares (Gauss-Newton with damping).
 * The inverse of JᵀJ, scaled by the timing error, gives the covariance of the position -> error ellipse.
 */
import type { XY } from "./geo";

export interface Arrival {
  pos: XY; // sensor position, km
  t: number; // measured arrival time, s
  snr: number;
}

export interface Fix {
  x: number;
  y: number;
  t0: number;
  cov: [number, number, number]; // [var_x, cov_xy, var_y] in km²
  rmsResidualS: number;
  nSensors: number;
  ok: boolean;
}

function solve3(A: number[][], b: number[]): number[] | null {
  // Gaussian elimination for a 3x3 system
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k < 4; k++) M[r][k] -= f * M[c][k];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

function invert3(A: number[][]): number[][] | null {
  const cols = [0, 1, 2].map((j) => solve3(A, [0, 1, 2].map((i) => (i === j ? 1 : 0))));
  if (cols.some((c) => c === null)) return null;
  return [0, 1, 2].map((i) => [0, 1, 2].map((j) => (cols[j] as number[])[i]));
}

/**
 * @param arrivals detections of ONE call (use the strongest ~8-16)
 * @param c assumed speed of sound, km/s
 * @param sigmaT timing error standard deviation, s (sets the size of the error ellipse)
 */
export function locate(arrivals: Arrival[], c: number, sigmaT: number): Fix {
  const n = arrivals.length;
  const bad: Fix = { x: 0, y: 0, t0: 0, cov: [1e6, 0, 1e6], rmsResidualS: Infinity, nSensors: n, ok: false };
  if (n < 3) return bad;
  // start: SNR-weighted centroid, earliest arrival minus a guess of travel time
  let wsum = 0;
  let x = 0;
  let y = 0;
  for (const a of arrivals) {
    const w = Math.max(a.snr, 1);
    x += w * a.pos[0];
    y += w * a.pos[1];
    wsum += w;
  }
  x /= wsum;
  y /= wsum;
  let t0 = Math.min(...arrivals.map((a) => a.t)) - 2;
  let lambda = 1e-3;
  const cost = (px: number, py: number, pt: number) =>
    arrivals.reduce((s, a) => {
      const r = a.t - (pt + Math.hypot(px - a.pos[0], py - a.pos[1]) / c);
      return s + r * r;
    }, 0);
  let cur = cost(x, y, t0);
  for (let it = 0; it < 60; it++) {
    const JtJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const Jtr = [0, 0, 0];
    for (const a of arrivals) {
      const dx = x - a.pos[0];
      const dy = y - a.pos[1];
      const d = Math.max(Math.hypot(dx, dy), 1e-6);
      const J = [dx / (c * d), dy / (c * d), 1];
      const r = a.t - (t0 + d / c);
      for (let i = 0; i < 3; i++) {
        Jtr[i] += J[i] * r;
        for (let j = 0; j < 3; j++) JtJ[i][j] += J[i] * J[j];
      }
    }
    const A = JtJ.map((row, i) => row.map((v, j) => v + (i === j ? lambda * (JtJ[i][i] + 1e-9) : 0)));
    const step = solve3(A, Jtr);
    if (!step) break;
    const nx = x + step[0];
    const ny = y + step[1];
    const nt = t0 + step[2];
    const nc = cost(nx, ny, nt);
    if (nc < cur) {
      x = nx;
      y = ny;
      t0 = nt;
      const improved = cur - nc;
      cur = nc;
      lambda = Math.max(lambda / 3, 1e-9);
      if (improved < 1e-12 && Math.hypot(step[0], step[1]) < 1e-5) break;
    } else {
      lambda *= 5;
      if (lambda > 1e8) break;
    }
  }
  // covariance
  const JtJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const a of arrivals) {
    const dx = x - a.pos[0];
    const dy = y - a.pos[1];
    const d = Math.max(Math.hypot(dx, dy), 1e-6);
    const J = [dx / (c * d), dy / (c * d), 1];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) JtJ[i][j] += J[i] * J[j];
  }
  const inv = invert3(JtJ);
  if (!inv) return bad;
  const rms = Math.sqrt(cur / n);
  // use the larger of the assumed timing error and the observed residual (honest uncertainty)
  const s2 = Math.max(sigmaT, n > 3 ? rms * Math.sqrt(n / (n - 3)) : sigmaT) ** 2;
  const cov: [number, number, number] = [inv[0][0] * s2, inv[0][1] * s2, inv[1][1] * s2];
  const ok = isFinite(x) && isFinite(y) && cov[0] > 0 && cov[2] > 0 && Math.sqrt(cov[0] + cov[2]) < 50;
  return { x, y, t0, cov, rmsResidualS: rms, nSensors: n, ok };
}

/** Axes (km) and rotation (radians, from +x) of the error ellipse containing `p` probability. */
export function ellipse(cov: [number, number, number], p = 0.95): { a: number; b: number; angle: number } {
  const [sxx, sxy, syy] = cov;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(tr / 2 - disc, 0);
  const k = Math.sqrt(-2 * Math.log(1 - p)); // chi-square with 2 dof
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { a: k * Math.sqrt(l1), b: k * Math.sqrt(l2), angle };
}
