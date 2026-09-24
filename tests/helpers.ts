import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DepthModel, type DepthGrid } from "../src/engine/bathy";

export function loadDepthModel(): DepthModel {
  const dir = resolve(__dirname, "../src/assets");
  const meta = JSON.parse(readFileSync(resolve(dir, "map_meta.json"), "utf8"));
  const grids: DepthGrid[] = meta.depth.map((m: any) => {
    const buf = readFileSync(resolve(dir, m.file));
    return { ...m, z: new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2) };
  });
  return new DepthModel(grids);
}
