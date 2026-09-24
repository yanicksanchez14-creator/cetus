/**
 * Simulated whale: a smooth random walk (heading and speed drift slowly), kept in deep-enough water,
 * optionally "guided" toward a waypoint so the scenario reliably creates a ship-whale conflict.
 * The whale calls at random intervals typical of its species.
 */
import type { Rng } from "./rng";
import { SPECIES, type SpeciesId } from "./physics";
import { KNOT_KMS, toLL, type XY } from "./geo";
import type { DepthModel } from "./bathy";

export interface WhaleInit {
  id: number;
  species: SpeciesId;
  start: XY;
  activeFrom: number; // s (the whale enters the scene / starts calling)
  guide?: { target: XY; until: number }; // steer toward target until time `until`
  speedKn: number;
  conflict: boolean; // part of a designed ship encounter
}

export class Whale {
  readonly id: number;
  readonly species: SpeciesId;
  readonly conflict: boolean;
  x: number;
  y: number;
  heading: number; // radians, 0 = east (math convention)
  speed: number; // km/s
  private meanSpeed: number;
  activeFrom: number;
  nextCall: number;
  guide?: { target: XY; until: number };
  trail: { t: number; x: number; y: number }[] = [];
  nCalls = 0;
  // ground truth bookkeeping (hindsight only)
  cpaKm = Infinity;
  cpaSpeed = 0;
  cpaT = 0;

  constructor(init: WhaleInit, private rng: Rng, private depth: DepthModel) {
    this.id = init.id;
    this.species = init.species;
    this.conflict = init.conflict;
    [this.x, this.y] = init.start;
    this.activeFrom = init.activeFrom;
    this.guide = init.guide;
    this.meanSpeed = init.speedKn * KNOT_KMS;
    this.speed = this.meanSpeed;
    this.heading = init.guide
      ? Math.atan2(init.guide.target[1] - this.y, init.guide.target[0] - this.x)
      : rng.uniform(-Math.PI, Math.PI);
    const [a, b] = SPECIES[this.species].callIntervalS;
    this.nextCall = this.activeFrom + rng.uniform(0, b - a);
  }

  active(t: number): boolean {
    return t >= this.activeFrom;
  }

  private deepEnough(x: number, y: number): boolean {
    const [lon, lat] = toLL(x, y);
    return this.depth.elevation(lon, lat) < -60;
  }

  /** Advance dt seconds. Returns true if the whale made a call during this step (time in `callTime`). */
  step(t: number, dt: number): number | null {
    if (!this.active(t)) return null;
    const rng = this.rng;
    // heading drift (random turning), stronger pull toward the guide target if any
    this.heading += rng.gauss(0, 0.012 * Math.sqrt(dt));
    if (this.guide && t < this.guide.until) {
      const want = Math.atan2(this.guide.target[1] - this.y, this.guide.target[0] - this.x);
      let d = want - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * Math.min(1, 0.004 * dt);
      const togo = Math.hypot(this.guide.target[0] - this.x, this.guide.target[1] - this.y);
      const timeLeft = Math.max(this.guide.until - t, 60);
      // adjust speed so the whale arrives around the planned time (bounded to realistic speeds)
      const want_v = Math.min(Math.max(togo / timeLeft, 0.4 * this.meanSpeed), 1.8 * this.meanSpeed);
      this.speed += (want_v - this.speed) * Math.min(1, 0.002 * dt);
    } else {
      // Ornstein-Uhlenbeck speed around the species' mean
      this.speed += (this.meanSpeed - this.speed) * Math.min(1, 0.001 * dt) + rng.gauss(0, 0.00003 * Math.sqrt(dt));
      this.speed = Math.max(0.2 * this.meanSpeed, Math.min(this.speed, 2 * this.meanSpeed));
    }
    // keep off the shelf edge / land: if the next position is too shallow, turn toward deeper water
    let nx = this.x + Math.cos(this.heading) * this.speed * dt;
    let ny = this.y + Math.sin(this.heading) * this.speed * dt;
    if (!this.deepEnough(nx, ny)) {
      for (const turn of [0.5, -0.5, 1, -1, 1.6, -1.6, Math.PI]) {
        const h = this.heading + turn;
        const tx = this.x + Math.cos(h) * this.speed * dt;
        const ty = this.y + Math.sin(h) * this.speed * dt;
        if (this.deepEnough(tx, ty)) {
          this.heading = h;
          nx = tx;
          ny = ty;
          break;
        }
      }
      if (!this.deepEnough(nx, ny)) {
        nx = this.x;
        ny = this.y;
      }
    }
    this.x = nx;
    this.y = ny;
    const last = this.trail[this.trail.length - 1];
    if (!last || t - last.t > 30) {
      this.trail.push({ t, x: this.x, y: this.y });
      if (this.trail.length > 360) this.trail.shift();
    }
    if (t + dt >= this.nextCall) {
      const callTime = Math.max(this.nextCall, t);
      const [a, b] = SPECIES[this.species].callIntervalS;
      this.nextCall = callTime + rng.uniform(a, b);
      this.nCalls++;
      return callTime;
    }
    return null;
  }
}
