/// <reference lib="webworker" />
/** Runs the simulation off the main thread so the map animates smoothly. */
import { DepthModel } from "../engine/bathy";
import { Simulation, type CallEvent } from "../engine/sim";
import type { Decision } from "../engine/decision";
import { predictPosition, type Track } from "../engine/tracker";
import { ellipse } from "../engine/localize";
import { toLL, toXY, KNOT_KMS } from "../engine/geo";
import { nominalRangeKm, SPECIES, type SpeciesId } from "../engine/physics";
import { SCENARIOS } from "../engine/scenario";
import type { ToWorker, Snapshot, SnapTrack, EllipseLL, SnapCall, InitReply } from "./protocol";

let sim: Simulation | null = null;
let newCalls: CallEvent[] = [];
let newDecisions: Decision[] = [];
let lastPlan: unknown = null;
let planVersion = 0;
let snapCount = 0;

function ell(x: number, y: number, cov: [number, number, number]): EllipseLL {
  const e = ellipse(cov, 0.95);
  const [lon, lat] = toLL(x, y);
  return { lon, lat, a: e.a, b: e.b, angle: e.angle };
}

function snapshot(): Snapshot {
  const s = sim!;
  const [lon, lat] = toLL(...s.shipXY);
  let plannedPath: [number, number][] | undefined;
  if (s.plan !== lastPlan || snapCount % 20 === 0) {
    if (s.plan !== lastPlan) planVersion++;
    lastPlan = s.plan;
    plannedPath = s.plannedPath(160);
  }
  snapCount++;
  const act = s.maneuver?.decision ?? null;
  let maneuverZone: [number, number][] | null = null;
  if (act) {
    const z = act.chosen.plan.zones[0] ? [act.chosen.plan.zones[0].s0, act.chosen.plan.zones[0].s1] : act.zone;
    maneuverZone = [];
    for (let q = z[0]; q <= z[1]; q += 0.5) maneuverZone.push(toLL(...s.route.at(q).p));
  }
  const tracks: SnapTrack[] = s.tracker.tracks
    .filter((tr) => tr.nFixes >= 2)
    .map((tr: Track & { species?: SpeciesId }) => {
      const p = predictPosition(tr, s.t);
      const [tlon, tlat] = toLL(p.x, p.y);
      const future = [900, 1800, 2700].map((dt) => {
        const f = predictPosition(tr, s.t + dt);
        return ell(f.x, f.y, f.cov);
      });
      return {
        id: tr.id, species: tr.species ?? "humpback", lon: tlon, lat: tlat, now: ell(p.x, p.y, p.cov), future,
        history: tr.history.slice(-80).map((h) => toLL(h.x, h.y)), nFixes: tr.nFixes,
        speedKn: Math.hypot(p.vx, p.vy) / KNOT_KMS, ageS: s.t - tr.lastUpdate,
      };
    });
  const calls: SnapCall[] = newCalls.map((c) => {
    const [clon, clat] = toLL(...c.truePos);
    return {
      id: c.id, t: c.t, whaleId: c.whaleId, species: c.species, lon: clon, lat: clat,
      sensors: c.detected.map((d) => d.sensor.id),
      fix: c.fix ? ell(c.fix.x, c.fix.y, c.fix.cov) : undefined, errorKm: c.errorKm,
      rangeKm: nominalRangeKm(SPECIES[c.species]),
    };
  });
  newCalls = [];
  const decisions = newDecisions;
  newDecisions = [];
  const log = s.conflictLog;
  const remaining = s.route.length - s.s;
  const vNow = Math.max(s.plan.baseSpeed, 1);
  return {
    t: s.t, finished: s.finished,
    ship: { lon, lat, heading: s.shipHeading, speed: s.shipSpeed, s: s.s, progress: s.progress },
    planVersion, plannedPath, maneuverZone,
    whales: s.whales.map((w) => {
      const [wlon, wlat] = toLL(w.x, w.y);
      return {
        id: w.id, species: w.species, lon: wlon, lat: wlat, heading: w.heading, active: w.active(s.t),
        conflict: w.conflict, trail: w.trail.slice(-120).map((p) => toLL(p.x, p.y)),
      };
    }),
    tracks,
    zones: [...s.zones.values()].filter((z) => s.t - z.t < 30 * 60).map((z) => {
      const [zlon, zlat] = toLL(z.cx, z.cy);
      return { lon: zlon, lat: zlat, r: z.r, ageS: s.t - z.t, species: z.species };
    }),
    calls, decisions, activeDecision: act,
    stats: {
      calls: s.stats.calls, detections: s.stats.detections, fixes: s.stats.fixes, meanErrorKm: s.meanErrorKm,
      fuelUsed: s.fuelUsed, baselineFuelSoFar: s.baselineFuel * s.progress,
      scheduledArrival: s.scheduledArrival, etaS: s.t + remaining / (vNow * KNOT_KMS),
      conflicts: log.length, maneuvers: log.filter((d) => d.chosen.id !== "hold").length,
      decisionsCostUsd: log.reduce((a, d) => a + d.chosen.costDeltaUsd, 0),
      riskHold: log.reduce((a, d) => a + d.hold.lethalRisk, 0),
      riskTaken: log.reduce((a, d) => a + d.chosen.lethalRisk, 0),
      policyCostUsd: log.reduce((a, d) => a + (d.chosen.id === "hold" ? 0 : d.policy.costDeltaUsd), 0),
    },
  };
}

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === "init") {
    sim = new Simulation(new DepthModel(msg.grids), msg.options);
    newCalls = [];
    newDecisions = [];
    lastPlan = null;
    snapCount = 0;
    sim.on((e) => {
      if (e.type === "call") newCalls.push(e.call);
      else newDecisions.push(e.decision);
    });
    const n = sim.sensors.length;
    const sensors = { lon: new Float32Array(n), lat: new Float32Array(n), phase: new Float32Array(n) };
    sim.sensors.forEach((se, i) => {
      sensors.lon[i] = se.ll[0];
      sensors.lat[i] = se.ll[1];
      sensors.phase[i] = se.phase;
    });
    const scen = SCENARIOS[sim.route.def.id];
    const reply: InitReply = {
      type: "ready", sensors, spacingKm: sim.spacing, route: sim.route.def.waypoints as [number, number][],
      routeLengthKm: sim.route.length,
      scenario: {
        encounters: scen.encounters.map((e) => ({ label: e.label, species: e.species, s: sim!.route.project(toXY(e.near[0], e.near[1])).s })),
      },
    };
    (self as unknown as Worker).postMessage(reply, [sensors.lon.buffer, sensors.lat.buffer, sensors.phase.buffer]);
    (self as unknown as Worker).postMessage({ type: "snap", ...snapshot() });
  } else if (msg.type === "skip" && sim) {
    const n0 = sim.decisions.filter((d) => d.chosen.id !== "hold").length;
    const t0 = sim.t;
    while (!sim.finished && sim.t - t0 < 8 * 3600 && sim.decisions.filter((d) => d.chosen.id !== "hold").length === n0) sim.step(60);
    newCalls = newCalls.slice(-20);
    (self as unknown as Worker).postMessage({ type: "snap", ...snapshot() });
  } else if (msg.type === "step" && sim) {
    sim.step(msg.dt);
    (self as unknown as Worker).postMessage({ type: "snap", ...snapshot() });
  }
};
