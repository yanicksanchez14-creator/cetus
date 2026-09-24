/** Water depth lookup from the GMRT grids (detailed hotspot grids first, then the whole-coast grid). */
export interface DepthGridMeta {
  name: string;
  nx: number;
  ny: number;
  west: number;
  north: number;
  cell: number; // degrees
  detail: boolean;
}

export interface DepthGrid extends DepthGridMeta {
  z: Int16Array; // metres, row 0 = north; negative = below sea level
}

export class DepthModel {
  private grids: DepthGrid[];
  constructor(grids: DepthGrid[]) {
    // detailed grids are consulted first
    this.grids = [...grids].sort((a, b) => Number(b.detail) - Number(a.detail));
  }

  /** Elevation in metres at lon/lat (negative = water depth). Outside all grids: open ocean (-4000 m). */
  elevation(lon: number, lat: number): number {
    for (const g of this.grids) {
      const fx = (lon - g.west) / g.cell - 0.5;
      const fy = (g.north - lat) / g.cell - 0.5;
      if (fx < 0 || fy < 0 || fx > g.nx - 1 || fy > g.ny - 1) continue;
      // bilinear interpolation
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, g.nx - 1);
      const y1 = Math.min(y0 + 1, g.ny - 1);
      const tx = fx - x0;
      const ty = fy - y0;
      const z00 = g.z[y0 * g.nx + x0];
      const z10 = g.z[y0 * g.nx + x1];
      const z01 = g.z[y1 * g.nx + x0];
      const z11 = g.z[y1 * g.nx + x1];
      return (z00 * (1 - tx) + z10 * tx) * (1 - ty) + (z01 * (1 - tx) + z11 * tx) * ty;
    }
    return -4000;
  }

  isWater(lon: number, lat: number, minDepth = 0): boolean {
    return this.elevation(lon, lat) < -minDepth;
  }
}
