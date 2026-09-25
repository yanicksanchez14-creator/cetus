import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Simulation } from "../src/engine/sim";
import { Traffic } from "../src/engine/traffic";
import { loadDepthModel } from "./helpers";

// Encounters are random now: no scripted singer, and the hotspot whales differ from seed to seed.
it("encounters are random: no scripted singer, different whales per seed", () => {
  const depth = loadDepthModel();
  const tr = new Traffic(JSON.parse(readFileSync(new URL("../src/assets/traffic.json", import.meta.url), "utf8")));
  const starts: string[] = [];
  for (const seed of [1, 2, 3]) {
    const sim = new Simulation(depth, { mode: "ships", seed }, tr);
    expect(sim.whales.some((w) => w.singer)).toBe(false);
    starts.push(sim.whales.filter((w) => w.conflict).map((w) => `${w.species}@${w.x.toFixed(1)},${w.y.toFixed(1)}`).join(" "));
    while (!sim.finished) sim.step(60);
    expect(sim.finished).toBe(true);
  }
  expect(new Set(starts).size).toBe(3);
}, 1800000);
