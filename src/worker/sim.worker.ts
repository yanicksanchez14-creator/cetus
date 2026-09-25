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
import { Traffic, type TrafficFile } from "../engine/traffic";
import { SHIP_SENSOR_BASE, usesShips } from "../engine/sim";
import { SHORE_STATIONS } from "../engine/stations";
import trafficFile from "../assets/traffic.json";
import { summarize, type ModeId } from "../engine/summary";
import type { BatchReply } from "./protocol";

let traffic: Traffic | null = null;
const getTraffic = () => (traffic ??= new Traffic(trafficFile as unknown as TrafficFile));
const CLS: Record<string, number> = { cargo: 0, tanker: 1, passenger: 2 };
const heardAt = new Map<number, number>(); // ship idx -> sim time it last heard/saw a whale

let sim: Simulation | null = null;
let newCalls: CallEvent[] = [];
let newDecisions: Decision[] = [];
let newNearMisses: { species: SpeciesId; distM: number; deep: boolean; singer: boolean; speedKn: number }[] = [];
let newStrikes: import("../engine/sim").Strike[] = [];
let lastPlan: unknown = null;
let planVersion = 0;
let snapCount = 0;
let coverageSent = 0;

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
  // one marker per whale: if two tracks of the same species sit within ~2 km, show only the better one
  const kept: Track[] = [];
  for (const tr of [...s.tracker.tracks].sort((a, b) => b.nFixes - a.nFixes)) {
    const p = predictPosition(tr, s.t);
    const sp = (tr as Track & { species?: SpeciesId }).species;
    if (kept.some((k) => (k as Track & { species?: SpeciesId }).species === sp && (() => { const q = predictPosition(k, s.t); return Math.hypot(q.x - p.x, q.y - p.y) < 2; })())) continue;
    kept.push(tr);
  }
  const tracks: SnapTrack[] = kept
    // show only whales the engine would act on: 3+ fixes or a camera sighting, heard/seen in the last 20 min
    // (older forecasts just drift and balloon - the engine ignores them too)
    .filter((tr) => (tr.nFixes >= 3 || !!tr.sightings) && s.t - tr.lastUpdate <= 20 * 60)
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
        speedKn: Math.hypot(p.vx, p.vy) / KNOT_KMS, ageS: s.t - tr.lastUpdate, heading: Math.atan2(p.vy, p.vx),
      };
    });
  const calls: SnapCall[] = newCalls.map((c) => {
    const [clon, clat] = toLL(...c.truePos);
    return {
      id: c.id, t: c.t, whaleId: c.whaleId, species: c.species, lon: clon, lat: clat,
      sensors: usesShips(s.opts.mode) ? [] : c.detected.map((d) => d.sensor.id),
      from: usesShips(s.opts.mode) ? c.detected.slice(0, 12).map((d) => d.sensor.ll as [number, number]) : undefined,
      kind: c.kind ?? "call",
      fix: c.fix ? ell(c.fix.x, c.fix.y, c.fix.cov) : undefined, errorKm: c.errorKm,
      rangeKm: nominalRangeKm(SPECIES[c.species]),
    };
  });
  if (usesShips(s.opts.mode)) {
    for (const c of newCalls) for (const d of c.detected) if (d.sensor.id >= SHIP_SENSOR_BASE) heardAt.set(d.sensor.id - SHIP_SENSOR_BASE, s.t);
  }
  newCalls = [];
  let trafficSnap: Snapshot["traffic"];
  if (usesShips(s.opts.mode) && s.traffic) {
    const now = s.traffic.at(s.t);
    trafficSnap = { lon: [], lat: [], hdg: [], cls: [], heard: [] };
    for (const q of now) {
      const [qlon, qlat] = toLL(q.pos[0], q.pos[1]);
      trafficSnap.lon.push(qlon);
      trafficSnap.lat.push(qlat);
      trafficSnap.hdg.push(q.heading);
      trafficSnap.cls.push(CLS[s.traffic.ships[q.idx].cls] ?? 0);
      const h = heardAt.get(q.idx);
      trafficSnap.heard.push(h === undefined ? 1e9 : s.t - h);
    }
  }
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
    calls, decisions, activeDecision: act, traffic: trafficSnap,
    ahead: s.ahead,
    coverage: (() => { const c = s.coverage.slice(coverageSent); coverageSent = s.coverage.length; return c; })(),
    cautionPrompt: s.pendingCaution, cautionActive: !!s.caution, strikes: (() => { const k = newStrikes; newStrikes = []; return k; })(),
    nearMisses: (() => { const k = newNearMisses; newNearMisses = []; return k; })(),
    stats: {
      calls: s.stats.calls, detections: s.stats.detections, fixes: s.stats.fixes, meanErrorKm: s.meanErrorKm,
      fuelUsed: s.fuelUsed, baselineFuelSoFar: s.baselineFuel * s.progress,
      scheduledArrival: s.scheduledArrival, etaS: s.t + remaining / (vNow * KNOT_KMS),
      conflicts: log.length, maneuvers: s.maneuverCount,
      // measured cost (fuel burned vs holding speed + time behind schedule), not the last plan's estimate
      decisionsCostUsd: s.actual.usd, actualFuelDeltaT: s.actual.fuelDeltaT, behindMin: s.actual.behindMin,
      ...s.normalTrip, timeCostPerHour: s.opts.params.timeCostPerHour,
      riskHold: log.reduce((a, d) => a + d.hold.lethalRisk, 0),
      riskTaken: log.reduce((a, d) => a + d.chosen.lethalRisk, 0),
      riskPolicy: log.reduce((a, d) => a + d.policy.lethalRisk, 0),
      sightings: s.stats.sightings,
      cautions: s.cautionStats.count, cautionMin: s.cautionStats.minutes,
      strikes: s.strikes.length, lethalStrikes: s.strikes.filter((k) => k.lethal).length,
      policyLateMin: s.policyCounterfactual.lateMin,
      shipsContributing: s.listeningShips.size,
      // today's practice on the same encounters: every whale detection near the lane triggers a slow zone
      policyCostUsd: s.policyCounterfactual.usd,
    },
  };
}

