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
import { SPECIES, type SpeciesId } from "../engine/physics";
import { HOTSPOTS } from "../engine/scenario";
import type { FromWorker, Snapshot, SnapCall, EllipseLL, InitReply } from "../worker/protocol";
import { renderDecision, renderVoyage, renderMethod, clock } from "./panel";

type RGBA = [number, number, number, number];
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const SHIP_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="160" viewBox="0 0 64 160"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#cfe0ee"/><stop offset=".5" stop-color="#ffffff"/><stop offset="1" stop-color="#b7cadb"/></linearGradient></defs><path d="M32 3 C45 22 51 44 51 70 L51 148 Q32 157 13 148 L13 70 C13 44 19 22 32 3Z" fill="url(#g)" stroke="#5fe1ff" stroke-width="3"/><rect x="19" y="114" width="26" height="20" rx="3" fill="#7f98ae"/><rect x="21" y="40" width="22" height="64" rx="2" fill="#dbe7f1" stroke="#9fb4c8" stroke-width="1.5"/></svg>`,
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
  private mode: "network" | "single" = "network";
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
    this.seenTracks.clear();
    this.summaryShown = false;
    $("summary").hidden = true;
    this.worker.onmessage = (ev: MessageEvent<FromWorker>) => this.onWorker(ev.data);
    this.worker.postMessage({
      type: "init",
      grids: this.grids.map((g) => ({ ...g, z: g.z.slice() })),
      options: {
        seed: this.seed, routeId: this.routeId, mode: this.mode, sensorCount: this.sensorCount, sigmaT: this.sigmaMs / 1000,
      },
    });
    $("routeName").textContent = this.routeId === "oak-lb" ? "Oakland → Long Beach" : "Oakland → Asia (westbound)";
    const chip = $("modeChip");
    chip.textContent = this.mode === "network" ? "Sensor network" : "Single buoys · today";
    chip.className = `chip ${this.mode === "network" ? "chip-net" : "chip-single"}`;
    renderDecision($("tab-decision"), null, []);
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
      if (this.wake.length > 900) this.wake.shift();
    }
    for (const c of s.calls) {
      this.callFx.push({ call: c, t0: now });
      for (const id of c.sensors) this.sensorFlash[id] = now;
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
    const jumped = this.snap && Math.hypot(this.snap.ship.lon - s.ship.lon, this.snap.ship.lat - s.ship.lat) > 0.3;
    this.snap = s;
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
        ? { title: `${sp} tracked ahead`, html: `Too early to act — <span class="hl">keep listening</span> as the forecast sharpens`, policy: false, until: now + 6000 }
        : { title: "Whale ahead · clear", html: `${sp} near the lane — likely clear of our track. <span class="hl">Holding course.</span>`, policy: false, until: now + 6000 };
      this.toast(d.waitForInfo ? `${sp} tracked ahead — listening before deciding` : `${sp} near the lane — clear, holding course`, "warn");
    } else {
      this.bubble = this.maneuverBubble(d);
      this.spotlight = { d, t0: now };
      this.toast(`${d.chosen.id === "policy" ? "Slow zone" : "Route change"}: ${d.chosen.label}`, "dec");
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
    if (this.skipRequested && !this.busy && this.init && this.snap && !this.snap.finished) {
      this.skipRequested = false;
      this.busy = true;
      this.pendingDt = 0;
      this.callFx = [];
      this.wake = [];
      this.worker!.postMessage({ type: "skip" });
    } else if (this.playing && this.init && this.snap && !this.snap.finished) {
      this.pendingDt += dtReal * speed;
      if (!this.busy && this.pendingDt > 0) {
        this.busy = true;
        this.worker!.postMessage({ type: "step", dt: Math.min(this.pendingDt, 1800) });
        this.pendingDt = 0;
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
    } else if (this.follow && this.snap && this.playing) {
      const s = this.snap.ship;
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
    // sensors
    const n = this.sensorPhase.length;
    if (this.showSensors && n) {
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
        for (const id of fx.call.sensors.slice(0, 12)) tri.push({ from: [this.sensorPos[2 * id], this.sensorPos[2 * id + 1]], to: [fx.call.fix.lon, fx.call.fix.lat], age });
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
    const s = this.snap;
    if (s) {
      // call wavefronts (drawn from the TRUE position: simulation view)
      if (this.showTruth) {
        const waves = this.callFx.filter((f) => now - f.t0 < 1600).map((f) => ({ f, age: (now - f.t0) / 1600 }));
        layers.push(new ScatterplotLayer({
          id: "waves", data: waves, getPosition: (d: any) => [d.f.call.lon, d.f.call.lat], stroked: true, filled: false,
          getRadius: (d: any) => Math.max(200, d.f.call.rangeKm * 1000 * ease(d.age)), radiusUnits: "meters",
          getLineColor: (d: any) => speciesColor(d.f.call.species, 80 * (1 - d.age)), lineWidthUnits: "pixels", getLineWidth: 1,
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
          id: "opts", data: opts, getPath: (o: any) => o.path, widthUnits: "pixels",
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
        id: "plan-glow", data: [{ path: this.plannedPath }], getPath: (d: any) => d.path, getColor: [127, 240, 255, 38],
        getWidth: 9, widthUnits: "pixels", capRounded: true, jointRounded: true,
      }));
      layers.push(new PathLayer({
        id: "plan", data: [{ path: this.plannedPath }], getPath: (d: any) => d.path, getColor: [127, 240, 255, 220],
        getWidth: 2.2, widthUnits: "pixels", capRounded: true, jointRounded: true,
      }));
      layers.push(new PathLayer({
        id: "wake", data: [{ path: this.wake }], getPath: (d: any) => d.path, getColor: [230, 245, 255, 90],
        getWidth: 1.4, widthUnits: "pixels",
      }));
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
      }
      // located whales: 95% ellipse now, forecast ellipses, recent fixes
      layers.push(new PolygonLayer({
        id: "future", data: s.tracks.flatMap((tr) => tr.future.map((e, i) => ({ e, i, sp: tr.species }))),
        getPolygon: (d: any) => ellipsePolygon(d.e), filled: false, stroked: true, getLineColor: (d: any) => [255, 207, 110, 110 - d.i * 30],
        lineWidthUnits: "pixels", getLineWidth: 1, getDashArray: [3, 3], extensions: [new PathStyleExtension({ dash: true })],
      } as any));
      layers.push(new PolygonLayer({
        id: "est", data: s.tracks, getPolygon: (tr: any) => ellipsePolygon(tr.now), filled: true, stroked: true,
        getFillColor: [255, 207, 110, 55], getLineColor: [255, 207, 110, 230], lineWidthUnits: "pixels", getLineWidth: 1.5,
      }));
      layers.push(new ScatterplotLayer({
        id: "est-dot", data: s.tracks, getPosition: (tr: any) => [tr.lon, tr.lat], getRadius: 3, radiusUnits: "pixels",
        getFillColor: [255, 225, 160, 255], stroked: true, getLineColor: [2, 9, 18, 200], lineWidthUnits: "pixels", getLineWidth: 1,
      }));
      const fixes = this.fixFx.filter((f) => now - f.t0 < 5000);
      layers.push(new ScatterplotLayer({
        id: "fixes", data: fixes, getPosition: (f: any) => [f.e.lon, f.e.lat], getRadius: 1.8, radiusUnits: "pixels",
        getFillColor: (f: any) => [255, 240, 210, 220 * (1 - (now - f.t0) / 5000)], updateTriggers: { getFillColor: now },
      }));
      layers.push(new TextLayer({
        id: "track-labels", data: s.tracks.filter(() => this.view.zoom > 8.6), getPosition: (tr: any) => [tr.lon, tr.lat],
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
    const s = this.snap;
    if (!s) return;
    $("clock").textContent = clock(s.t);
    $("progressFill").style.width = `${(s.ship.progress * 100).toFixed(2)}%`;
    $("progressShip").style.left = `${(s.ship.progress * 100).toFixed(2)}%`;
    $("rdSpeed").textContent = `${s.ship.speed.toFixed(1)} kn`;
    $("rdHeading").textContent = `${Math.round(s.ship.heading).toString().padStart(3, "0")}°`;
    $("rdEta").textContent = clock(s.stats.etaS).replace("Day ", "D");
    // bubble anchored to the ship
    const bub = $("bubble");
    if (!s.activeDecision && this.bubble && this.bubble.until === Infinity) this.bubble = { ...this.bubble, until: now + 4000, title: "Maneuver complete", html: `Back on the lane · <span class="hl">${s.ship.speed.toFixed(1)} kn</span> to keep the schedule` };
    if (this.bubble && now < this.bubble.until) {
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
    if (now - this.lastPanelRender > 500) {
      this.lastPanelRender = now;
      if (this.tab === "decision" && this.shownDecision && s.activeDecision === this.shownDecision && this.shownDecision !== this.renderedDecision) {
        this.renderedDecision = this.shownDecision;
        renderDecision($("tab-decision"), this.shownDecision, this.history);
      }
      if (this.tab === "voyage" && this.init) renderVoyage($("tab-voyage"), s, this.mode, this.init.sensors.lon.length, this.init.spacingKm, this.sigmaMs);
    }
  }

  private progressMarks() {
    const el = $("progressMarks");
    if (!this.init) return;
    el.innerHTML = this.init.scenario.encounters
      .map((e) => `<div class="pmark" style="left:${(100 * e.s) / this.init!.routeLengthKm}%" data-label="${SPECIES[e.species].name.replace(" whale", "")}"></div>`)
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
    const net = this.mode === "network";
    const late = (s.t - st.scheduledArrival) / 60;
    const usd = (v: number) => `${v < 0 ? "−" : ""}$${Math.round(Math.abs(v)).toLocaleString("en-US")}`;
    $("summaryCard").innerHTML = `
      <div class="eyebrow">Voyage complete · ${net ? "sensor network" : "single buoys (today's practice)"}</div>
      <h1>${net ? `Whales avoided for <span class="grad">${usd(st.decisionsCostUsd)}</span>` : `Today's practice cost <span style="color:var(--policy)">${usd(st.decisionsCostUsd)}</span>`}</h1>
      <p class="lead">${st.conflicts} whale encounters assessed · ${st.maneuvers} manoeuvres · arrival ${Math.abs(late) < 2 ? "on schedule" : late > 0 ? `${Math.round(late)} min late` : "early"}.
        Expected lethal-strike risk ${(st.riskHold * 100).toFixed(2)}% if holding course → <b style="color:var(--good)">${(st.riskTaken * 100).toFixed(2)}%</b>.
        ${net ? `Located ${st.fixes.toLocaleString()} calls with a mean error of ${Math.round(st.meanErrorKm * 1000)} m.` : "With one buoy per area the whales could not be located, so every detection meant a blanket slow zone."}</p>
      ${net ? `<div class="cmp"><div class="cmp-card net"><h4 style="color:var(--cyan)">Sensor network</h4><div class="big">${usd(st.decisionsCostUsd)}</div><div class="small muted">targeted course / speed changes</div></div>
      <div class="cmp-card pol"><h4 style="color:var(--policy)">Today's practice (same encounters)</h4><div class="big">${usd(st.policyCostUsd)}</div><div class="small muted">blanket 10-kn slow zones</div></div></div>` : ""}
      <div class="modal-actions" style="margin-top:18px">
        <button class="btn btn-lg" id="sumAgain">Run again</button>
        <button class="btn btn-lg" id="sumSwitch">Try ${net ? "single buoys (today)" : "the sensor network"}</button>
        <button class="btn btn-lg" id="sumNew">New whales</button>
      </div>`;
    $("summary").hidden = false;
    $("sumAgain").onclick = () => { this.restart(); this.play(); };
    $("sumNew").onclick = () => { this.restart(true); this.play(); };
    $("sumSwitch").onclick = () => { this.setMode(net ? "single" : "network"); this.play(); };
  }

  // ------------------------------------------------------------------ UI wiring
  private selectTab(t: string) {
    this.tab = t;
    document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.tab === t));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.toggle("active", p.id === `tab-${t}`));
    if (t === "voyage" && this.snap && this.init) renderVoyage($("tab-voyage"), this.snap, this.mode, this.init.sensors.lon.length, this.init.spacingKm, this.sigmaMs);
  }

  private setFollow(v: boolean) {
    this.follow = v;
    ($("togFollow") as HTMLInputElement).checked = v;
  }

  private play() {
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

  private setMode(m: "network" | "single") {
    this.mode = m;
    document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", (b as HTMLElement).dataset.mode === m));
    this.restart();
  }

  private bindUi() {
    $("btnStart").onclick = () => this.play();
    $("aboutLink").onclick = (e) => { e.preventDefault(); $("intro").hidden = false; };
    $("btnPlay").onclick = () => {
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
    document.querySelectorAll<HTMLButtonElement>("#modeSeg button").forEach((b) => (b.onclick = () => this.setMode(b.dataset.mode as "network" | "single")));
    ($("routeSel") as HTMLSelectElement).onchange = (e) => { this.routeId = (e.target as HTMLSelectElement).value; this.restart(); };
    const sens = $("sensRange") as HTMLInputElement;
    sens.oninput = () => ($("sensVal").textContent = Number(sens.value).toLocaleString());
    sens.onchange = () => { this.sensorCount = Number(sens.value); if (this.mode === "network") this.restart(); };
    const sig = $("sigRange") as HTMLInputElement;
    sig.oninput = () => ($("sigVal").textContent = `${sig.value} ms`);
    sig.onchange = () => { this.sigmaMs = Number(sig.value); if (this.mode === "network") this.restart(); };
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
