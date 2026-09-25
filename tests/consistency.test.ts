import { it, expect } from "vitest";
import { Simulation } from "../src/engine/sim";
import { loadDepthModel } from "./helpers";

// What the panel/bubble report (maneuver.decision.chosen) must always be what the ship actually flies (sim.plan).
it("reported manoeuvre always matches the plan being flown", () => {
  const depth = loadDepthModel();
  let checks = 0;
  const bad: string[] = [];
  for (const style of ["targeted", "ahead"] as const)
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const sim = new Simulation(depth, { mode: "network", style, seed, sensorCount: 1000 });
      while (!sim.finished) {
        sim.step(60);
        const m = sim.maneuver;
        if (!m) continue;
        checks++;
        const rep = m.decision.chosen.plan;
        const fly = sim.plan;
        const sideOk = Math.sign(rep.offset?.d ?? 0) === Math.sign(fly.offset?.d ?? 0);
        const slowOk = (rep.zones.length > 0) === (fly.zones.length > 0);
        if (!sideOk || !slowOk) bad.push(`${style} seed ${seed} t=${(sim.t / 3600).toFixed(2)}h reports ${m.decision.chosen.id} (${rep.offset?.d ?? 0} km, ${rep.zones.length} zones) but flies ${fly.offset?.d ?? 0} km, ${fly.zones.length} zones`);
      }
    }
  console.log(`${checks} checks, ${bad.length} mismatches\n` + bad.slice(0, 10).join("\n"));
  expect(bad.length).toBe(0);
}, 3000000);
