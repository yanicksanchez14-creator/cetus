import { describe, it, expect } from "vitest";
import { locate, ellipse, type Arrival } from "../src/engine/localize";
import { Tracker, predictPosition } from "../src/engine/tracker";
import { Rng } from "../src/engine/rng";

function simulateCall(rng: Rng, src: [number, number], sensors: [number, number][], c: number, sigmaT: number): Arrival[] {
  const t0 = 1000;
  return sensors.map((s) => ({
    pos: s,
    t: t0 + Math.hypot(src[0] - s[0], src[1] - s[1]) / c + rng.gauss(0, sigmaT),
    snr: 20,
  }));
}

function grid(spacing: number, n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push([i * spacing, j * spacing]);
  return out;
}

describe("TDOA localisation", () => {
  it("recovers an exact position with perfect timing", () => {
    const rng = new Rng(1);
    const sensors: [number, number][] = [[0, 0], [10, 0], [0, 10], [10, 10], [5, -3]];
    const fix = locate(simulateCall(rng, [3.3, 6.1], sensors, 1.5, 0), 1.5, 0.001);
    expect(fix.ok).toBe(true);
    expect(Math.hypot(fix.x - 3.3, fix.y - 6.1)).toBeLessThan(1e-3);
    expect(fix.t0).toBeCloseTo(1000, 3);
  });

  it("error ellipses are honest: ~95% of true positions fall inside the 95% ellipse", () => {
    const rng = new Rng(42);
    const sensors = grid(5, 4); // 4x4 sensors, 5 km apart
    const sigmaT = 0.02;
    let inside = 0;
    let errSum = 0;
    const N = 400;
    for (let k = 0; k < N; k++) {
      const src: [number, number] = [rng.uniform(2, 13), rng.uniform(2, 13)];
      const fix = locate(simulateCall(rng, src, sensors, 1.5, sigmaT), 1.5, sigmaT);
      expect(fix.ok).toBe(true);
      const dx = src[0] - fix.x;
      const dy = src[1] - fix.y;
      errSum += Math.hypot(dx, dy);
      const [a, b, c] = fix.cov;
      const det = a * c - b * b;
      const m2 = (c * dx * dx - 2 * b * dx * dy + a * dy * dy) / det;
      if (m2 <= 5.991) inside++;
    }
    const coverage = inside / N;
    expect(coverage).toBeGreaterThan(0.9);
    expect(coverage).toBeLessThan(0.995);
    expect(errSum / N).toBeLessThan(0.1); // mean error < 100 m with 20 ms timing noise
  });

  it("ellipse axes match the covariance", () => {
    const e = ellipse([4, 0, 1], 0.95);
    expect(e.a).toBeCloseTo(2 * Math.sqrt(5.991), 3);
    expect(e.b).toBeCloseTo(1 * Math.sqrt(5.991), 3);
  });

  it("refuses to locate with fewer than 3 sensors", () => {
    const rng = new Rng(3);
    expect(locate(simulateCall(rng, [1, 1], [[0, 0], [5, 0]], 1.5, 0.01), 1.5, 0.01).ok).toBe(false);
  });
});

describe("Kalman tracker", () => {
  it("follows a moving whale and estimates its velocity", () => {
    const rng = new Rng(7);
    const sensors = grid(6, 5);
    const tracker = new Tracker();
    const v = [0.0015, 0.0008]; // km/s (~3.3 kn)
    let tr = null;
    for (let k = 0; k < 120; k++) {
      const t = k * 15;
      const src: [number, number] = [4 + v[0] * t, 5 + v[1] * t];
      const fix = locate(simulateCall(rng, src, sensors, 1.5, 0.02), 1.5, 0.02);
      tr = tracker.addFix(fix, t);
    }
    expect(tracker.tracks.length).toBe(1);
    const p = predictPosition(tr!, 119 * 15);
    expect(Math.hypot(p.vx - v[0], p.vy - v[1])).toBeLessThan(0.0003);
    // prediction 10 minutes ahead should still be close
    const ahead = predictPosition(tr!, 119 * 15 + 600);
    const truth = [4 + v[0] * (119 * 15 + 600), 5 + v[1] * (119 * 15 + 600)];
    expect(Math.hypot(ahead.x - truth[0], ahead.y - truth[1])).toBeLessThan(0.3);
    expect(ahead.cov[0]).toBeGreaterThan(p.cov[0]); // uncertainty grows into the future
  });

  it("keeps two distant whales on separate tracks", () => {
    const rng = new Rng(9);
    const sensors = grid(6, 8);
    const tracker = new Tracker();
    for (let k = 0; k < 40; k++) {
      const t = k * 20;
      for (const src of [[5, 5], [35, 30]] as [number, number][]) {
        tracker.addFix(locate(simulateCall(rng, src, sensors, 1.5, 0.02), 1.5, 0.02), t);
      }
    }
    expect(tracker.tracks.length).toBe(2);
  });
});
