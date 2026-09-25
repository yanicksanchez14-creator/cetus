/**
 * Shore stations for "Mix" mode: one quiet, cabled seafloor hydrophone a few km off each major harbour
 * (like MBARI's MARS observatory off Monterey). No surface buoy, no mooring line, power and data by cable.
 * Positions are placed seaward of each port in water deeper than ~40 m.
 */
import type { LonLat } from "./geo";

export const SHORE_STATIONS: { name: string; at: LonLat }[] = [
  { name: "Bodega Bay", at: [-123.12, 38.28] },
  { name: "San Francisco (Pt Bonita)", at: [-122.62, 37.78] },
  { name: "Half Moon Bay", at: [-122.55, 37.45] },
  { name: "Santa Cruz", at: [-122.05, 36.90] },
  { name: "Monterey (MARS)", at: [-122.186, 36.713] },
  { name: "Morro Bay", at: [-120.93, 35.36] },
  { name: "Port San Luis", at: [-120.78, 35.12] },
  { name: "Santa Barbara", at: [-119.70, 34.34] },
  { name: "Port Hueneme", at: [-119.25, 34.10] },
  { name: "LA / Long Beach", at: [-118.25, 33.66] },
];
