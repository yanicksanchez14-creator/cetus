import { describe, it, expect } from "vitest";
import { Simulation } from "../src/engine/sim";
import { lethality } from "../src/engine/physics";
import { loadDepthModel } from "./helpers";

const depth = loadDepthModel();

function describeRun(sim: Simulation) {
  const log = sim.conflictLog.map((d) => ({
    km: Math.round(d.sConflict),
    kind: d.beliefKind,
    species: d.species,
    chosen: d.chosen.id,
    holdRisk: +(d.hold.lethalRisk * 100).toFixed(3),
    chosenRisk: +(d.chosen.lethalRisk * 100).toFixed(3),
    extraMin: +d.chosen.extraMinutes.toFixed(1),
    fuelT: +d.chosen.fuelDeltaT.toFixed(2),
    usd: Math.round(d.chosen.costDeltaUsd),
    options: d.options.map((o) => `${o.id}:${(o.lethalRisk * 100).toFixed(3)}%/$${Math.round(o.costDeltaUsd)}${o.valid ? "" : "(x)"}`).join(" "),
  }));
  return { log, summary: sim.summary(), meanErrKm: sim.meanErrorKm, sensors: sim.sensors.length, spacing: sim.spacing, hours: sim.t / 3600 };
}

describe("physics sanity", () => {
  it("lethality matches Vanderlaan & Taggart 2007", () => {
    expect(lethality(10)).toBeCloseTo(0.31, 2);
    expect(lethality(11.8)).toBeCloseTo(0.49, 2);
    expect(lethality(15)).toBeCloseTo(0.78, 2);
  });
});

describe("full voyage", () => {
  it("network mode: whales located, conflicts handled", () => {
    const t0 = Date.now();
    const sim = new Simulation(depth, { mode: "network", sensorCount: 3000, seed: 11 });
    sim.runToEnd();
    const r = describeRun(sim);
    console.log("NETWORK", JSON.stringify(r, null, 1), `${Date.now() - t0} ms`);
    expect(sim.finished).toBe(true);
    expect(r.hours).toBeGreaterThan(20);
    expect(r.hours).toBeLessThan(26);
    expect(r.meanErrKm).toBeLessThan(0.5);
    expect(r.log.length).toBeGreaterThanOrEqual(2);
  }, 120000);

  it("single-buoy mode: whales detected but not located", () => {
    const sim = new Simulation(depth, { mode: "single", seed: 11 });
    sim.runToEnd();
    const r = describeRun(sim);
    console.log("SINGLE", JSON.stringify(r, null, 1));
    expect(sim.finished).toBe(true);
  }, 120000);
});