let batchDepth: DepthModel | null = null;

self.onmessage = (ev: MessageEvent<ToWorker>) => {
  const msg = ev.data;
  if (msg.type === "batch") {
    if (msg.grids) batchDepth = new DepthModel(msg.grids);
    const mode = (msg.options.mode ?? "network") as ModeId;
    const t0 = performance.now();
    const b = new Simulation(batchDepth!, { ...msg.options, caution: "slow" }, mode === "ships" || mode === "mix" ? getTraffic() : null);
    while (!b.finished) b.step(30);
    const reply: BatchReply = { type: "batchResult", jobId: msg.jobId, summary: summarize(b, mode, msg.options.seed ?? 0, (performance.now() - t0) / 1000) };
    (self as unknown as Worker).postMessage(reply);
    return;
  }
  if (msg.type === "init") {
    heardAt.clear();
    sim = new Simulation(new DepthModel(msg.grids), msg.options, msg.options.mode === "ships" || msg.options.mode === "mix" ? getTraffic() : null);
    coverageSent = 0;
    newCalls = [];
    newDecisions = [];
    newStrikes = [];
    newNearMisses = [];
    lastPlan = null;
    snapCount = 0;
    sim.on((e) => {
      if (e.type === "call") newCalls.push(e.call);
      else if (e.type === "decision") newDecisions.push(e.decision);
      else if (e.type === "strike") newStrikes.push(e.strike);
      else newNearMisses.push({ species: e.species, distM: e.distM, deep: e.deep, singer: e.singer, speedKn: e.speedKn });
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
      stations: sim.opts.mode === "mix" ? SHORE_STATIONS.map((st, i) => ({ name: st.name, lon: sim!.sensors[i].ll[0], lat: sim!.sensors[i].ll[1] })) : undefined,
      traffic: sim.traffic ? {
        source: sim.traffic.file.source, synthetic: !!sim.traffic.file.synthetic,
        ships: sim.traffic.countPresent(0, sim.scheduledArrival), date: sim.traffic.file.t0Utc.slice(0, 10),
      } : undefined,
      scenario: {
        encounters: scen.encounters.map((e) => ({ label: e.label, species: e.species, s: sim!.route.project(toXY(e.near[0], e.near[1])).s })),
      },
    };
    (self as unknown as Worker).postMessage(reply, [sensors.lon.buffer, sensors.lat.buffer, sensors.phase.buffer]);
    (self as unknown as Worker).postMessage({ type: "snap", ...snapshot() });
  } else if (msg.type === "skip" && sim) {
    const n0 = sim.decisions.filter((d) => d.chosen.id !== "hold").length;
    const t0 = sim.t;
    while (!sim.finished && !sim.pendingCaution && !newStrikes.length && sim.t - t0 < 8 * 3600 && sim.decisions.filter((d) => d.chosen.id !== "hold").length === n0) sim.step(60);
    newCalls = newCalls.slice(-20);
    (self as unknown as Worker).postMessage({ type: "snap", ...snapshot() });
  } else if (msg.type === "caution" && sim) {
    sim.answerCaution(msg.slow);
    (self as unknown as Worker).postMessage({ type: "snap", ...snapshot() });
  } else if (msg.type === "step" && sim) {
    sim.step(msg.dt);
    (self as unknown as Worker).postMessage({ type: "snap", ...snapshot() });
  }
};
