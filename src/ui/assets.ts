/** Map assets, inlined into the single HTML file at build time. */
import meta from "../assets/map_meta.json";
import lines from "../assets/lines.json";
import reliefCalifornia from "../assets/relief_california.webp?url";
import reliefSf from "../assets/relief_sf_monterey.webp?url";
import reliefSocal from "../assets/relief_socal.webp?url";
import depthCalifornia from "../assets/depth_california.bin?url";
import depthSf from "../assets/depth_sf_monterey.bin?url";
import depthSocal from "../assets/depth_socal.bin?url";
import type { DepthGrid } from "../engine/bathy";

const IMG: Record<string, string> = { california: reliefCalifornia, sf_monterey: reliefSf, socal: reliefSocal };
const BIN: Record<string, string> = { california: depthCalifornia, sf_monterey: depthSf, socal: depthSocal };

export interface ReliefImage {
  name: string;
  url: string;
  bounds: [number, number, number, number];
  detail: boolean;
}

export const reliefImages: ReliefImage[] = meta.images.map((m) => ({
  name: m.name, url: IMG[m.name], bounds: m.bounds as [number, number, number, number], detail: m.detail,
}));

export interface MapLine {
  level: number;
  path: [number, number][];
}
export const mapLines = lines as MapLine[];

export async function loadDepthGrids(): Promise<DepthGrid[]> {
  return Promise.all(
    meta.depth.map(async (m) => {
      const buf = await (await fetch(BIN[m.name])).arrayBuffer();
      return { ...m, z: new Int16Array(buf) } as DepthGrid;
    }),
  );
}

export const DATA_CREDIT = "Bathymetry: GMRT (Lamont-Doherty Earth Observatory), CC-BY 4.0";
