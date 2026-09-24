/**
 * The simulation: ship + whales + sensors + detection + locating + tracking + decisions, on one clock.
 */
import { Rng } from "./rng";
import { KNOT_KMS, toLL, toXY, type XY } from "./geo";
import type { DepthModel } from "./bathy";
import { ROUTES, Route, integrate, offsetAt, shipHeading, shipPos, speedAt, type Plan } from "./route";
import {
  SPECIES, SOUND_SPEED_KMS, transmissionLoss, detectionProbability, nominalRangeKm, shipSourceLevel,
  shipBandOffset, fuelRateTph, DEFAULT_SHIP, CO2_PER_T_FUEL, lethality, type ShipSpec, type SpeciesId,
} from "./physics";
import { Whale } from "./whale";
import { networkSensors, singleBuoys, SensorIndex, spacingKm, type Sensor } from "./sensors";
import { locate, type Fix } from "./localize";
import { Tracker, predictPosition, type Track } from "./tracker";
import { decide, DEFAULT_PARAMS, type Belief, type Decision, type DecisionParams } from "./decision";
import { SCENARIOS } from "./scenario";

export type Mode = "network" | "single";

export interface SimOptions {
  seed: number;
  routeId: string;
  mode: Mode;
  sensorCount: number;
  corridorKm: number;
  sigmaT: number; // arrival-time error, s
  baseSpeed: number; // knots
  params: DecisionParams;
  ship: ShipSpec;
}

export const DEFAULT_OPTIONS: SimOptions = {
  seed: 20260924,
  routeId: "oak-lb",
  mode: "network",
  sensorCount: 3000,
  corridorKm: 45,
  sigmaT: 0.02,
  baseSpeed: 16,
  params: DEFAULT_PARAMS,
  ship: DEFAULT_SHIP,
};

export interface CallEvent {
  id: number;
  t: number;
  whaleId: number;
  species: SpeciesId;
  truePos: XY;
  detected: { sensor: Sensor; snr: number }[];
  fix?: Fix;
  trackId?: number;
  errorKm?: number;
}

export interface Zone {
  buoyId: number;
  cx: number;
  cy: number;
  r: number;
  t: number;
  species: SpeciesId;
}

export interface ActiveManeuver {
  decision: Decision;
  plan: Plan;
  endS: number;
}

export class Simulation {
  readonly opts: SimOptions;
  readonly route: Route;
  readonly sensors: Sensor[];
  readonly index: SensorIndex;
  readonly whales: Whale[] = [];
  readonly tracker = new Tracker();
  readonly rng: Rng;
  readonly cTrue: number; // actual sound speed (unknown to the locator)
  readonly spacing: number;
  t = 0;
  s = 0; // ship along-route distance, km
  plan: Plan;
  maneuver: ActiveManeuver | null = null;
  decisions: Decision[] = [];
  calls: CallEvent[] = [];
  zones = new Map<number, Zone>();
  fuelUsed = 0;
  finished = false;
  stats = { calls: 0, detections: 0, fixes: 0, errSum: 0 };
  private lastDecisionCheck = -1e9;
  private callSeq = 0;
  private listeners: ((e: { type: "call"; call: CallEvent } | { type: "decision"; decision: Decision }) => void)[] = [];

