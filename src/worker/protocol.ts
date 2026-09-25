/** Messages between the map (main thread) and the simulation (Web Worker). */
import type { DepthGrid } from "../engine/bathy";
import type { SimOptions } from "../engine/sim";
import type { Decision } from "../engine/decision";
import type { CautionPrompt, Strike } from "../engine/sim";
import type { SpeciesId } from "../engine/physics";

export type ToWorker =
  | { type: "init"; options: Partial<SimOptions>; grids: DepthGrid[] }
  | { type: "step"; dt: number }
  | { type: "skip" } // fast-forward until the next manoeuvre decision (or 8 h)
  | { type: "caution"; slow: boolean } // answer to a "whale heard ahead, not located" prompt
  // headless run to the end (Fleet lab): no snapshots, just the voyage summary. Grids only on a worker's first job.
  | { type: "batch"; jobId: number; options: Partial<SimOptions>; grids?: DepthGrid[] };

export interface EllipseLL {
  lon: number;
  lat: number;
  a: number; // km
  b: number; // km
  angle: number; // radians from east
}

export interface SnapWhale {
  id: number;
  species: SpeciesId;
  lon: number;
  lat: number;
  heading: number; // radians (math convention)
  active: boolean;
  conflict: boolean;
  trail: [number, number][];
}

export interface SnapTrack {
  id: number;
  species: SpeciesId;
  lon: number;
  lat: number;
  now: EllipseLL;
  future: EllipseLL[]; // +15, +30, +45 min
  history: [number, number][];
  nFixes: number;
  speedKn: number;
  heading: number; // radians (math convention)
  ageS: number;
}

export interface SnapCall {
  id: number;
  t: number;
  whaleId: number;
  species: SpeciesId;
  lon: number;
  lat: number;
  sensors: number[]; // ids of buoys that heard it (buoy modes)
  from?: [number, number][]; // ships mode: positions of the ships that heard / saw it
  kind?: "call" | "sighting"; // sighting = thermal camera
  fix?: EllipseLL;
  errorKm?: number;
  rangeKm: number;
}

export interface SnapZone {
  lon: number;
  lat: number;
  r: number;
  ageS: number;
  species: SpeciesId;
}

export interface Snapshot {
  t: number;
  finished: boolean;
  ship: { lon: number; lat: number; heading: number; speed: number; s: number; progress: number };
  planVersion: number;
  plannedPath?: [number, number][];
  maneuverZone: [number, number][] | null; // lon/lat path of the active conflict zone along the lane
  whales: SnapWhale[];
  tracks: SnapTrack[];
  zones: SnapZone[];
  calls: SnapCall[]; // new since last snapshot
  traffic?: { lon: number[]; lat: number[]; hdg: number[]; cls: number[]; heard: number[] }; // ships mode
  coverage: { s: number; lon: number; lat: number; hump: number; fin: number }[]; // new blind-spot samples
  cautionPrompt: CautionPrompt | null; // waiting for the user's answer (sim is paused by the UI meanwhile)
  cautionActive: boolean;
  strikes: Strike[]; // new since last snapshot
  nearMisses: { species: SpeciesId; distM: number; deep: boolean; singer: boolean; speedKn: number }[];
  ahead: { lon: number; lat: number; hump: number; fin: number }[]; // blind spots on the route ahead // new since last snapshot
  decisions: Decision[]; // new since last snapshot
  activeDecision: Decision | null;
  stats: {
    calls: number;
    detections: number;
    fixes: number;
    meanErrorKm: number;
    fuelUsed: number;
    baselineFuelSoFar: number;
    scheduledArrival: number;
    etaS: number;
    conflicts: number;
    maneuvers: number;
    decisionsCostUsd: number; // MEASURED extra cost so far (fuel vs holding speed + time behind schedule)
    actualFuelDeltaT: number;
    behindMin: number;
    /** whole trip at 16 kn with no whale changes: fuel $ + ship time $ (the "normal" voyage) */
    normalTripUsd: number;
    normalTripFuelUsd: number;
    timeCostPerHour: number;
    riskHold: number;
    riskTaken: number;
    riskPolicy: number; // same encounters handled with today's blanket slow zones
    sightings: number;
    policyLateMin: number;
    cautions: number;
    cautionMin: number;
    strikes: number;
    lethalStrikes: number; // today's practice: minutes late it could not make up // ships mode: thermal-camera sightings
    shipsContributing: number; // ships mode: ships whose hydrophone or camera contributed
    policyCostUsd: number;
  };
}

export interface InitReply {
  type: "ready";
  sensors: { lon: Float32Array; lat: Float32Array; phase: Float32Array };
  spacingKm: number;
  route: [number, number][];
  routeLengthKm: number;
  scenario: { encounters: { label: string; s: number; species: SpeciesId }[] };
  traffic?: { source: string; synthetic: boolean; ships: number; date: string };
  stations?: { name: string; lon: number; lat: number }[];
}

export type FromWorker = InitReply | ({ type: "snap" } & Snapshot);
export type BatchReply = { type: "batchResult"; jobId: number; summary: import("../engine/summary").VoyageSummary };
