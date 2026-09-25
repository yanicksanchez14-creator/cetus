import { expect, it } from "vitest";
import { Whale } from "../src/engine/whale";
import { Rng } from "../src/engine/rng";
import { predictPosition, type Track } from "../src/engine/tracker";
import { KNOT_KMS } from "../src/engine/geo";

// The tracker's forecast spread must match how the simulated whales really wander, separately sideways (heading
// wander) and along their path (speed changes): not much smaller (unsafe) and not much larger (needless big shifts).
it("forecast spread is calibrated to whale movement, sideways and along the path", () => {
  const depth = { elevation: () => -3000 } as never;
  const rows: string[] = [];
  for (const kn of [2, 3, 4.5, 6]) {
    for (const T of [1800, 3600]) {
      let sl = 0, sa = 0;
      const n = 800;
      for (let i = 0; i < n; i++) {
        const w = new Whale({ id: 1, species: "fin", start: [0, 0], activeFrom: 0, speedKn: kn, conflict: false }, new Rng(i * 7 + 3), depth);
        for (let t = 0; t < 5400; t += 10) w.step(t, 10);
        const x0 = w.x, y0 = w.y, h = w.heading, v = w.speed;
        for (let t = 5400; t < 5400 + T; t += 10) w.step(t, 10);
        const dx = w.x - (x0 + Math.cos(h) * v * T), dy = w.y - (y0 + Math.sin(h) * v * T);
        sa += (dx * Math.cos(h) + dy * Math.sin(h)) ** 2;
        sl += (-dx * Math.sin(h) + dy * Math.cos(h)) ** 2;
      }
      const realLat = Math.sqrt(sl / n), realAlong = Math.sqrt(sa / n);
      // a well-established track heading east at this speed
      const tr: Track = { id: 1, s: [0, 0, kn * KNOT_KMS, 0], P: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 1e-12, 0], [0, 0, 0, 1e-12]], t: 0, lastUpdate: 0, nFixes: 10, history: [] };
      const p = predictPosition(tr, T);
      const mAlong = Math.sqrt(p.cov[0]), mLat = Math.sqrt(p.cov[2]);
      rows.push(`${kn} kn ${T / 60} min: sideways real ${realLat.toFixed(2)} model ${mLat.toFixed(2)} · along real ${realAlong.toFixed(2)} model ${mAlong.toFixed(2)}`);
      expect(mLat / realLat).toBeGreaterThan(0.75);
      expect(mLat / realLat).toBeLessThan(1.45);
      expect(mAlong / realAlong).toBeGreaterThan(0.75);
      expect(mAlong / realAlong).toBeLessThan(1.45);
    }
  }
  console.log(rows.join("\n"));
}, 600000);
