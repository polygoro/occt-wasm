/**
 * projectEdges outline on BSpline surfaces. HLRBRep_Algo returned no outline
 * for a loft through five 48-point spline sections, so a drawing showed only
 * the end loops and the seam. Contap_HContTool::SamplePoint had its U and V
 * grid indices swapped: on a surface with unequal sample counts its interior
 * start points fell into two narrow U columns, mostly outside the V range,
 * and Contap_Contour found no contour line. Fixed by
 * patches/0002-Contap-sample-the-whole-BSpline-surface-*.patch.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let kernel: any;

beforeAll(async () => {
    const jsPath = resolve(__dirname, "../dist/occt-wasm.js");
    const wasmPath = resolve(__dirname, "../dist/occt-wasm.wasm");
    const createModule = (await import(jsPath)).default;
    const Module = await createModule({
        locateFile: (path: string) => (path.endsWith(".wasm") ? wasmPath : path),
    });
    const { OcctKernel } = await import(resolve(__dirname, "../ts/src/index.ts"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    kernel = new (OcctKernel as any)(Module);
}, 30_000);

afterEach(() => {
    kernel.releaseAll();
});

afterAll(() => {
    kernel[Symbol.dispose]();
});

/** A petal-shaped section r(t) = R(1 + 0.08 cos 8t), turned by `rot` degrees. */
function petal(R: number, z: number, rot: number): unknown {
    const pts = [];
    for (let k = 0; k < 48; k++) {
        const t = (2 * Math.PI * k) / 48;
        const r = R * (1 + 0.08 * Math.cos(8 * t));
        const a = t + (rot * Math.PI) / 180;
        pts.push({ x: r * Math.cos(a), y: r * Math.sin(a), z });
    }
    return kernel.makeWire([kernel.interpolatePoints(pts, true)]);
}

describe("projectEdges outline on freeform surfaces", () => {
    it("draws the silhouette of a twisted loft seen from the front", () => {
        const levels: [number, number, number][] = [
            [30, 0, 0], [40, 45, 15], [47, 99, 33], [28, 144, 48], [25, 180, 60],
        ];
        const body = kernel.loft(levels.map(([R, z, rot]) => petal(R, z, rot)), true, false);
        const p = kernel.projectEdges(body, { x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }, { x: 1, y: 0, z: 0 });
        expect(p.visibleOutline).toBeGreaterThan(0);
        // Left and right silhouettes each run the full 180mm height.
        expect(kernel.getLength(p.visibleOutline)).toBeGreaterThan(2 * 180);
        const bb = kernel.getBoundingBox(p.visibleOutline);
        expect(bb.xmax - bb.xmin).toBeGreaterThan(2 * 47);
    });
});