  constructor(private depth: DepthModel, opts: Partial<SimOptions> = {}) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts, params: { ...DEFAULT_PARAMS, ...(opts.params ?? {}) } };
    this.rng = new Rng(this.opts.seed);
    const def = ROUTES.find((r) => r.id === this.opts.routeId) ?? ROUTES[0];
    this.route = new Route(def);
    this.plan = { baseSpeed: this.opts.baseSpeed, zones: [], offset: null };
    this.cTrue = SOUND_SPEED_KMS * (1 + this.rng.gauss(0, 0.004));
    const scen = SCENARIOS[def.id];
    this.sensors = this.opts.mode === "network"
      ? networkSensors(this.route, depth, this.opts.sensorCount, this.opts.corridorKm, new Rng(this.opts.seed + 7))
      : singleBuoys(scen.singleBuoys.map((b) => b.at));
    this.index = new SensorIndex(this.sensors, 20);
    this.spacing = spacingKm(this.sensors);
    this.createWhales();
  }

  on(fn: (e: { type: "call"; call: CallEvent } | { type: "decision"; decision: Decision }) => void) {
    this.listeners.push(fn);
  }

  /** Time for the ship (holding course) to reach along-route distance s. */
  private etaHold(s: number): number {
    return ((s - this.s) / (this.opts.baseSpeed * KNOT_KMS)) + this.t;
  }

  private createWhales() {
    const scen = SCENARIOS[this.route.def.id];
    const rng = new Rng(this.opts.seed + 99);
    let id = 1;
    for (const enc of scen.encounters) {
      const cross = this.route.project(toXY(enc.near[0], enc.near[1]));
      const cp = this.route.at(cross.s);
      const eta = this.etaHold(cross.s);
      const sp = SPECIES[enc.species];
      const speedKn = rng.uniform(sp.speedKn[0], sp.speedKn[1]);
      const lead = rng.uniform(1.8, 2.4) * 3600; // whale becomes active this long before the ship arrives
      const side = rng.next() < 0.5 ? 1 : -1;
      const sAlong = rng.next() < 0.5 ? 1 : -1;
      const ang = rng.uniform(0.6, 1.2); // approach the lane at ~35-70 degrees
      const nrm: XY = [cp.dir[1] * side, -cp.dir[0] * side]; // unit normal to the lane (right if side=+1)
      const vec: XY = [nrm[0] * Math.sin(ang) + cp.dir[0] * Math.cos(ang) * sAlong, nrm[1] * Math.sin(ang) + cp.dir[1] * Math.cos(ang) * sAlong];
      const dist = speedKn * KNOT_KMS * lead;
      const target: XY = [cp.p[0] + rng.gauss(0, 0.3), cp.p[1] + rng.gauss(0, 0.3)];
      let start: XY = [target[0] + vec[0] * dist, target[1] + vec[1] * dist];
      const [slon, slat] = toLL(...start);
      if (this.depth.elevation(slon, slat) > -80) start = [target[0] - vec[0] * dist, target[1] - vec[1] * dist];
      this.whales.push(new Whale({
        id: id++, species: enc.species, start, activeFrom: Math.max(0, eta - lead),
        guide: { target, until: eta + rng.uniform(-6, 6) * 60 }, speedKn, conflict: true,
      }, new Rng(rng.int(1, 1e9)), this.depth));
    }
    for (const bg of scen.background) {
      const sp = SPECIES[bg.species];
      this.whales.push(new Whale({
        id: id++, species: bg.species, start: toXY(bg.at[0], bg.at[1]), activeFrom: 0,
        speedKn: rng.uniform(sp.speedKn[0], sp.speedKn[1]), conflict: false,
      }, new Rng(rng.int(1, 1e9)), this.depth));
    }
  }

  /** Scheduled arrival: the time the ship would arrive holding its service speed the whole way. */
  get scheduledArrival(): number {
    return this.route.length / (this.opts.baseSpeed * KNOT_KMS);
  }

  /** Speed needed to arrive on schedule (keeps service speed if on time; capped at 19 kn). */
  scheduleSpeed(): number {
    if (!this.opts.params.keepArrivalTime) return this.opts.baseSpeed;
    const remain = this.route.length - this.s;
    const tLeft = this.scheduledArrival - this.t;
    if (tLeft <= 0) return 19;
    const v = remain / tLeft / KNOT_KMS;
    return Math.min(Math.max(v, this.opts.baseSpeed), 19);
  }

  get shipXY(): XY {
    return shipPos(this.route, this.plan, this.s);
  }
  get shipSpeed(): number {
    return speedAt(this.plan, this.s);
  }
  get shipHeading(): number {
    return shipHeading(this.route, this.plan, this.s);
  }
  get progress(): number {
    return this.s / this.route.length;
  }
  get meanErrorKm(): number {
    return this.stats.fixes ? this.stats.errSum / this.stats.fixes : NaN;
  }

  /** Fuel the ship would burn holding course the whole way (baseline). */
  get baselineFuel(): number {
    const hours = this.route.length / (this.opts.baseSpeed * KNOT_KMS) / 3600;
    return fuelRateTph(this.opts.ship, this.opts.baseSpeed) * hours;
  }

  step(dtTotal: number) {
    if (this.finished) return;
    let left = dtTotal;
    while (left > 1e-6 && !this.finished) {
      const dt = Math.min(left, 10);
      this.substep(dt);
      left -= dt;
    }
  }

  private substep(dt: number) {
    const t = this.t;
    // whales + calls
    for (const w of this.whales) {
      const callT = w.step(t, dt);
      if (callT !== null) this.processCall(w, callT);
    }
    // ship
    const v = this.shipSpeed;
    const ds0 = 0.2;
    const d1 = offsetAt(this.plan, this.s + ds0) - offsetAt(this.plan, this.s);
    const stretch = Math.sqrt(1 + (d1 / ds0) ** 2);
    this.s = Math.min(this.s + (v * KNOT_KMS * dt) / stretch, this.route.length);
    this.fuelUsed += (fuelRateTph(this.opts.ship, v) * dt) / 3600;
    this.t += dt;
    if (this.maneuver && this.s > this.maneuver.endS) {
      this.maneuver = null;
      this.plan = { baseSpeed: this.scheduleSpeed(), zones: [], offset: null };
    }
    if (this.s >= this.route.length - 1e-6) this.finished = true;
    // ground truth (hindsight only - never used by the decision engine): closest approach to each whale
    const sp = this.shipXY;
    for (const w of this.whales) {
      if (!w.active(this.t)) continue;
      const d = Math.hypot(w.x - sp[0], w.y - sp[1]);
      if (d < w.cpaKm) {
        w.cpaKm = d;
        w.cpaSpeed = v;
        w.cpaT = this.t;
      }
    }
    // decisions
    const every = this.maneuver ? 300 : 120;
    if (this.t - this.lastDecisionCheck >= every) {
      this.lastDecisionCheck = this.t;
      this.checkDecisions();
    }
    if (Math.floor(this.t / 60) !== Math.floor((this.t - dt) / 60)) this.tracker.prune(this.t);
  }

  private processCall(w: Whale, tCall: number) {
    const sp = SPECIES[w.species];
    const src: XY = [w.x, w.y];
    const R = nominalRangeKm(sp) * 1.5;
    const ship = this.shipXY;
    const shipSL = shipSourceLevel(this.shipSpeed) + shipBandOffset(sp);
    const detected: { sensor: Sensor; snr: number; t: number }[] = [];
    for (const s of this.index.within(src, R)) {
      const r = Math.hypot(s.pos[0] - src[0], s.pos[1] - src[1]);
      const rl = sp.sourceLevel - transmissionLoss(r);
      const dShip = Math.hypot(s.pos[0] - ship[0], s.pos[1] - ship[1]);
      const shipRl = shipSL - 20 * Math.log10(Math.max(dShip * 1000, 10));
      const nl = 10 * Math.log10(10 ** (sp.bandNoise / 10) + 10 ** (shipRl / 10));
      const snr = rl - nl + this.rng.gauss(0, 1.5);
      if (this.rng.next() < detectionProbability(snr)) {
        detected.push({ sensor: s, snr, t: tCall + r / this.cTrue + this.rng.gauss(0, this.opts.sigmaT) });
      }
    }
    detected.sort((a, b) => b.snr - a.snr);
    const ev: CallEvent = {
      id: ++this.callSeq, t: tCall, whaleId: w.id, species: w.species, truePos: src,
      detected: detected.map((d) => ({ sensor: d.sensor, snr: d.snr })),
    };
    this.stats.calls++;
    this.stats.detections += detected.length;
    if (this.opts.mode === "network") {
      if (detected.length >= 3) {
        const top = detected.slice(0, 12).map((d) => ({ pos: d.sensor.pos, t: d.t, snr: d.snr }));
        const fix = locate(top, SOUND_SPEED_KMS, this.opts.sigmaT);
        if (fix.ok) {
          const tr = this.tracker.addFix(fix, tCall);
          (tr as Track & { species?: SpeciesId }).species = w.species; // species comes from the call type (frequency)
          ev.fix = fix;
          ev.trackId = tr.id;
          ev.errorKm = Math.hypot(fix.x - src[0], fix.y - src[1]);
          this.stats.fixes++;
          this.stats.errSum += ev.errorKm;
        }
      }
    } else if (detected.length) {
      const b = detected[0].sensor;
      this.zones.set(b.id, { buoyId: b.id, cx: b.pos[0], cy: b.pos[1], r: nominalRangeKm(sp), t: tCall, species: w.species });
    }
    this.calls.push(ev);
    if (this.calls.length > 60) this.calls.shift();
    for (const fn of this.listeners) fn({ type: "call", call: ev });
  }

  /** Beliefs about whales that could matter for the ship in the next ~3 hours. */
  beliefs(): Belief[] {
    const out: Belief[] = [];
    const ahead = this.opts.baseSpeed * KNOT_KMS * 3.2 * 3600;
    const near = (x: number, y: number, margin: number) => {
      const p = this.route.project([x, y]);
      return p.s > this.s - 5 && p.s < this.s + ahead && p.dist < margin;
    };
    if (this.opts.mode === "network") {
      for (const tr of this.tracker.tracks) {
        if (tr.nFixes < 3 || this.t - tr.lastUpdate > 20 * 60) continue;
        const p = predictPosition(tr, this.t);
        if (near(p.x, p.y, 40)) out.push({ kind: "track", track: tr, species: (tr as Track & { species?: SpeciesId }).species ?? "humpback" });
      }
    } else {
      for (const z of this.zones.values()) {
        if (this.t - z.t > 30 * 60) continue;
        if (near(z.cx, z.cy, z.r + 20)) out.push({ kind: "zone", cx: z.cx, cy: z.cy, r: z.r, t: z.t, species: z.species });
      }
    }
    return out;
  }

  private lastAnnounce: { id: string; s: number; t: number } | null = null;

  private announce(d: Decision) {
    this.decisions.push(d);
    this.lastAnnounce = { id: d.chosen.id, s: d.sConflict, t: this.t };
    for (const fn of this.listeners) fn({ type: "decision", decision: d });
  }

  private commit(d: Decision) {
    const endS = Math.max(d.zone[1], d.chosen.plan.offset?.s1 ?? 0, ...d.chosen.plan.zones.map((z) => z.s1)) + 1;
    this.plan = d.chosen.plan;
    this.maneuver = { decision: d, plan: d.chosen.plan, endS };
  }

  private evaluate(b: Belief, keep?: string): Decision | null {
    return decide({
      route: this.route, depth: this.depth, ship: this.opts.ship, shipS: this.s, t: this.t,
      baseSpeed: this.plan.baseSpeed, belief: b, params: { ...this.opts.params, mode: this.opts.mode }, keep,
    });
  }

  private checkDecisions() {
    const bs = this.beliefs();
    if (!bs.length) return;
    let worst: Decision | null = null;
    let bestBelief: Belief | null = null;
    for (const b of bs) {
      const d = this.evaluate(b);
      if (d && (!worst || d.hold.lethalRisk > worst.hold.lethalRisk)) {
        worst = d;
        bestBelief = b;
      }
    }
    if (!worst) return;
    const m = this.maneuver;
    if (m && Math.abs(m.decision.sConflict - worst.sConflict) < 20) {
      // Same conflict, maneuver under way: only change plans for a clear reason (hysteresis).
      const current = worst.options.find((o) => o.id === m.decision.chosen.id);
      const unsafe = current && !current.meetsTarget && worst.chosen.lethalRisk < current.lethalRisk * 0.7;
      const muchCheaper = current && worst.chosen.id !== current.id &&
        worst.chosen.costDeltaUsd < current.costDeltaUsd - Math.max(300, 0.25 * Math.abs(current.costDeltaUsd));
      if (worst.chosen.id !== m.decision.chosen.id && (unsafe || muchCheaper)) {
        this.commit(worst);
        this.announce(worst);
      } else {
        // keep the numbers fresh for the panel, but report the manoeuvre actually being flown
        const refreshed = worst.chosen.id === m.decision.chosen.id ? worst : this.evaluate(bestBelief!, m.decision.chosen.id);
        if (refreshed) m.decision = refreshed;
      }
      return;
    }
    const la = this.lastAnnounce;
    if (worst.chosen.id === "hold") {
      if (!la || Math.abs(la.s - worst.sConflict) > 20 || la.id !== "hold") this.announce(worst);
      return;
    }
    this.commit(worst);
    this.announce(worst);
  }

  /** One entry per conflict: the final assessment when the ship passed it. */
  get conflictLog(): Decision[] {
    const out: Decision[] = [];
    for (const d of this.decisions) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.sConflict - d.sConflict) < 15) out[out.length - 1] = d;
      else out.push(d);
    }
    return out;
  }

  /** Planned track ahead (lon/lat) under the current plan, for drawing. */
  plannedPath(km = 120): [number, number][] {
    const out: [number, number][] = [];
    for (let s = this.s; s <= Math.min(this.s + km, this.route.length); s += 1) out.push(toLL(...shipPos(this.route, this.plan, s)));
    return out;
  }

  /** Hindsight check with the TRUE whale positions (never available to the ship). */
  truth() {
    return this.whales.filter((w) => w.conflict).map((w) => ({
      whaleId: w.id,
      species: w.species,
      cpaKm: w.cpaKm,
      cpaSpeed: w.cpaSpeed,
      lethalProb: Math.exp(-(w.cpaKm ** 2) / (2 * 0.06 ** 2)) * lethality(w.cpaSpeed),
    }));
  }

  summary() {
    const log = this.conflictLog;
    const fuelDelta = this.fuelUsed - this.baselineFuel * this.progress;
    return {
      fuelUsed: this.fuelUsed,
      fuelDelta,
      co2Delta: fuelDelta * CO2_PER_T_FUEL,
      conflicts: log.length,
      maneuvers: log.filter((d) => d.chosen.id !== "hold").length,
      riskHold: log.reduce((a, d) => a + d.hold.lethalRisk, 0),
      riskTaken: log.reduce((a, d) => a + d.chosen.lethalRisk, 0),
      costUsd: log.reduce((a, d) => a + d.chosen.costDeltaUsd, 0),
      lethalAtSpeed: lethality(this.shipSpeed),
      arrivalDelayMin: (this.t - this.scheduledArrival) / 60,
      truth: this.truth(),
    };
  }

  /** Test helper: run until the ship arrives. */
  runToEnd(maxHours = 40) {
    while (!this.finished && this.t < maxHours * 3600) this.step(60);
  }

  // expose for the UI
  integrate = integrate;
}
