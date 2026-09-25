/**
 * The map app: renders the simulation with deck.gl, runs the animation loop, and wires up the controls.
 * The simulation itself runs in a Web Worker (see ../worker/sim.worker.ts).
 */
import { Deck, MapView, COORDINATE_SYSTEM, type MapViewState } from "@deck.gl/core";
import { BitmapLayer, PathLayer, ScatterplotLayer, IconLayer, TextLayer, PolygonLayer } from "@deck.gl/layers";
import { PathStyleExtension } from "@deck.gl/extensions";
import SimWorker from "../worker/sim.worker.ts?worker&inline";
import { reliefImages, mapLines, loadDepthGrids } from "./assets";
import { DepthModel, type DepthGrid } from "../engine/bathy";
import type { Decision } from "../engine/decision";
import { SPECIES, lethality, nominalRangeKm, type SpeciesId } from "../engine/physics";
import { HOTSPOTS } from "../engine/scenario";
import type { FromWorker, Snapshot, SnapCall, EllipseLL, InitReply } from "../worker/protocol";
import { renderDecision, renderVoyage, renderMethod, renderStory, clock, tripLine } from "./panel";
import { ii, initInfo } from "./info";
import { FleetLab } from "./lab";

type RGBA = [number, number, number, number];
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SHIP_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="160" viewBox="0 0 64 160"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#cfe0ee"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#b7cadb"/></linearGradient></defs><path d="M32 3 C45 22 51 44 51 70 L51 148 Q32 157 13 148 L13 70 C13 44 19 22 32 3Z" fill="url(#g)" stroke="#5fe1ff" stroke-width="3"/><rect x="19" y="114" width="26" height="20" rx="3" fill="#7f98ae"/><rect x="21" y="40" width="22" height="64" rx="2" fill="#dbe7f1" stroke="#9fb4c8" stroke-width="1.5"/></svg>`,
)}`;
const TRAFFIC_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="80" viewBox="0 0 32 80"><path d="M16 2 C23 12 26 24 26 38 L26 74 Q16 79 6 74 L6 38 C6 24 9 12 16 2Z" fill="#9fb3c6" stroke="#0a1726" stroke-width="3"/></svg>`,
)}`;
const EST_WHALE_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="100" viewBox="0 0 40 100"><path d="M20 4 C30 6 33 22 33 40 C33 60 28 74 23 84 L33 94 L20 90 L7 94 L17 84 C12 74 7 60 7 40 C7 22 10 6 20 4Z" fill="rgba(255,207,110,0.28)" stroke="#ffcf6e" stroke-width="3.5"/></svg>`,
)}`;
const WHALE_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="100" viewBox="0 0 40 100"><path d="M20 4 C30 6 33 22 33 40 C33 60 28 74 23 84 L33 94 L20 90 L7 94 L17 84 C12 74 7 60 7 40 C7 22 10 6 20 4Z" fill="#ffc987" stroke="#fff3e0" stroke-width="2"/></svg>`,
)}`;

const LABELS: { text: string; at: [number, number]; kind: "place" | "sea" | "port" }[] = [
  { text: "San Francisco", at: [-122.42, 37.77], kind: "place" },
  { text: "Oakland", at: [-122.27, 37.81], kind: "port" },
  { text: "Monterey Bay", at: [-121.93, 36.8], kind: "sea" },
  { text: "Big Sur", at: [-121.62, 36.2], kind: "place" },
  { text: "Point Conception", at: [-120.45, 34.5], kind: "place" },
  { text: "Channel Islands", at: [-119.9, 33.93], kind: "sea" },
  { text: "Los Angeles", at: [-118.25, 34.05], kind: "place" },
  { text: "Long Beach", at: [-118.19, 33.77], kind: "port" },
  { text: "Farallon Islands", at: [-123.0, 37.7], kind: "sea" },
  { text: "Monterey Canyon", at: [-122.2, 36.65], kind: "sea" },
  { text: "PACIFIC OCEAN", at: [-124.6, 35.3], kind: "sea" },
];

function ellipsePolygon(e: EllipseLL, scale = 1, n = 48): [number, number][] {
  const kx = 111.32 * Math.cos((e.lat * Math.PI) / 180);
  const ky = 110.574;
  const a = Math.max(e.a * scale, 0.02);
  const b = Math.max(e.b * scale, 0.02);
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const th = (i / n) * 2 * Math.PI;
    const x = a * Math.cos(th) * Math.cos(e.angle) - b * Math.sin(th) * Math.sin(e.angle);
    const y = a * Math.cos(th) * Math.sin(e.angle) + b * Math.sin(th) * Math.cos(e.angle);
    out.push([e.lon + x / kx, e.lat + y / ky]);
  }
  return out;
}

const speciesColor = (sp: SpeciesId, a = 255): RGBA => [...SPECIES[sp].color, a] as RGBA;
const ease = (x: number) => 1 - Math.pow(1 - Math.min(Math.max(x, 0), 1), 3);

interface CallFx { call: SnapCall; t0: number }

/** One label per crowded spot: skip a label that would overlap one already placed (best-tracked whales first). */
function declutter<T extends { lon: number; lat: number; nFixes: number }>(tracks: T[], zoom: number): T[] {
  const kmPerPx = (156.543 * Math.cos((37 * Math.PI) / 180)) / 2 ** zoom;
  const minKm = 150 * kmPerPx; // labels are ~150 px wide, 2 lines apart
  const out: T[] = [];
  for (const t of [...tracks].sort((a, b) => b.nFixes - a.nFixes)) {
    const clash = out.some((o) => Math.abs(o.lon - t.lon) * 88 < minKm && Math.abs(o.lat - t.lat) * 111 < minKm * 0.25);
    if (!clash) out.push(t);
  }
  return out;
}

const MODE_INFO: Record<"ships" | "mix" | "network" | "single", { title: string; what: string; whatIf: string; watch: string }> = {
  ships: {
    title: "Ships as sensors",
    what: "No buoys. Every real ship off California (replayed from AIS data) tows a hydrophone and carries a thermal camera. When 3+ ships hear the same call, they locate the whale together; cameras spot whales surfacing within ~6.5 km.",
    whatIf: "every large ship carried this gear and shared what it hears. Nothing new in the water, but each ship's own noise shortens how far it hears.",
    watch: "Watch for blind spots where no other ship is near: a whale there can only be heard by your own ship, which tells direction and only a rough distance.",
  },
  mix: {
    title: "Mix: ships + 10 port stations",
    what: "Ships as sensors, plus one quiet cabled hydrophone on the seafloor off each major port, from Bodega Bay to Long Beach (like MBARI's MARS observatory off Monterey).",
    whatIf: "ports added ~10 seafloor stations, instead of thousands of buoys. They cover the busy approaches where ships and whales crowd together.",
    watch: "Compare the blind spots and cost with Ships mode.",
  },
  network: {
    title: "Buoy network",
    what: "3,000 hydrophone buoys by default (500-5,000 on the slider), ~3-4 km apart along the lanes. Nearly every call is heard by many buoys, so whales are located to within tens of metres.",
    whatIf: "a dense network like this existed. It's the best case for locating whales, but it would be expensive to build and maintain.",
    watch: "Use the Sensors slider to see how fewer buoys change accuracy.",
  },
  single: {
    title: "Slow zones: what exists today",
    what: "A single listening buoy can only tell that a whale is somewhere within 20-100 km, so the response is a blanket 10-knot zone around it (~15 nm in this app).",
    whatIf: "on the US East Coast, a right whale heard by a buoy triggers a temporary voluntary Slow Zone just like this. In California, voluntary 10-knot zones cover whole regions for the season (May-Jan), and many ships don't slow down.",
    watch: "Here the ship always obeys, so this is today's best case.",
  },
};

export class App {
  private deck!: Deck<MapView>;
  private worker: Worker | null = null;
  private grids: DepthGrid[] = [];
  private depth!: DepthModel;
  private init: InitReply | null = null;
  private snap: Snapshot | null = null;
  private busy = false;
  private pendingDt = 0;
  private playing = false;
  private speed = 300;
  private speedBoostUntil = 0;
  private boostSpeed = 60;
  private lastFrame = performance.now();
  private view: MapViewState = { longitude: -121.1, latitude: 35.75, zoom: 6.35, pitch: 0, bearing: 0 };
  private flight: { from: MapViewState; to: MapViewState; t0: number; dur: number } | null = null;
  private follow = true;
  private showTruth = true;
  private showSensors = true;
  private cine = true;
  private mode: "network" | "ships" | "mix" | "single" = "ships";
  private coverage: { s: number; lon: number; lat: number; hump: number; fin: number }[] = [];
  private wakeV: number[] = [];
  private style: "targeted" | "ahead" = "targeted";
  private caution: "slow" | "ask" | "ignore" = "slow";
  private whaleCount = 8;
  private waiting = false; // paused for a prompt or strike alert
  private wasCautious = false;
  private routeId = "oak-lb";
  private sensorCount = 3000;
  private sigmaMs = 20;
  private seed = 20260924;
  // visuals
  private sensorPos = new Float32Array(0);
  private sensorPhase: Float32Array = new Float32Array(0);
  private sensorFlash = new Float64Array(0);
  private sensorColors = new Uint8Array(0);
  private callFx: CallFx[] = [];
  private fixFx: { e: EllipseLL; t0: number }[] = [];
  private wake: [number, number][] = [];
  private plannedPath: [number, number][] = [];
  // ---- replay: a slim snapshot every sim-minute, plus markers for each decision on the progress bar
  private frames: { t: number; snap: Snapshot; wakeLen: number; wakeEpoch: number; histLen: number; plannedPath: [number, number][] }[] = [];
  private wakeEpoch = 0;
  private replay: { idx: number; playing: boolean; acc: number; shownDecision: Decision | null } | null = null;
  private marks: { p: number; t: number; kind: "shift" | "slow" | "policy" | "strike" | "near" | "seen"; label: string; key?: string }[] = [];
  private lab!: FleetLab;
  /** The snapshot on screen: the live one, or a replay frame. */
  private get shown(): Snapshot | null {
    return this.replay ? this.frames[this.replay.idx]?.snap ?? this.snap : this.snap;
  }
  private history: Decision[] = [];
  private shownDecision: Decision | null = null;
  private renderedDecision: Decision | null = null;
  private spotlight: { d: Decision; t0: number } | null = null;
  private bubble: { html: string; title: string; policy: boolean; until: number } | null = null;
  private seenTracks = new Set<number>();
  private summaryShown = false;
  private skipRequested = false;
  private lastPanelRender = 0;
  private tab = "decision";

  async start() {
    this.grids = await loadDepthGrids();
    this.depth = new DepthModel(this.grids);
    this.deck = new Deck({
      parent: $("map"),
      views: new MapView({ repeat: false }),
      viewState: this.view,
      controller: { doubleClickZoom: true, touchRotate: false, dragRotate: false },
      onViewStateChange: ({ viewState, interactionState }) => {
        const vs = viewState as MapViewState;
        if (interactionState?.isDragging || interactionState?.isPanning) this.setFollow(false);
        this.view = { ...vs };
        this.flight = null;
      },
      onHover: (info) => this.hover(info.coordinate as [number, number] | undefined, info.x, info.y),
      getCursor: ({ isDragging }) => (isDragging ? "grabbing" : "crosshair"),
      layers: [],
      useDevicePixels: true,
    });
    this.bindUi();
    renderMethod($("tab-method"));
    renderStory($("tab-story"));
    this.restart();
    requestAnimationFrame(this.frame);
  }

  // ------------------------------------------------------------------ worker
  private restart(newSeed = false) {
    if (newSeed) this.seed = Math.floor(Math.random() * 1e9);
    this.worker?.terminate();
    this.worker = new SimWorker();
    this.busy = true;
    this.pendingDt = 0;
    this.snap = null;
    this.init = null;
    this.history = [];
    this.shownDecision = null;
    this.spotlight = null;
    this.bubble = null;
    this.callFx = [];
    this.fixFx = [];
    this.wake = [];
    this.wakeV = [];
    this.wakeEpoch++;
    this.frames = [];
    this.marks = [];
    this.renderMarks();
    this.exitReplay(false);
    this.seenTracks.clear();
    this.summaryShown = false;
    $("summary").hidden = true;
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onWorker(ev.data);
    this.worker.postMessage({
      type: "init",
      grids: this.grids.map((g) => ({ ...g, z: g.z.slice() })),
      options: {
        seed: this.seed, routeId: this.routeId, mode: this.mode, style: this.style, caution: this.caution, extraWhales: this.whaleCount - 3, sensorCount: this.sensorCount, sigmaT: this.sigmaMs / 1000,
      },
    });
    $("routeName").textContent = this.routeId === "oak-lb" ? "Oakland → Long Beach" : "Oakland → Asia (westbound)";
    const chip = $("modeChip");
    chip.textContent = this.mode === "single" ? "Slow zones · what exists today" : this.mode === "ships" ? "Ships as sensors" : this.mode === "mix" ? "Mix · ships + port stations" : this.style === "ahead" ? "Buoy network · plan ahead" : "Buoy network";
    chip.className = `chip ${this.mode === "single" ? "chip-single" : "chip-net"}`;
    renderDecision($("tab-decision"), null, []);
    this.waiting = false;
    this.wasCautious = false;
    this.coverage = [];
    $("cautionCard").hidden = true;
    $("strike").hidden = true;
    $("avoided").hidden = true;
    this.renderLegend();
  }

  private onWorker(msg: FromWorker) {
    if (msg.type === "ready") {
      this.init = msg;
      const n = msg.sensors.lon.length;
      this.sensorPos = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        this.sensorPos[2 * i] = msg.sensors.lon[i];
        this.sensorPos[2 * i + 1] = msg.sensors.lat[i];
      }
      this.sensorPhase = new Float32Array(msg.sensors.phase);
      this.sensorFlash = new Float64Array(n).fill(-1e9);
      this.sensorColors = new Uint8Array(n * 4);
      this.progressMarks();
      return;
    }
    this.busy = false;
    const s = msg as Snapshot;
    const now = performance.now();
    if (s.plannedPath) this.plannedPath = s.plannedPath;
    const last = this.wake[this.wake.length - 1];
    if (!last || Math.hypot(last[0] - s.ship.lon, last[1] - s.ship.lat) > 0.004) {
      this.wake.push([s.ship.lon, s.ship.lat]);
      this.wakeV.push(s.ship.speed);
      if (this.wake.length > 8000) { this.wake.shift(); this.wakeV.shift(); this.wakeEpoch++; }
    }
    for (const c of s.calls) {
      this.callFx.push({ call: c, t0: now });
      for (const id of c.sensors) if (id < this.sensorFlash.length) this.sensorFlash[id] = now;
      if (c.fix) this.fixFx.push({ e: c.fix, t0: now });
    }
    if (this.callFx.length > 80) this.callFx.splice(0, this.callFx.length - 80);
    if (this.fixFx.length > 120) this.fixFx.splice(0, this.fixFx.length - 120);
    for (const tr of s.tracks) {
      if (!this.seenTracks.has(tr.id) && tr.nFixes >= 3) {
        this.seenTracks.add(tr.id);
        this.toast(`${SPECIES[tr.species].name} located · ±${Math.max(10, Math.round(tr.now.a * 1000 / 2.45))} m · tracking`, "");
      }
    }
    for (const d of s.decisions) this.onDecision(d, now);
    if (s.coverage.length) this.coverage.push(...s.coverage);
    // precautionary slow-down (heard, not located)
    if (s.cautionActive && !this.wasCautious) {
      this.toast("Whale heard ahead, not located · slowing to 13 kn", "warn");
      this.marks.push({ p: s.ship.progress, t: s.t, kind: "slow", label: `${clock(s.t).slice(-5)} · Precaution: whale heard ahead, slowed to 13 kn` });
      this.renderMarks();
    }
    this.wasCautious = s.cautionActive;
    if (s.cautionPrompt && !this.waiting) {
      const p = s.cautionPrompt;
      this.waiting = true;
      $("ccTitle").textContent = `${SPECIES[p.species].name} heard ahead`;
      $("ccBody").innerHTML = `Our towed hydrophone hears it about <b>${p.relBearingDeg}° off the bow</b> (port or starboard, it can't tell) and,
        from how loud it is, probably within <b>~${Math.max(1, Math.round(p.maxRangeKm))} km</b>, but nobody has located it yet. Slow to 13 kn until it's passed (up to ~6.5 km)?
        <br><span class="muted">Cost ≈ ${p.costUsd < 0 ? "−" : ""}$${Math.round(Math.abs(p.costUsd)).toLocaleString("en-US")} (fuel saved vs +${Math.round(p.extraMin)} min lost) · a strike at 13 kn is ~${Math.round(lethality(13) * 100)}% lethal vs ~${Math.round(lethality(16) * 100)}% at 16 kn.</span>`;
      $("cautionCard").hidden = false;
    }
    for (const nm of s.nearMisses) {
      // every close call gets the pop-up now (encounters are random; there is no scripted whale any more)
      this.waiting = true;
      this.marks.push({ p: s.ship.progress, t: s.t, kind: "near", label: `${clock(s.t).slice(-5)} · Close call: ${SPECIES[nm.species].name.toLowerCase()} ${nm.distM} m away` });
      this.renderMarks();
      $("avoidedTitle").textContent = nm.deep ? "UNDER THE HULL" : "CLOSE CALL";
      $("avoidedSub").textContent = `${SPECIES[nm.species].name} · passed ${nm.distM} m from the ship's track${nm.deep ? ", under the hull" : ""} at ${nm.speedKn.toFixed(0)} knots`;
      $("avoidedBody").innerHTML = nm.deep
        ? `It passed right under the ship but was deep enough not to be hit. Whales spend much of their time near the surface, so this was luck.`
        : nm.speedKn < 14.5
          ? `The ship had slowed to <b>${nm.speedKn.toFixed(0)} knots</b>. A strike needs the whale within ~45 m of the hull; at this speed a hit is also less likely to kill.`
          : `A strike needs the whale within ~45 m of the hull. ${this.snap?.activeDecision ? "The ship's course change kept it clear." : "Nobody had located this whale close enough to act on."}`;
      $("avoided").hidden = false;
    }
    if (s.strikes.length) {
      const k = s.strikes[s.strikes.length - 1];
      this.waiting = true;
      $("strikeSub").textContent = `${SPECIES[k.species].name} · hit at ${k.speedKn.toFixed(1)} knots`;
      $("strikeBody").innerHTML = k.lethal
        ? `At this speed a strike is fatal about ${Math.round(k.pLethal * 100)}% of the time, and this one was <b>fatal</b>. Most ships never notice.`
        : `At this speed a strike is fatal about ${Math.round(k.pLethal * 100)}% of the time. This whale <b>survived, injured</b>.`;
      $("strike").hidden = false;
    }
    const jumped = this.snap && Math.hypot(this.snap.ship.lon - s.ship.lon, this.snap.ship.lat - s.ship.lat) > 0.3;
    this.snap = s;
    this.recordFrame(s);
    for (const d of s.decisions) this.addMark(d, s);
    for (const k of s.strikes) this.marks.push({ p: s.ship.progress, t: k.t, kind: "strike", label: `Whale struck · ${clock(k.t)}` });
    if (s.decisions.length || s.strikes.length) this.renderMarks();
    if (jumped && this.follow) this.flyTo(s.ship.lon, s.ship.lat, Math.max(this.view.zoom, 8.3), 1400);
    if (s.activeDecision) {
      this.shownDecision = s.activeDecision;
      // keep the ship's bubble in step with the refreshed numbers of the manoeuvre being flown
      if (this.bubble?.until === Infinity) this.bubble = this.maneuverBubble(s.activeDecision);
    }
    if (s.finished && !this.summaryShown) {
      this.summaryShown = true;
      this.playing = false;
      this.syncPlay();
      this.showSummary(s);
    }
  }

  private maneuverBubble(d: Decision) {
    const policy = d.chosen.id === "policy";
    const [first, ...rest] = d.bubble.split(" · ");
    return {
      title: policy ? "Whale heard · position unknown" : `${SPECIES[d.species].name} located ahead`,
      html: `<span class="hl">${first}</span>${rest.length ? " · " + rest.join(" · ") : ""}`,
      policy, until: Infinity,
    };
  }

  private onDecision(d: Decision, now: number) {
    this.history.push(d);
    this.shownDecision = d;
    const sp = SPECIES[d.species].name;
    if (d.chosen.id === "hold") {
      this.bubble = d.waitForInfo
        ? { title: `${sp} tracked ~${Math.max(1, Math.round(d.aheadMin))} min ahead`, html: d.turnLater
            ? d.turnLater.kind === "slow"
              ? `No need to slow yet: <span class="hl">${d.turnLater.v} kn</span> would do, starting in ~${Math.max(1, Math.round(d.turnLater.inMin))} min if still needed`
              : `No need to turn yet: a <span class="hl">${d.turnLater.km} km shift</span> would do, starting in ~${Math.max(1, Math.round(d.turnLater.inMin))} min if still needed`
            : `Too early to act: <span class="hl">keep listening</span> as the forecast sharpens`, policy: false, until: now + 6000 }
        : { title: "Whale ahead · clear", html: `${sp} near the lane — likely clear of our track. <span class="hl">Holding course.</span>`, policy: false, until: now + 6000 };
      this.toast(d.waitForInfo ? `${sp} ~${Math.max(1, Math.round(d.aheadMin))} min ahead · no need to act yet` : `${sp} near the lane — clear, holding course`, "warn");
    } else {
      this.bubble = this.maneuverBubble(d);
      this.spotlight = { d, t0: now };
      this.toast(d.chosen.id === "policy" ? d.chosen.label : `${/slow|yield/.test(d.chosen.id) && d.chosen.id !== "turn2slow12" ? "Speed change" : "Route change"}: ${d.chosen.label}`, "dec");
      if (this.cine) this.speedBoostUntil = now + 9000;
      if (!this.follow) this.flyTo(this.snap?.ship.lon ?? this.view.longitude, this.snap?.ship.lat ?? this.view.latitude, Math.max(this.view.zoom, 8.2));
      this.tab = "decision";
      this.selectTab("decision");
    }
    renderDecision($("tab-decision"), d, this.history);
    this.renderedDecision = d;
  }

  // ------------------------------------------------------------------ loop
  private frame = (now: number) => {
    const dtReal = Math.min(now - this.lastFrame, 100) / 1000;
    this.lastFrame = now;
    const speed = now < this.speedBoostUntil ? Math.min(this.boostSpeed, this.speed) : this.speed;
    if (this.waiting) {
      this.pendingDt = 0;
    } else if (this.skipRequested && !this.busy && this.init && this.snap && !this.snap.finished) {
      this.skipRequested = false;
      this.busy = true;
      this.pendingDt = 0;
      this.callFx = [];
      this.wake = [];
      this.wakeV = [];
      this.wakeEpoch++;
      this.worker!.postMessage({ type: "skip" });
    } else if (this.playing && this.init && this.snap && !this.snap.finished) {
      this.pendingDt += dtReal * speed;
      if (!this.busy && this.pendingDt > 0) {
        this.busy = true;
        this.worker!.postMessage({ type: "step", dt: Math.min(this.pendingDt, 1800) });
        this.pendingDt = 0;
      }
    }
    if (this.replay?.playing && this.frames.length) {
      this.replay.acc += (dtReal * this.speed) / 60; // frames are ~1 sim-minute apart
      const step = Math.floor(this.replay.acc);
      if (step > 0) {
        this.replay.acc -= step;
        this.setReplayIdx(Math.min(this.replay.idx + step, this.frames.length - 1));
        if (this.replay.idx >= this.frames.length - 1) { this.replay.playing = false; this.syncReplay(); }
      }
    }
    this.updateCamera(now);
    this.render(now);
    requestAnimationFrame(this.frame);
  };

  private updateCamera(now: number) {
    if (this.flight) {
      const f = this.flight;
      const k = ease((now - f.t0) / f.dur);
      this.view = {
        ...this.view,
        longitude: f.from.longitude + (f.to.longitude - f.from.longitude) * k,
        latitude: f.from.latitude + (f.to.latitude - f.from.latitude) * k,
        zoom: f.from.zoom + (f.to.zoom - f.from.zoom) * k,
      };
      if (k >= 1) this.flight = null;
    } else if (this.follow && this.shown && (this.playing || this.replay?.playing)) {
      const s = this.shown.ship;
      // keep a little more water visible ahead of the ship
      const h = (s.heading * Math.PI) / 180;
      const ahead = 0.1 * Math.pow(2, 8.3 - this.view.zoom);
      const tx = s.lon + (Math.sin(h) * ahead) / Math.cos((s.lat * Math.PI) / 180);
      const ty = s.lat + Math.cos(h) * ahead * 0.8;
      const [fx, fy] = this.framed(tx, ty, this.view.zoom);
      const k = 0.08;
      this.view = { ...this.view, longitude: this.view.longitude + (fx - this.view.longitude) * k, latitude: this.view.latitude + (fy - this.view.latitude) * k };
    }
    this.deck.setProps({ viewState: this.view });
  }

  private flyTo(lon: number, lat: number, zoom: number, dur = 1600) {
    const [fx, fy] = this.framed(lon, lat, zoom);
    this.flight = { from: { ...this.view }, to: { ...this.view, longitude: fx, latitude: fy, zoom }, t0: performance.now(), dur };
  }

  /** Map centre that puts (lon, lat) in the middle of the area not covered by the panels. */
  private framed(lon: number, lat: number, zoom: number): [number, number] {
    const W = window.innerWidth, H = window.innerHeight;
    const phone = W <= 640;
    const top = document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 0;
    const bottom = phone ? $("dock").getBoundingClientRect().top : H;
    const right = phone ? W : $("panel").getBoundingClientRect().left;
    const dx = right / 2 - W / 2, dy = (top + bottom) / 2 - H / 2;
    const degPerPx = 360 / (512 * Math.pow(2, zoom));
    return [lon - dx * degPerPx, lat + dy * degPerPx * Math.cos((lat * Math.PI) / 180)];
  }

  // ------------------------------------------------------------------ layers
  private render(now: number) {
    const layers: unknown[] = [];
    // relief (overview first, then detailed hotspot maps with feathered edges)
    for (const img of reliefImages) {
      layers.push(new BitmapLayer({
        id: `relief-${img.name}`, image: img.url, bounds: img.bounds,
        _imageCoordinateSystem: COORDINATE_SYSTEM.LNGLAT, textureParameters: { minFilter: "linear", magFilter: "linear" },
      } as any));
    }
    layers.push(new PathLayer({
      id: "contours", data: mapLines.filter((l) => l.level < 0), getPath: (d: any) => d.path,
      getColor: (d: any) => (d.level === -200 ? [170, 225, 240, 55] : [170, 210, 240, 26]),
      getWidth: (d: any) => (d.level === -200 ? 1 : 0.7), widthUnits: "pixels",
    }));
    layers.push(new PathLayer({
      id: "coast-glow", data: mapLines.filter((l) => l.level === 0), getPath: (d: any) => d.path,
      getColor: [95, 225, 255, 28], getWidth: 5, widthUnits: "pixels",
    }));
    layers.push(new PathLayer({
      id: "coast", data: mapLines.filter((l) => l.level === 0), getPath: (d: any) => d.path,
      getColor: [160, 225, 240, 150], getWidth: 1, widthUnits: "pixels",
    }));
    layers.push(new TextLayer({
      id: "labels", data: LABELS, getPosition: (d: any) => d.at, getText: (d: any) => d.text,
      getSize: (d: any) => (d.text === "PACIFIC OCEAN" ? 13 : d.kind === "port" ? 11.5 : 11),
      getColor: (d: any) => (d.kind === "sea" ? [140, 190, 215, 150] : d.kind === "port" ? [230, 240, 248, 220] : [175, 190, 205, 170]),
      fontFamily: "Inter, system-ui, sans-serif", fontWeight: 500, characterSet: "auto",
      getTextAnchor: "middle", getAlignmentBaseline: "center", outlineWidth: 3, outlineColor: [2, 9, 18, 200],
      fontSettings: { sdf: true, fontSize: 48, buffer: 10, radius: 10 }, billboard: true,
    }));
    layers.push(new TextLayer({
      id: "hotspots", data: HOTSPOTS, getPosition: (d: any) => d.at, getText: (d: any) => d.label.toUpperCase(),
      getSize: 10, getColor: [255, 184, 108, 150], fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600,
      characterSet: "auto", getPixelOffset: [0, -14], outlineWidth: 3, outlineColor: [2, 9, 18, 200], fontSettings: { sdf: true, fontSize: 48, buffer: 10, radius: 10 },
    }));
    if (this.init) {
      layers.push(new PathLayer({
        id: "lane", data: [{ path: this.init.route }], getPath: (d: any) => d.path, getColor: [220, 235, 245, 70],
        getWidth: 1.5, widthUnits: "pixels", getDashArray: [6, 5], dashJustified: true,
        extensions: [new PathStyleExtension({ dash: true })],
      } as any));
    }
    // blind spots ahead: faint patches where a whale couldn't be located right now (red: none; yellow: only loud whales)
    const ah = this.shown?.ahead;
    if (ah && ah.length && this.mode !== "single") {
      layers.push(new ScatterplotLayer({
        id: "blind-ahead", data: ah, getPosition: (d: any) => [d.lon, d.lat], getRadius: 1400, radiusUnits: "meters", radiusMaxPixels: 22,
        getFillColor: (d: any) => (d.fin < 3 ? [255, 90, 100, 34] : [255, 207, 110, 28]), stroked: false,
        updateTriggers: { getFillColor: ah.length },
      }));
    }
    // port stations (mix mode)
    const stns = this.init?.stations;
    if (stns && this.mode === "mix") {
      layers.push(new ScatterplotLayer({
        id: "stations", data: stns, getPosition: (d: any) => [d.lon, d.lat], radiusUnits: "pixels", getRadius: 6, stroked: true,
        getFillColor: [95, 225, 255, 200], getLineColor: [230, 250, 255, 255], lineWidthUnits: "pixels", getLineWidth: 1.5,
      }));
      layers.push(new TextLayer({
        id: "station-names", data: stns, getPosition: (d: any) => [d.lon, d.lat], getText: (d: any) => d.name, getSize: 10.5,
        getColor: [150, 235, 255, 230], getPixelOffset: [0, -14], fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600, characterSet: "auto",
        outlineWidth: 3, outlineColor: [2, 9, 18, 220], fontSettings: { sdf: true, fontSize: 48, buffer: 10, radius: 10 },
      }));
    }
    // real ships (ships-as-sensors mode): dots by class, ringed while their hydrophone/camera contributes
    const tf = this.shown?.traffic;
    if (tf && tf.lon.length) {
      const data = tf.lon.map((lon, i) => ({ p: [lon, tf.lat[i]], h: tf.heard[i] }));
      layers.push(new ScatterplotLayer({
        id: "traffic-halo", data: data.filter((d) => d.h < 600), getPosition: (d: any) => d.p, radiusUnits: "pixels",
        getRadius: (d: any) => 7 + 5 * (d.h / 600), stroked: true, filled: false, lineWidthUnits: "pixels", getLineWidth: 1.2,
        getLineColor: (d: any) => [120, 235, 255, 200 * (1 - d.h / 600)], updateTriggers: { getRadius: now, getLineColor: now },
      }));
      // real ships drawn as small grey hulls pointing where they're going (whales are orange whale shapes)
      layers.push(new IconLayer({
        id: "traffic", data: data.map((d, i) => ({ ...d, hdg: tf.hdg[i] })), getPosition: (d: any) => d.p,
        getIcon: () => ({ url: TRAFFIC_SVG, width: 32, height: 80, anchorY: 40 }), getSize: 15, sizeUnits: "pixels",
        getAngle: (d: any) => (Number.isFinite(d.hdg) ? -d.hdg : 0), opacity: 0.9,
      }));
    }
    // sensors
    const n = this.sensorPhase.length;
    if (this.showSensors && (n || this.mode === "ships" || this.mode === "mix")) {
      const col = this.sensorColors;
      const tt = now / 1000;
      const zoomBoost = Math.min(1, Math.max(0.45, (this.view.zoom - 5.5) / 3));
      for (let i = 0; i < n; i++) {
        const age = (now - this.sensorFlash[i]) / 1000;
        const tw = 0.5 + 0.5 * Math.sin(tt * 1.7 + this.sensorPhase[i] * 3);
        if (age < 1.5) {
          const k = 1 - age / 1.5;
          col[4 * i] = 80 + 90 * k; col[4 * i + 1] = 175 + 70 * k; col[4 * i + 2] = 210 + 45 * k; col[4 * i + 3] = (80 + 120 * k) * zoomBoost + 40 * k;
        } else {
          col[4 * i] = 70; col[4 * i + 1] = 160; col[4 * i + 2] = 195; col[4 * i + 3] = (40 + 60 * tw) * zoomBoost;
        }
      }
      layers.push(new ScatterplotLayer({
        id: "sensors",
        data: { length: n, attributes: { getPosition: { value: this.sensorPos, size: 2 }, getFillColor: { value: col, size: 4, normalized: true } } } as any,
        getRadius: 1, radiusUnits: "pixels", radiusScale: this.view.zoom > 9 ? 1.9 : this.view.zoom > 7.5 ? 1.5 : 1.1, radiusMinPixels: 0.8, stroked: false,
      }));
      // triangulation: lines from the buoys used to the located position (fades in ~1.3 s)
      const tri: { from: [number, number]; to: [number, number]; age: number }[] = [];
      for (const fx of this.callFx) {
        const age = (now - fx.t0) / 1000;
        if (age > 1.3 || !fx.call.fix) continue;
        if (fx.call.from) for (const f of fx.call.from.slice(0, 8)) tri.push({ from: f, to: [fx.call.fix.lon, fx.call.fix.lat], age });
        else for (const id of fx.call.sensors.slice(0, 8)) tri.push({ from: [this.sensorPos[2 * id], this.sensorPos[2 * id + 1]], to: [fx.call.fix.lon, fx.call.fix.lat], age });
      }
      layers.push(new PathLayer({
        id: "tri", data: tri, getPath: (d: any) => [d.from, d.to], widthUnits: "pixels", getWidth: 1,
        getColor: (d: any) => [120, 235, 255, 150 * (1 - d.age / 1.3)], updateTriggers: { getColor: now },
      }));
      layers.push(new ScatterplotLayer({
        id: "tri-nodes", data: tri, getPosition: (d: any) => d.from, stroked: true, filled: false, radiusUnits: "pixels",
        getRadius: (d: any) => 2.5 + 5 * ease(d.age / 1.3), getLineColor: (d: any) => [150, 240, 255, 220 * (1 - d.age / 1.3)],
        lineWidthUnits: "pixels", getLineWidth: 1, updateTriggers: { getRadius: now, getLineColor: now },
      }));
    }
    const s = this.shown;
    if (s) {
      // call wavefronts (drawn from the TRUE position: simulation view)
      if (this.showTruth) {
        // big, slow "song" pulses: each whale sends one ring every ~7 s that grows to its hearing range over ~5 s
        const PERIOD = 7, GROW = 5;
        const songs = s.whales.filter((w) => w.active).map((w) => {
          const ph = ((now / 1000 + w.id * 2.3) % PERIOD) / GROW;
          return { w, age: ph };
        }).filter((d) => d.age <= 1);
        layers.push(new ScatterplotLayer({
          id: "songs", data: songs, getPosition: (d: any) => [d.w.lon, d.w.lat], stroked: true, filled: false,
          getRadius: (d: any) => Math.max(300, nominalRangeKm(SPECIES[d.w.species as SpeciesId]) * 1000 * ease(d.age)), radiusUnits: "meters",
          getLineColor: (d: any) => speciesColor(d.w.species, 70 * (1 - d.age) ** 1.5), lineWidthUnits: "pixels", getLineWidth: 1.2,
          updateTriggers: { getRadius: now, getLineColor: now },
        }));
        // small, short pulses (not the full hearing range), only for located calls within ~40 km of our ship
        const near = (lon: number, lat: number) => Math.hypot((lon - s.ship.lon) * 88, (lat - s.ship.lat) * 111) < 40;
        const waves = this.callFx.filter((f) => now - f.t0 < 1200 && f.call.fix && f.call.kind !== "sighting" && near(f.call.lon, f.call.lat))
          .map((f) => ({ f, age: (now - f.t0) / 1200 }));
        layers.push(new ScatterplotLayer({
          id: "waves", data: waves, getPosition: (d: any) => [d.f.call.lon, d.f.call.lat], stroked: true, filled: false,
          getRadius: (d: any) => 300 + 2700 * ease(d.age), radiusUnits: "meters",
          getLineColor: (d: any) => speciesColor(d.f.call.species, 110 * (1 - d.age)), lineWidthUnits: "pixels", getLineWidth: 1,
          updateTriggers: { getRadius: now, getLineColor: now },
        }));
      }
      // single-buoy zones
      if (s.zones.length) {
        layers.push(new ScatterplotLayer({
          id: "zones", data: s.zones, getPosition: (d: any) => [d.lon, d.lat], getRadius: (d: any) => d.r * 1000,
          radiusUnits: "meters", stroked: true, getFillColor: [182, 156, 255, 22], getLineColor: [182, 156, 255, 160],
          lineWidthUnits: "pixels", getLineWidth: 1.5,
        }));
        layers.push(new TextLayer({
          id: "zone-labels", data: s.zones, getPosition: (d: any) => [d.lon, d.lat], getText: (d: any) => `${SPECIES[d.species as SpeciesId].name} heard — somewhere in here`,
          getSize: 11, getColor: [210, 195, 255, 220], fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600, characterSet: "auto",
          outlineWidth: 3, outlineColor: [2, 9, 18, 220], fontSettings: { sdf: true, fontSize: 48, buffer: 10, radius: 10 },
        }));
      }
      // active maneuver zone along the lane
      if (s.maneuverZone && s.activeDecision) {
        const pol = s.activeDecision.chosen.id === "policy";
        layers.push(new PathLayer({
          id: "mzone", data: [{ path: s.maneuverZone }], getPath: (d: any) => d.path, getWidth: 9, widthUnits: "pixels",
          getColor: pol ? [182, 156, 255, 70] : [255, 207, 110, 55], capRounded: true,
        }));
      }
      // decision spotlight: every option's track
      if (this.spotlight && now - this.spotlight.t0 < 14000) {
        const d = this.spotlight.d;
        const fade = Math.min(1, (14000 - (now - this.spotlight.t0)) / 2000);
        // one track per distinct sideways shift (a shift + slow-down draws the same line); the chosen one wins.
        // Skipped for a blanket slow zone: with the whale's position unknown, shifts are not meaningful on the map.
        const seen = new Set<number>();
        const opts = d.chosen.id === "policy" ? [] : d.options
          .filter((o) => o.valid && o.id !== "policy" && o.plan.offset)
          .sort((a, b) => (a.id === d.chosen.id ? -1 : b.id === d.chosen.id ? 1 : 0))
          .filter((o) => { const k = Math.round(o.plan.offset!.d * 10); if (seen.has(k)) return false; seen.add(k); return true; });
        const hold = d.options.find((o) => o.id === "hold");
        const labelAt = (o: typeof opts[number]) => o.path[Math.floor(o.path.length * 0.5)];
        const sideOf = (o: typeof opts[number]) => {
          const p = labelAt(o);
          const h = hold?.path[Math.floor(hold.path.length * 0.5)];
          return h && p[0] < h[0] ? -1 : 1;
        };
        // labels on each side stack as a small list beside the outermost track, so they never collide
        const labels = opts.map((o) => ({ o, side: sideOf(o), row: 0, at: labelAt(o) }));
        for (const side of [-1, 1]) {
          const group = labels.filter((l) => l.side === side);
          const outer = [...group].sort((a, b) => Math.abs(b.o.plan.offset!.d) - Math.abs(a.o.plan.offset!.d))[0];
          group.forEach((l, i) => { l.row = i - (group.length - 1) / 2; l.at = outer.at; });
        }
        layers.push(new PathLayer({
          id: "opts", data: opts.filter((o) => o.id !== d.chosen.id), getPath: (o: any) => o.path, widthUnits: "pixels",
          getWidth: (o: any) => (o.id === d.chosen.id ? 3.5 : 1.6),
          getColor: (o: any) => (o.id === d.chosen.id ? [94, 240, 164, 235 * fade] : [220, 230, 240, 110 * fade]),
          getDashArray: (o: any) => (o.id === d.chosen.id ? [0, 0] : [4, 4]), extensions: [new PathStyleExtension({ dash: true })],
          updateTriggers: { getColor: now },
        } as any));
        layers.push(new TextLayer({
          id: "opt-labels", data: labels, getPosition: (x: any) => x.at,
          getText: (x: any) => x.o.label,
          getTextAnchor: (x: any) => (x.side < 0 ? "end" : "start"),
          getPixelOffset: (x: any) => [x.side * 14, x.row * 16],
          getSize: 10.5, getColor: (x: any) => (x.o.id === d.chosen.id ? [94, 240, 164, 255 * fade] : [210, 220, 230, 170 * fade]),
          fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600, characterSet: "auto",
          outlineWidth: 3, outlineColor: [2, 9, 18, 220], fontSettings: { sdf: true, fontSize: 48, buffer: 10, radius: 10 }, updateTriggers: { getColor: now },
        }));
      }
      // ship's plan ahead + wake
      layers.push(new PathLayer({
        id: "plan-glow", data: [{ path: this.replay ? this.frames[this.replay.idx]?.plannedPath ?? this.plannedPath : this.plannedPath }], getPath: (d: any) => d.path, getColor: [127, 240, 255, 38],
        getWidth: 9, widthUnits: "pixels", capRounded: true, jointRounded: true,
      }));
      layers.push(new PathLayer({
        id: "plan", data: [{ path: this.replay ? this.frames[this.replay.idx]?.plannedPath ?? this.plannedPath : this.plannedPath }], getPath: (d: any) => d.path, getColor: [127, 240, 255, 220],
        getWidth: 2.2, widthUnits: "pixels", capRounded: true, jointRounded: true,
      }));
      // trail coloured by speed: green = holding speed, yellow = slowed, red = very slow
      const trail: { path: [number, number][]; c: number[] }[] = [];
      const fr = this.replay ? this.frames[this.replay.idx] : null;
      const wakeN = fr ? (fr.wakeEpoch === this.wakeEpoch ? fr.wakeLen : 0) : this.wake.length;
      for (let i = 1; i < wakeN; i++) {
        const v = this.wakeV[i] ?? 16;
        trail.push({ path: [this.wake[i - 1], this.wake[i]], c: v >= 14.5 ? [94, 240, 164] : v >= 11.5 ? [255, 207, 110] : [255, 90, 100] });
      }
      layers.push(new PathLayer({
        id: "wake", data: trail, getPath: (d: any) => d.path, getColor: (d: any) => [...d.c, 170], getWidth: 3,
        widthUnits: "pixels", capRounded: true, updateTriggers: { getColor: [this.wake.length, wakeN] },
      } as any));
      // true whales (simulation view)
      if (this.showTruth) {
        const ws = s.whales.filter((w) => w.active);
        layers.push(new PathLayer({
          id: "whale-trails", data: ws, getPath: (w: any) => w.trail, getColor: (w: any) => speciesColor(w.species, 70),
          getWidth: 1.2, widthUnits: "pixels",
        }));
        layers.push(new ScatterplotLayer({
          id: "whale-glow", data: ws, getPosition: (w: any) => [w.lon, w.lat], getRadius: 900, radiusUnits: "meters",
          radiusMinPixels: 9, getFillColor: (w: any) => speciesColor(w.species, 45 + 25 * Math.sin(now / 400 + w.id)),
          updateTriggers: { getFillColor: Math.floor(now / 50) },
        }));
        layers.push(new IconLayer({
          id: "whales", data: ws, getPosition: (w: any) => [w.lon, w.lat], getIcon: () => ({ url: WHALE_SVG, width: 40, height: 100, anchorY: 50 }),
          getSize: this.view.zoom > 9 ? 26 : 18, sizeUnits: "pixels", getAngle: (w: any) => (w.heading * 180) / Math.PI - 90,
          opacity: 0.85,
        }));
        layers.push(new TextLayer({
          id: "whale-names", data: ws.filter((w: any) => this.view.zoom > 8 && Math.hypot((w.lon - s.ship.lon) * 88, (w.lat - s.ship.lat) * 111) < 40), getPosition: (w: any) => [w.lon, w.lat], getText: (w: any) => SPECIES[w.species as keyof typeof SPECIES].name.replace(" whale", "") + " (true)",
          getSize: 10, getColor: [255, 200, 140, 210], getPixelOffset: [0, -18], fontFamily: "Inter, system-ui, sans-serif", fontWeight: 600,
          characterSet: "auto", outlineWidth: 3, outlineColor: [2, 9, 18, 220], fontSettings: { sdf: true, fontSize: 48, buffer: 10, radius: 10 },
        }));
      }
      // located whales: 95% ellipse now, forecast ellipses, recent fixes.
      // Forecasts and labels only for whales within ~40 km of our ship, so a crowded sea stays readable.
      const kmFromShip = (lon: number, lat: number) => Math.hypot((lon - s.ship.lon) * 111 * Math.cos((lat * Math.PI) / 180), (lat - s.ship.lat) * 111);
      const nearTracks = s.tracks.filter((tr) => kmFromShip(tr.lon, tr.lat) < 40);
      layers.push(new PolygonLayer({
        id: "future", data: nearTracks.flatMap((tr) => tr.future.slice(0, 2).map((e, i) => ({ e, i, sp: tr.species }))),
        getPolygon: (d: any) => ellipsePolygon(d.e), filled: false, stroked: true, getLineColor: (d: any) => [255, 207, 110, 110 - d.i * 30],
        lineWidthUnits: "pixels", getLineWidth: 1, getDashArray: [3, 3], extensions: [new PathStyleExtension({ dash: true })],
      } as any));
      layers.push(new PolygonLayer({
        id: "est", data: s.tracks, getPolygon: (tr: any) => ellipsePolygon(tr.now), filled: true, stroked: true,
        getFillColor: [255, 207, 110, 55], getLineColor: [255, 207, 110, 230], lineWidthUnits: "pixels", getLineWidth: 1.5,
      }));
      // located whale = yellow outlined whale (where we think it is), pointing the way it's swimming
      layers.push(new IconLayer({
        id: "est-whale", data: s.tracks, getPosition: (tr: any) => [tr.lon, tr.lat],
        getIcon: () => ({ url: EST_WHALE_SVG, width: 40, height: 100, anchorY: 50 }), getSize: this.view.zoom > 9 ? 24 : 16, sizeUnits: "pixels",
        getAngle: (tr: any) => (tr.heading * 180) / Math.PI - 90,
      }));
      const fixes = this.fixFx.filter((f) => now - f.t0 < 5000);
      layers.push(new ScatterplotLayer({
        id: "fixes", data: fixes, getPosition: (f: any) => [f.e.lon, f.e.lat], getRadius: 1.8, radiusUnits: "pixels",
        getFillColor: (f: any) => [255, 240, 210, 220 * (1 - (now - f.t0) / 5000)], updateTriggers: { getFillColor: now },
      }));
      layers.push(new TextLayer({
        id: "track-labels", data: this.view.zoom > 8.6 ? declutter(nearTracks, this.view.zoom) : [], getPosition: (tr: any) => [tr.lon, tr.lat],
        getText: (tr: any) => `${SPECIES[tr.species as SpeciesId].name.replace(" whale", "").toUpperCase()} · ±${Math.max(10, Math.round((tr.now.a * 1000) / 2.45))} m · ${tr.speedKn.toFixed(1)} kn`,
        getSize: 10, getColor: [255, 215, 150, 235], fontFamily: "JetBrains Mono, monospace", fontWeight: 500, characterSet: "auto",
        getPixelOffset: [0, 16], outlineWidth: 3, outlineColor: [2, 9, 18, 230], fontSettings: { sdf: true, fontSize: 48, buffer: 10, radius: 10 },
      }));
      // ship
      layers.push(new ScatterplotLayer({
        id: "ship-halo", data: [s.ship], getPosition: (d: any) => [d.lon, d.lat], getRadius: 16 + 3 * Math.sin(now / 350),
        radiusUnits: "pixels", getFillColor: [127, 240, 255, 26], stroked: true, getLineColor: [127, 240, 255, 90],
        lineWidthUnits: "pixels", getLineWidth: 1, updateTriggers: { getRadius: Math.floor(now / 40) },
      }));
      layers.push(new IconLayer({
        id: "ship", data: [s.ship], getPosition: (d: any) => [d.lon, d.lat],
        getIcon: () => ({ url: SHIP_SVG, width: 64, height: 160, anchorY: 80 }), getSize: 34, sizeUnits: "pixels",
        getAngle: (d: any) => -d.heading,
      }));
    }
    this.deck.setProps({ layers: layers as any });
    this.updateHud(now);
  }

  // ------------------------------------------------------------------ HUD
  private updateHud(now: number) {
    const s = this.shown;
    if (!s) return;
    $("clock").textContent = clock(s.t);
    $("progressFill").style.width = `${(s.ship.progress * 100).toFixed(2)}%`;
    $("progressShip").style.left = `${(s.ship.progress * 100).toFixed(2)}%`;
    $("rdSpeed").textContent = `${s.ship.speed.toFixed(1)} kn`;
    $("rdHeading").textContent = `${Math.round(s.ship.heading).toString().padStart(3, "0")}°`;
    $("rdEta").textContent = clock(s.stats.etaS).replace("Day ", "D");
    // bubble anchored to the ship
    const bub = $("bubble");
    if (!s.activeDecision && this.bubble && this.bubble.until === Infinity) this.bubble = { ...this.bubble, until: now + 4000, title: "Manoeuvre complete", html: `Back on the lane · <span class="hl">${s.ship.speed.toFixed(1)} kn</span> to keep the schedule` };
    if (this.bubble && now < this.bubble.until && !this.replay) {
      const vp = this.deck.getViewports()[0];
      if (vp) {
        const [x, y] = vp.project([s.ship.lon, s.ship.lat]);
        bub.style.left = `${x}px`;
        bub.style.top = `${y}px`;
        bub.hidden = false;
        bub.className = `bubble${this.bubble.policy ? " policy" : ""}`;
        const key = this.bubble.title + this.bubble.html;
        if (bub.dataset.key !== key) {
          bub.dataset.key = key;
          $("bubbleTitle").textContent = this.bubble.title;
          $("bubbleBody").innerHTML = this.bubble.html;
        }
        $("bubbleTime").textContent = clock(s.t).slice(-5);
      }
    } else bub.hidden = true;
    if (now - this.lastPanelRender > 500 && !this.replay) {
      this.lastPanelRender = now;
      if (this.tab === "decision" && this.shownDecision && s.activeDecision === this.shownDecision && this.shownDecision !== this.renderedDecision) {
        this.renderedDecision = this.shownDecision;
        renderDecision($("tab-decision"), this.shownDecision, this.history);
      }
      if (this.tab === "voyage" && this.init) renderVoyage($("tab-voyage"), s, this.mode, this.init.sensors.lon.length, this.init.spacingKm, this.sigmaMs, this.init.traffic);
    }
  }

  /** The right panel can be dragged wider (never narrower than its default); double-click the grip to reset. */
  private bindPanelResize() {
    const MIN = 384;
    const root = document.documentElement;
    const max = () => Math.max(MIN, Math.min(780, window.innerWidth - 700));
    const apply = (w: number) => {
      const px = Math.round(Math.min(Math.max(w, MIN), max()));
      root.style.setProperty("--pw", `${px}px`);
      // keep the legend from sliding under a wide panel
      const lg = $("legend"), pr = $("panel").getBoundingClientRect();
      lg.style.visibility = "";
      if (lg.getBoundingClientRect().right > pr.left - 8) lg.style.visibility = "hidden";
      return px;
    };
    try { const saved = Number(localStorage.getItem("cetus.panelWidth")); if (saved) apply(saved); } catch { /* storage unavailable */ }
    const grip = $("panelGrip");
    let drag = false;
    grip.addEventListener("pointerdown", (e) => { drag = true; grip.setPointerCapture(e.pointerId); grip.classList.add("dragging"); document.body.classList.add("resizing"); });
    grip.addEventListener("pointermove", (e) => { if (drag) apply(window.innerWidth - 14 - e.clientX); });
    const end = () => {
      if (!drag) return;
      drag = false;
      grip.classList.remove("dragging");
      document.body.classList.remove("resizing");
      try { localStorage.setItem("cetus.panelWidth", String(parseInt(getComputedStyle(root).getPropertyValue("--pw")))); } catch { /* ignore */ }
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    grip.addEventListener("dblclick", () => { apply(MIN); try { localStorage.removeItem("cetus.panelWidth"); } catch { /* ignore */ } });
    window.addEventListener("resize", () => apply(parseInt(getComputedStyle(root).getPropertyValue("--pw")) || MIN));
  }

  // ------------------------------------------------------------------ replay & timeline
  private recordFrame(s: Snapshot) {
    const last = this.frames[this.frames.length - 1];
    if (last && s.t - last.t < 60 && !s.finished) return;
    const slim: Snapshot = {
      ...s, calls: [], decisions: [], strikes: [], nearMisses: [], coverage: [], cautionPrompt: null,
      whales: s.whales.map((w) => ({ ...w, trail: w.trail.slice(-15) })),
      tracks: s.tracks.map((tr) => ({ ...tr, history: tr.history.slice(-10) })),
    };
    this.frames.push({ t: s.t, snap: slim, wakeLen: this.wake.length, wakeEpoch: this.wakeEpoch, histLen: this.history.length, plannedPath: this.plannedPath });
    if (this.replay) ($("rpRange") as HTMLInputElement).max = String(this.frames.length - 1);
  }

  private addMark(d: Decision, s: Snapshot) {
    // every whale the ship assessed gets a small tick where the encounter is, whatever it decided
    const key = d.trackId !== undefined ? `t${d.trackId}` : `${d.species}${Math.round(d.sConflict / 15)}`;
    if (this.init && !this.marks.some((m) => m.key === key)) {
      this.marks.push({ p: Math.min(d.sConflict / this.init.routeLengthKm, 1), t: d.t, kind: "seen", key, label: `${SPECIES[d.species].name} ahead · first assessed ${clock(d.t).slice(-5)}` });
    }
    if (d.chosen.id === "hold") { this.renderMarks(); return; }
    const kind = d.chosen.id === "policy" ? "policy" : /slow|yield/.test(d.chosen.id) && d.chosen.id !== "turn2slow12" ? "slow" : "shift";
    const prev = this.marks[this.marks.length - 1];
    if (prev && prev.kind === kind && Math.abs(prev.p - s.ship.progress) < 0.01) return; // a refinement of the same manoeuvre
    this.marks.push({ p: s.ship.progress, t: d.t, kind, label: `${clock(d.t).slice(-5)} · ${SPECIES[d.species].name}: ${d.chosen.label}` });
  }

  private renderMarks() {
    const el = $("decMarks");
    el.innerHTML = this.marks.map((m, i) => `<div class="dmark ${m.kind}" style="left:${(m.p * 100).toFixed(2)}%" data-i="${i}" title="${m.label} · click to replay"></div>`).join("");
  }

  private frameAt(t: number): number {
    let best = 0;
    for (let i = 0; i < this.frames.length; i++) if (this.frames[i].t <= t) best = i; else break;
    return best;
  }

  private enterReplay(idx: number, autoplay = false) {
    if (!this.frames.length) return;
    this.playing = false;
    this.syncPlay();
    this.replay = { idx: 0, playing: autoplay, acc: 0, shownDecision: null };
    $("replayBar").hidden = false;
    ($("rpRange") as HTMLInputElement).max = String(this.frames.length - 1);
    this.setReplayIdx(idx);
    this.syncReplay();
    this.setFollow(true);
  }

  private exitReplay(show = true) {
    if (!this.replay) return;
    this.replay = null;
    $("replayBar").hidden = true;
    if (show && this.snap) {
      renderDecision($("tab-decision"), this.shownDecision, this.history);
      this.renderedDecision = this.shownDecision;
      this.flyTo(this.snap.ship.lon, this.snap.ship.lat, Math.max(this.view.zoom, 8));
    }
  }

  private setReplayIdx(idx: number) {
    if (!this.replay) return;
    this.replay.idx = Math.max(0, Math.min(idx, this.frames.length - 1));
    const f = this.frames[this.replay.idx];
    ($("rpRange") as HTMLInputElement).value = String(this.replay.idx);
    $("rpTime").textContent = clock(f.t);
    // the decision that was in force (or most recent) at that moment
    const hist = this.history.slice(0, f.histLen);
    const d = f.snap.activeDecision ?? [...hist].reverse().find((x) => x.chosen.id !== "hold") ?? hist[hist.length - 1] ?? null;
    if (d !== this.replay.shownDecision) {
      this.replay.shownDecision = d;
      renderDecision($("tab-decision"), d, hist);
      if (this.tab !== "decision") this.selectTab("decision");
    }
  }

  private syncReplay() {
    $("rpIcoPlay").hidden = !!this.replay?.playing;
    $("rpIcoPause").hidden = !this.replay?.playing;
  }

  private jumpDecision(dir: 1 | -1) {
    if (!this.replay) return;
    const t = this.frames[this.replay.idx].t;
    const ms = this.marks.filter((m) => (dir > 0 ? m.t > t + 30 : m.t < t - 90));
    const m = dir > 0 ? ms[0] : ms[ms.length - 1];
    if (m) this.setReplayIdx(Math.max(0, this.frameAt(m.t) - 2)); // a little before, to see it coming
  }

  private bindReplay() {
    const bar = $("progressBar");
    const seek = (e: MouseEvent) => {
      if (!this.frames.length) return;
      const r = bar.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      let best = 0, bd = Infinity;
      this.frames.forEach((f, i) => { const d = Math.abs(f.snap.ship.progress - p); if (d < bd) { bd = d; best = i; } });
      if (!this.replay) this.enterReplay(best);
      else this.setReplayIdx(best);
    };
    bar.addEventListener("click", (e) => {
      const mk = (e.target as HTMLElement).closest<HTMLElement>(".dmark");
      if (mk) {
        const m = this.marks[Number(mk.dataset.i)];
        const idx = Math.max(0, this.frameAt(m.t) - 2);
        if (!this.replay) this.enterReplay(idx); else this.setReplayIdx(idx);
        return;
      }
      seek(e);
    });
    const rng = $("rpRange") as HTMLInputElement;
    rng.oninput = () => { if (this.replay) { this.replay.playing = false; this.syncReplay(); this.setReplayIdx(Number(rng.value)); } };
    $("rpPlay").onclick = () => {
      if (!this.replay) return;
      if (this.replay.idx >= this.frames.length - 1) this.setReplayIdx(0);
      this.replay.playing = !this.replay.playing;
      this.syncReplay();
    };
    $("rpPrev").onclick = () => this.jumpDecision(-1);
    $("rpNext").onclick = () => this.jumpDecision(1);
    $("rpLive").onclick = () => this.exitReplay();
  }

  /** Strike hotspots along the route (regions, not whales). Whales the ship assessed appear as small ticks as the voyage goes. */
  private progressMarks() {
    const el = $("progressMarks");
    if (!this.init) return;
    const short = (l: string) => l.replace("Gulf of the ", "").replace("Offshore ", "").replace("Santa Barbara Channel", "S.B. Channel").replace(" trans-Pacific lane", "");
    el.innerHTML = this.init.scenario.encounters
      .map((e) => `<div class="pmark" style="left:${(100 * e.s) / this.init!.routeLengthKm}%" data-label="${short(e.label)}" title="${e.label}: encounter area (a whale here ~85% of voyages)"></div>`)
      .join("");
  }

  private toast(text: string, kind: "" | "warn" | "dec") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.innerHTML = `<span class="t-dot"></span>${text}`;
    $("toasts").appendChild(el);
    while ($("toasts").children.length > 3) $("toasts").firstElementChild?.remove();
    setTimeout(() => el.remove(), 4200);
  }

  private hover(c: [number, number] | undefined, x: number, y: number) {
    const el = $("hover");
    if (!c) {
      el.hidden = true;
      return;
    }
    const z = this.depth.elevation(c[0], c[1]);
    el.hidden = false;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.textContent = `${Math.abs(c[1]).toFixed(3)}°N ${Math.abs(c[0]).toFixed(3)}°W · ${z < 0 ? `depth ${Math.round(-z).toLocaleString()} m` : "land"}`;
  }

  private showSummary(s: Snapshot) {
    const st = s.stats;
    const net = this.mode !== "single";
    const late = (s.t - st.scheduledArrival) / 60;
    const usd = (v: number) => `${v < 0 ? "−" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
    $("summaryCard").innerHTML = `
      <div class="eyebrow">Voyage complete · ${this.mode === "ships" ? "ships as sensors" : this.mode === "mix" ? "mix: ships + port stations" : net ? (this.style === "ahead" ? "sensor network · plan ahead" : "buoy network") : "slow zones (what exists today)"}</div>
      <h1>${net ? (Math.abs(st.decisionsCostUsd) < 150 ? `${st.strikes ? "Voyage protected" : "Whales avoided"} at <span class="grad">almost no extra cost</span>` : `${st.strikes ? "Voyage protected" : "Whales avoided"} for <span class="grad">${usd(st.decisionsCostUsd)}</span> ${st.decisionsCostUsd < 0 ? "saved" : "extra"}`) : `Slow zones cost <span style="color:var(--policy)">${usd(st.decisionsCostUsd)}</span>`}</h1>
      <p class="lead">${st.conflicts} whale encounters assessed · ${st.maneuvers} manoeuvres · arrival ${Math.abs(late) < 2 ? "on schedule" : late > 0 ? `${Math.round(late)} min late` : "early"}.
        Chance this voyage kills a whale: ${(st.riskHold * 100).toFixed(2)}% if the ship ignored them (about 1 in ${Math.round(1 / Math.max(st.riskHold, 1e-6)).toLocaleString("en-US")} voyages) → <b style="color:var(--good)">${(st.riskTaken * 100).toFixed(2)}%</b> with ${net ? (this.mode === "network" ? "the buoy network" : this.mode === "mix" ? "ships + port stations" : "ships as sensors") : "slow zones"}. ${ii("summary")}
        ${st.strikes ? `<b style="color:var(--bad)">${st.strikes} whale${st.strikes > 1 ? "s" : ""} struck (${st.lethalStrikes} fatal).</b> ` : "<b style=\"color:var(--good)\">No whales struck.</b> "}${st.cautions ? `${st.cautions} precautionary slow-down${st.cautions > 1 ? "s" : ""} (${Math.round(st.cautionMin)} min). ` : ""}${net ? `Located ${st.fixes.toLocaleString()} calls with a mean error of ${Math.round(st.meanErrorKm * 1000)} m${this.mode === "ships" || this.mode === "mix" ? ` using ${st.shipsContributing} real ships (hydrophones)${this.mode === "mix" ? " and 10 port stations" : ""}, plus ${st.sightings} thermal-camera sightings` : ""}.` : "With one buoy per area the whales could not be located, so every detection meant a blanket slow zone."}</p>
      ${this.coverageSummary()}
      ${net ? `<div class="cmp"><div class="cmp-card net"><h4 style="color:var(--cyan)">${this.mode === "ships" ? "Ships as sensors" : this.mode === "mix" ? "Mix" : "Buoy network"}</h4><div class="big">${usd(st.decisionsCostUsd)}</div><div class="small muted">fuel ${st.actualFuelDeltaT >= 0 ? "+" : "−"}${Math.abs(st.actualFuelDeltaT).toFixed(1)} t (${usd(st.actualFuelDeltaT * 1346)})${st.behindMin > 1 ? ` + ${Math.round(st.behindMin)} min late (${usd((st.behindMin / 60) * st.timeCostPerHour)})` : ", on time"} · strike risk ${(st.riskTaken * 100).toFixed(2)}%${st.actualFuelDeltaT < 0 && st.behindMin > 1 ? `<br>Slowing saved fuel but cost time; the figure above is the net.` : ""}</div></div>
      <div class="cmp-card pol"><h4 style="color:var(--policy)">Slow zones (same whales)</h4><div class="big">${usd(st.policyCostUsd)}</div><div class="small muted">${st.policyLateMin > 1 ? `arrives <b>${Math.round(st.policyLateMin)} min late</b>${st.policyCostUsd < 0 ? " (saves fuel by slowing, but misses the schedule)" : ""}` : "extra fuel cost"} · blanket 10-kn slow zones · strike risk ${(st.riskPolicy * 100).toFixed(2)}%</div></div></div>` : ""}
      ${tripLine(st, net)}
      <div class="modal-actions" style="margin-top:18px">
        <button class="btn btn-lg btn-primary" id="sumReplay">Replay voyage</button>
        <button class="btn btn-lg" id="sumLab">Compare all modes</button>
        <button class="btn btn-lg" id="sumAgain">Run again</button>
        <button class="btn btn-lg" id="sumSwitch">Try ${net ? "today's slow zones" : "ships as sensors"}</button>
        <button class="btn btn-lg" id="sumNew">New whales</button>
      </div>`;
    $("summary").hidden = false;
    $("sumAgain").onclick = () => { this.restart(); this.play(); };
    $("sumReplay").onclick = () => { $("summary").hidden = true; this.enterReplay(0, true); };
    $("sumLab").onclick = () => { $("summary").hidden = true; this.lab.open("compare"); };
    $("sumNew").onclick = () => { this.restart(true); this.play(); };
    $("sumSwitch").onclick = () => { this.setMode(net ? "single" : "ships"); this.play(); };
  }

  // ------------------------------------------------------------------ UI wiring
  private selectTab(t: string) {
    this.tab = t;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.tab === t));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === `tab-${t}`));
    if (t === "voyage" && this.snap && this.init) renderVoyage($("tab-voyage"), this.snap, this.mode, this.init.sensors.lon.length, this.init.spacingKm, this.sigmaMs, this.init.traffic);
  }

  private setFollow(v: boolean) {
    this.follow = v;
    ($("togFollow") as HTMLInputElement).checked = v;
  }

  private play() {
    if (!$("intro").hidden) this.showModeCard(); // first start: explain the mode we open in
    $("summary").hidden = true;
    $("intro").hidden = true;
    this.playing = true;
    this.syncPlay();
    if (this.follow && this.snap) this.flyTo(this.snap.ship.lon, this.snap.ship.lat - 0.05, 8.3, 2200);
  }

  private syncPlay() {
    $("icoPlay").hidden = this.playing;
    $("icoPause").hidden = !this.playing;
  }

  /** Legend matching the current monitoring mode. */
  private renderLegend() {
    const row = (icon: string, text: string) => `<div><i class="lg ${icon}"></i>${text}</div>`;
    const m = this.mode;
    const items = [
      m === "network" ? row("lg-sensor", "Hydrophone buoy") : "",
      m === "single" ? row("lg-sensor", "Single listening buoy") : "",
      m === "ships" || m === "mix" ? row("lg-ship", "Real ship (AIS) · hydrophone + camera") : "",
      m === "mix" ? row("lg-station", "Port seafloor station") : "",
      m !== "single" ? row("lg-hear", `${m === "network" ? "Buoys" : "Listeners"} → located call`) : row("lg-zone", "Slow zone (whale heard)"),
      row("lg-whale", "True whale (sim only)"),
      m !== "single" ? row("lg-est", "Located · 95% zone") : "",
      row("lg-plan", "Ship's plan"),
      row("lg-trail", "Trail: holding · slowed · very slow"),
      m !== "single" ? row("lg-blind", "Blind spot ahead") : "",
    ];
    $("legend").innerHTML = items.join("") + `<div class="lg-depth"><span>0</span><i></i><span>4,500 m</span></div>`;
  }

  private coverageSummary(): string {
    const c = this.coverage;
    if (this.mode === "single" || c.length < 10) return "";
    const pct = (f: (x: (typeof c)[number]) => boolean) => Math.round((100 * c.filter(f).length) / c.length);
    let run = 0, longest = 0, where = 0;
    for (const x of c) { if (x.fin < 3) { run++; if (run > longest) { longest = run; where = x.s; } } else run = 0; }
    return `<p class="small" style="margin:-4px 0 12px">Coverage ${ii("coverage")}: a humpback could be located along <b>${pct((x) => x.hump >= 3)}%</b> of the route,
      a fin/blue whale along <b>${pct((x) => x.fin >= 3)}%</b>.${longest > 3 ? ` Longest blind spot: <b style="color:var(--bad)">${longest} km</b> (ending ~${Math.round(where)} km into the voyage).` : " No blind spots for fin/blue whales."}</p>`;
  }

  /** Small card on the map: what this mode is and which "what if" it simulates. */
  private showModeCard() {
    const M = MODE_INFO[this.mode];
    $("modeCardBody").innerHTML = `<h4 class="${this.mode === "single" ? "pol" : ""}">${M.title}</h4><p>${M.what}</p><p><span class="tag">${this.mode === "single" ? "Real world" : "What if"}</span>${M.whatIf}</p><p class="muted">${M.watch}</p>`;
    const card = $("modeCard");
    card.hidden = false;
    // always open in the top-left corner, just under the top bar (it can be dragged anywhere)
    const top = (document.querySelector(".topbar")?.getBoundingClientRect().bottom ?? 80) + 10;
    card.style.left = "14px";
    card.style.top = `${Math.round(top)}px`;
    card.style.right = "auto";
    card.style.bottom = "auto";
    clearTimeout(this.modeCardTimer);
    this.modeCardTimer = window.setTimeout(() => ($("modeCard").hidden = true), 22000);
  }
  private modeCardTimer = 0;

  private setMode(m: "network" | "ahead" | "ships" | "mix" | "single") {
    this.mode = m === "single" ? "single" : m === "ships" ? "ships" : m === "mix" ? "mix" : "network";
    this.style = m === "ahead" ? "ahead" : "targeted";
    $("cautionWrap").hidden = this.mode !== "ships" && this.mode !== "mix";
    $("sensRange").closest("label")?.classList.toggle("off", this.mode !== "network"); // sensor count only matters for Buoys // only ships mode has an unlocated-whale choice
    document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.mode === m));
    this.restart();
    this.showModeCard();
  }

  private bindUi() {
    initInfo();
    const answer = (slow: boolean) => {
      $("cautionCard").hidden = true;
      this.waiting = false;
      this.busy = true;
      this.worker?.postMessage({ type: "caution", slow });
    };
    $("ccSlow").onclick = () => answer(true);
    $("ccHold").onclick = () => answer(false);
    $("strikeOk").onclick = () => { $("strike").hidden = true; this.waiting = !$("cautionCard").hidden; };
    $("avoidedOk").onclick = () => { $("avoided").hidden = true; this.waiting = !$("cautionCard").hidden; };
    const wr = $<HTMLInputElement>("whaleRange");
    wr.oninput = () => { $("whaleVal").textContent = wr.value; };
    wr.onchange = () => { this.whaleCount = Number(wr.value); this.restart(); };
    const cs = $<HTMLSelectElement>("cautionSel");
    cs.onchange = () => { this.caution = cs.value as "slow" | "ask" | "ignore"; if (this.mode === "ships" || this.mode === "mix") this.restart(); };
    $("btnStart").onclick = () => this.play();
    $("modeX").onclick = () => ($("modeCard").hidden = true);
    // drag the mode card by any part of it except its close button
    {
      const card = $("modeCard");
      let drag: { dx: number; dy: number } | null = null;
      card.addEventListener("pointerdown", (e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        const r = card.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        card.setPointerCapture(e.pointerId);
        clearTimeout(this.modeCardTimer); // being handled: don't auto-hide
      });
      card.addEventListener("pointermove", (e) => {
        if (!drag) return;
        const x = Math.min(Math.max(0, e.clientX - drag.dx), window.innerWidth - card.offsetWidth);
        const y = Math.min(Math.max(0, e.clientY - drag.dy), window.innerHeight - card.offsetHeight);
        card.style.left = `${x}px`;
        card.style.top = `${y}px`;
      });
      const end = () => (drag = null);
      card.addEventListener("pointerup", end);
      card.addEventListener("pointercancel", end);
    }
    this.bindReplay();
    this.bindPanelResize();
    this.lab = new FleetLab(() => this.grids, () => ({ seed: this.seed, whaleCount: this.whaleCount, sensorCount: this.sensorCount, sigmaMs: this.sigmaMs, routeId: this.routeId }));
    this.lab.bind();
    $("btnLab").onclick = () => { this.playing = false; this.syncPlay(); this.lab.open(); };
    // opening mode (Ships): same control states as setMode would give
    $("cautionWrap").hidden = this.mode !== "ships" && this.mode !== "mix";
    $("sensRange").closest("label")?.classList.toggle("off", this.mode !== "network");
    $("aboutLink").onclick = (e) => { e.preventDefault(); $("intro").hidden = false; };
    $("btnPlay").onclick = () => {
      if (this.replay) { $("rpPlay").click(); return; }
      if (this.snap?.finished) { this.restart(); this.play(); return; }
      this.playing = !this.playing;
      if (this.playing) $("intro").hidden = true;
      this.syncPlay();
    };
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLSelectElement)) {
        e.preventDefault();
        $("btnPlay").click();
      }
    });
    $("btnRestart").onclick = () => { this.restart(); this.play(); };
    $("btnNew").onclick = () => { this.restart(true); this.play(); };
    $("btnSkip").onclick = () => {
      if (!this.worker || this.snap?.finished) return;
      $("intro").hidden = true;
      this.skipRequested = true;
      this.toast("Fast-forwarding to the next encounter…", "");
      if (!this.playing) { this.playing = true; this.syncPlay(); }
      this.setFollow(true);
    };
    document.querySelectorAll<HTMLButtonElement>("#speedSeg button").forEach((b) => (b.onclick = () => {
      this.speed = Number(b.dataset.speed);
      document.querySelectorAll("#speedSeg button").forEach((x) => x.classList.toggle("on", x === b));
    }));
    document.querySelectorAll<HTMLButtonElement>("#modeSeg button").forEach((b) => (b.onclick = () => this.setMode(b.dataset.mode as "network" | "ahead" | "ships" | "mix" | "single")));
    ($("routeSel") as HTMLSelectElement).onchange = (e) => { this.routeId = (e.target as HTMLSelectElement).value; this.restart(); };
    const sens = $("sensRange") as HTMLInputElement;
    sens.oninput = () => ($("sensVal").textContent = Number(sens.value).toLocaleString());
    sens.onchange = () => { this.sensorCount = Number(sens.value); if (this.mode === "network") this.restart(); };
    const sig = $("sigRange") as HTMLInputElement;
    sig.oninput = () => ($("sigVal").textContent = `${sig.value} ms`);
    sig.onchange = () => { this.sigmaMs = Number(sig.value); if (this.mode !== "single") this.restart(); };
    ($("togTruth") as HTMLInputElement).onchange = (e) => (this.showTruth = (e.target as HTMLInputElement).checked);
    ($("togSensors") as HTMLInputElement).onchange = (e) => (this.showSensors = (e.target as HTMLInputElement).checked);
    ($("togCine") as HTMLInputElement).onchange = (e) => (this.cine = (e.target as HTMLInputElement).checked);
    ($("togFollow") as HTMLInputElement).onchange = (e) => {
      this.follow = (e.target as HTMLInputElement).checked;
      if (this.follow && this.snap) this.flyTo(this.snap.ship.lon, this.snap.ship.lat, Math.max(this.view.zoom, 8));
    };
    document.querySelectorAll<HTMLButtonElement>(".tab").forEach((b) => (b.onclick = () => this.selectTab(b.dataset.tab!)));
  }
}
