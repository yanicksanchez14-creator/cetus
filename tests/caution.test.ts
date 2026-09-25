import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Simulation } from "../src/engine/sim";
import { Traffic } from "../src/engine/traffic";
import { loadDepthModel } from "./helpers";

it("ships mode: precautionary slow-downs and strike detection", () => {
  const depth = loadDepthModel();
  const tr = new Traffic(JSON.parse(readFileSync(new URL("../src/assets/traffic.json", import.meta.url), "utf8")));
  const rows: string[] = [];
  for (const caution of ["slow", "ignore", "ask"] as const)
    for (const seed of [1, 2, 3]) {
      const sim = new Simulation(depth, { mode: "ships", seed, caution }, tr);
      let asked = 0;
      while (!sim.finished) {
        sim.step(60);
        if (sim.pendingCaution) { asked++; sim.answerCaution(true); }
      }
      const sm = sim.summary();
      rows.push(`${caution.padEnd(6)} seed ${seed}: cautions ${sim.cautionStats.count} (${Math.round(sim.cautionStats.minutes)} min${caution === "ask" ? `, asked ${asked}` : ""}) | strikes ${sim.strikes.length} | late ${sm.arrivalDelayMin.toFixed(0)} min | fuel +${sm.fuelDelta.toFixed(1)} t | min CPA ${Math.min(...sm.truth.map((t) => t.cpaKm)).toFixed(2)} km`);
      expect(sim.finished).toBe(true);
    }
  console.log(rows.join("\n"));
}, 1800000);
