/**
 * IMPLICIT SURFACES — Phase 2, the last rung of the shape ladder before model import.
 *
 * The user types f(x,y,z); the object is everywhere f < 0, its skin the level set f = 0, trimmed
 * to the cube domain [−size, size]³ (boundary samples are forced outside, so anything reaching the
 * walls caps flat and stays watertight). This is the rung where topology gets interesting:
 * gyroids, merged metaballs, disconnected blobs — shapes no revolution or parametric map can make.
 *
 * MESH — naive surface nets (table-free marching-cubes cousin): one vertex per sign-changing cell,
 * placed at the mean of its edge crossings; one quad per sign-changing grid edge, joining the four
 * cells that share the edge. Watertight, well-shaped triangles, no 256-entry tables.
 *
 * MASS — the Module-M voxel path, finally on stage: per-cell occupancy fraction (inside corners/8)
 * × cell volume, summed into volume / c.o.m. / full inertia tensor (plus each voxel's own cube
 * term). No closed form exists for these shapes; the voxel sum is robust for ANY topology.
 *
 * COLLIDER — the occupancy voxels again, greedy-merged into as few solid boxes as possible and
 * attached as a compound of cuboids. Concave-true: a marble rolls through a gyroid's tunnels.
 * Honest note: contact geometry is blocky at ~size/16 resolution — coarser than the render mesh.
 */
import * as THREE from 'three';
import { parseExpression } from './expr';
import { eigenSymmetric3 } from './shapes';

export interface ImplicitSpec {
  fxyz: string; // inside where f < iso
  iso: number; // level-set value (the UI keeps this at 0)
  size: number; // domain half-extent — the shape lives in [−size, size]³
  density: number;
}

export interface BuiltImplicit {
  geometry: THREE.BufferGeometry; // centered on the center of mass, box-projected UVs
  boxes: Array<{ center: [number, number, number]; half: [number, number, number] }>; // compound collider
  supportPoints: Float32Array; // box corners — exact floor-clamp support
  volume: number;
  mass: number;
  inertia: { x: number; y: number; z: number };
  inertiaFrame: { x: number; y: number; z: number; w: number };
  maxRadius: number;
}

export type ImplicitResult = { ok: true; shape: BuiltImplicit } | { ok: false; error: string };

const MESH_N = 64; // cells per axis: mesh + voxel-mass resolution
const BOX_N = 16; // collider voxels per axis (divides MESH_N); falls back to 8 if too many boxes
const MAX_BOXES = 384;

// cell-corner offsets and the 12 edges between them (index pairs into CORNERS)
const CORNERS = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
] as const;
const EDGES = [
  [0, 1], [2, 3], [4, 5], [6, 7], // along x
  [0, 2], [1, 3], [4, 6], [5, 7], // along y
  [0, 4], [1, 5], [2, 6], [3, 7], // along z
] as const;

export function buildImplicit(spec: ImplicitSpec): ImplicitResult {
  const parsed = parseExpression(spec.fxyz);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const other = parsed.expr.vars.filter((n) => n !== 'x' && n !== 'y' && n !== 'z');
  if (other.length) return { ok: false, error: `Only "x", "y", "z" are allowed (found "${other[0]}").` };
  const compiled = parsed.expr;

  const { size, iso } = spec;
  if (!isFinite(size) || !(size > 0.2)) return { ok: false, error: 'Domain size must be at least 0.2.' };
  if (size > 20) return { ok: false, error: 'Domain size is capped at 20.' };
  const density = spec.density > 0 ? spec.density : 1;

  // ---- sample the field at cell corners; force the boundary layer outside (caps at the walls) ----
  const N = MESH_N, NP = N + 1;
  const h = (2 * size) / N;
  const F = new Float32Array(NP * NP * NP);
  const fi = (i: number, j: number, k: number) => (i * NP + j) * NP + k;
  const scope: Record<string, number> = { x: 0, y: 0, z: 0 };
  let anyInside = false;
  for (let i = 0; i <= N; i++) {
    scope.x = -size + i * h;
    for (let j = 0; j <= N; j++) {
      scope.y = -size + j * h;
      for (let k = 0; k <= N; k++) {
        scope.z = -size + k * h;
        let g = compiled.eval(scope) - iso;
        if (!isFinite(g)) {
          return { ok: false, error: `f is not finite near (${scope.x.toFixed(1)}, ${scope.y.toFixed(1)}, ${scope.z.toFixed(1)}).` };
        }
        if (i === 0 || i === N || j === 0 || j === N || k === 0 || k === N) g = Math.max(g, 1e-4);
        else if (g < 0) anyInside = true;
        F[fi(i, j, k)] = g;
      }
    }
  }
  if (!anyInside) return { ok: false, error: 'Nothing is inside — f < 0 nowhere in the domain.' };

  // ---- voxel mass: occupancy fraction per cell (inside corners / 8) ----
  const frac = new Float32Array(N * N * N);
  const ci = (i: number, j: number, k: number) => (i * N + j) * N + k;
  let vol = 0;
  const S1 = new THREE.Vector3();
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const cellVol = h * h * h;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      for (let k = 0; k < N; k++) {
        let cnt = 0;
        for (const [a, b, c] of CORNERS) if (F[fi(i + a, j + b, k + c)] < 0) cnt++;
        if (!cnt) continue;
        const f8 = cnt / 8;
        frac[ci(i, j, k)] = f8;
        const dv = f8 * cellVol;
        vol += dv;
        const cx = -size + (i + 0.5) * h, cy = -size + (j + 0.5) * h, cz = -size + (k + 0.5) * h;
        S1.x += dv * cx; S1.y += dv * cy; S1.z += dv * cz;
        C[0][0] += dv * (cx * cx + (h * h) / 12); // point term + the voxel's own cube term
        C[1][1] += dv * (cy * cy + (h * h) / 12);
        C[2][2] += dv * (cz * cz + (h * h) / 12);
        C[0][1] += dv * cx * cy; C[0][2] += dv * cx * cz; C[1][2] += dv * cy * cz;
      }
    }
  }
  if (vol < 1e-4) return { ok: false, error: 'Enclosed volume is ~zero.' };
  C[1][0] = C[0][1]; C[2][0] = C[0][2]; C[2][1] = C[1][2];
  const volume = vol;
  const mass = density * volume;
  const com = S1.clone().divideScalar(vol);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] *= density;
  // parallel axis to the c.o.m., then I = tr(C)δ − C
  const cArr = [com.x, com.y, com.z];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] -= mass * cArr[r] * cArr[c];
  const trC = C[0][0] + C[1][1] + C[2][2];
  const I = [
    [trC - C[0][0], -C[0][1], -C[0][2]],
    [-C[1][0], trC - C[1][1], -C[1][2]],
    [-C[2][0], -C[2][1], trC - C[2][2]],
  ];
  const eig = eigenSymmetric3(I);
  const principal = eig.values.map((v) => Math.max(v, 1e-9));
  const [b0, b1] = eig.vectors;
  const b2 = new THREE.Vector3().crossVectors(b0, b1);
  const frame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(b0, b1, b2));

  // ---- surface nets mesh ----
  // one vertex per sign-changing cell: the mean of its edge crossings
  const cellVert = new Int32Array(N * N * N).fill(-1);
  const positions: number[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      for (let k = 0; k < N; k++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) if (F[fi(i + CORNERS[c][0], j + CORNERS[c][1], k + CORNERS[c][2])] < 0) mask |= 1 << c;
        if (mask === 0 || mask === 255) continue;
        let px = 0, py = 0, pz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const ina = (mask >> a) & 1, inb = (mask >> b) & 1;
          if (ina === inb) continue;
          const fa = F[fi(i + CORNERS[a][0], j + CORNERS[a][1], k + CORNERS[a][2])];
          const fb = F[fi(i + CORNERS[b][0], j + CORNERS[b][1], k + CORNERS[b][2])];
          const t = fa / (fa - fb);
          px += i + CORNERS[a][0] + t * (CORNERS[b][0] - CORNERS[a][0]);
          py += j + CORNERS[a][1] + t * (CORNERS[b][1] - CORNERS[a][1]);
          pz += k + CORNERS[a][2] + t * (CORNERS[b][2] - CORNERS[a][2]);
          n++;
        }
        cellVert[ci(i, j, k)] = positions.length / 3;
        positions.push(-size + (px / n) * h, -size + (py / n) * h, -size + (pz / n) * h);
      }
    }
  }
  // one quad per sign-changing grid edge, joining the 4 cells around it
  const indices: number[] = [];
  const quad = (v00: number, v01: number, v11: number, v10: number, flip: boolean) => {
    if (v00 < 0 || v01 < 0 || v11 < 0 || v10 < 0) return;
    if (flip) indices.push(v00, v01, v11, v00, v11, v10);
    else indices.push(v00, v10, v11, v00, v11, v01);
  };
  for (let i = 0; i < N; i++) {
    for (let j = 1; j < N; j++) {
      for (let k = 1; k < N; k++) {
        // x-edge (i..i+1, j, k) — cells vary in j,k
        const inA = F[fi(i, j, k)] < 0;
        if (inA !== (F[fi(i + 1, j, k)] < 0)) {
          quad(cellVert[ci(i, j - 1, k - 1)], cellVert[ci(i, j, k - 1)], cellVert[ci(i, j, k)], cellVert[ci(i, j - 1, k)], inA);
        }
        // y-edge (j..j+1) at grid point (i, ·, k) reusing loop symmetry: cells vary in i,k
        const inB = F[fi(j, i, k)] < 0; // reuse indices with roles swapped (i↔j)
        if (inB !== (F[fi(j, i + 1, k)] < 0)) {
          quad(cellVert[ci(j - 1, i, k - 1)], cellVert[ci(j - 1, i, k)], cellVert[ci(j, i, k)], cellVert[ci(j, i, k - 1)], inB);
        }
        // z-edge (k..k+1) at grid point (i, j, ·) with roles rotated: cells vary in i,j
        const inC = F[fi(j, k, i)] < 0;
        if (inC !== (F[fi(j, k, i + 1)] < 0)) {
          quad(cellVert[ci(j - 1, k - 1, i)], cellVert[ci(j, k - 1, i)], cellVert[ci(j, k, i)], cellVert[ci(j - 1, k, i)], inC);
        }
      }
    }
  }
  if (!indices.length) return { ok: false, error: 'The surface never crosses f = 0 inside the domain.' };

  // center on the c.o.m., normals from topology, box-projected UVs (~2 world units per tile)
  const posArr = new Float32Array(positions.length);
  let maxRadius = 0;
  for (let k = 0; k < positions.length; k += 3) {
    posArr[k] = positions[k] - com.x;
    posArr[k + 1] = positions[k + 1] - com.y;
    posArr[k + 2] = positions[k + 2] - com.z;
    maxRadius = Math.max(maxRadius, Math.hypot(posArr[k], posArr[k + 1], posArr[k + 2]));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const nor = geometry.getAttribute('normal');
  const uvs = new Float32Array((posArr.length / 3) * 2);
  for (let v = 0; v < posArr.length / 3; v++) {
    const nx = Math.abs(nor.getX(v)), ny = Math.abs(nor.getY(v)), nz = Math.abs(nor.getZ(v));
    const px = posArr[v * 3], py = posArr[v * 3 + 1], pz = posArr[v * 3 + 2];
    if (nx >= ny && nx >= nz) { uvs[v * 2] = pz / 2; uvs[v * 2 + 1] = py / 2; }
    else if (ny >= nz) { uvs[v * 2] = px / 2; uvs[v * 2 + 1] = pz / 2; }
    else { uvs[v * 2] = px / 2; uvs[v * 2 + 1] = py / 2; }
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

  // ---- collider: occupancy voxels greedy-merged into boxes ----
  let boxes = greedyBoxes(frac, N, BOX_N, size, com);
  if (boxes.length > MAX_BOXES) boxes = greedyBoxes(frac, N, 8, size, com);
  const support: number[] = [];
  for (const b of boxes) {
    for (const [a, bb, c] of CORNERS) {
      support.push(
        b.center[0] + (a * 2 - 1) * b.half[0],
        b.center[1] + (bb * 2 - 1) * b.half[1],
        b.center[2] + (c * 2 - 1) * b.half[2],
      );
    }
  }

  return {
    ok: true,
    shape: {
      geometry, boxes, supportPoints: new Float32Array(support), volume, mass,
      inertia: { x: principal[0], y: principal[1], z: principal[2] },
      inertiaFrame: { x: frame.x, y: frame.y, z: frame.z, w: frame.w },
      maxRadius,
    },
  };
}

/** Downsample fine occupancy fractions to a coarse voxel grid, then merge runs into solid boxes. */
function greedyBoxes(
  frac: Float32Array, N: number, Nc: number, size: number, com: THREE.Vector3,
): BuiltImplicit['boxes'] {
  const f = N / Nc; // fine cells per coarse voxel per axis
  const hc = (2 * size) / Nc;
  const occ = new Uint8Array(Nc * Nc * Nc);
  const oi = (i: number, j: number, k: number) => (i * Nc + j) * Nc + k;
  const fiC = (i: number, j: number, k: number) => (i * N + j) * N + k;
  let threshold = (f * f * f) / 2; // at least half the voxel's sub-cells occupied…
  let total = 0;
  for (let pass = 0; pass < 2 && !total; pass++) {
    for (let i = 0; i < Nc; i++) {
      for (let j = 0; j < Nc; j++) {
        for (let k = 0; k < Nc; k++) {
          let s = 0;
          for (let a = 0; a < f; a++) for (let b = 0; b < f; b++) for (let c = 0; c < f; c++) {
            s += frac[fiC(i * f + a, j * f + b, k * f + c)];
          }
          if (s >= threshold) { occ[oi(i, j, k)] = 1; total++; }
        }
      }
    }
    threshold = (f * f * f) / 16; // …unless the shape is so thin nothing qualifies — lower the bar
  }
  const visited = new Uint8Array(Nc * Nc * Nc);
  const free = (i: number, j: number, k: number) => occ[oi(i, j, k)] === 1 && visited[oi(i, j, k)] === 0;
  const boxes: BuiltImplicit['boxes'] = [];
  for (let i = 0; i < Nc; i++) {
    for (let j = 0; j < Nc; j++) {
      for (let k = 0; k < Nc; k++) {
        if (!free(i, j, k)) continue;
        // grow a solid box: run along k, widen along j, deepen along i
        let dk = 1;
        while (k + dk < Nc && free(i, j, k + dk)) dk++;
        let dj = 1;
        grow_j: while (j + dj < Nc) {
          for (let kk = 0; kk < dk; kk++) if (!free(i, j + dj, k + kk)) break grow_j;
          dj++;
        }
        let di = 1;
        grow_i: while (i + di < Nc) {
          for (let jj = 0; jj < dj; jj++) for (let kk = 0; kk < dk; kk++) {
            if (!free(i + di, j + jj, k + kk)) break grow_i;
          }
          di++;
        }
        for (let ii = 0; ii < di; ii++) for (let jj = 0; jj < dj; jj++) for (let kk = 0; kk < dk; kk++) {
          visited[oi(i + ii, j + jj, k + kk)] = 1;
        }
        boxes.push({
          center: [
            -size + (i + di / 2) * hc - com.x,
            -size + (j + dj / 2) * hc - com.y,
            -size + (k + dk / 2) * hc - com.z,
          ],
          half: [(di * hc) / 2, (dj * hc) / 2, (dk * hc) / 2],
        });
      }
    }
  }
  return boxes;
}

/** Presets for the implicit creator — inside where f < 0, all self-bounded within their domain. */
export interface ImplicitPreset { name: string; fxyz: string; size: number; }
export const IMPLICIT_PRESETS: ImplicitPreset[] = [
  { name: 'Gyroid', fxyz: 'max(sin(2*x)*cos(2*y)+sin(2*y)*cos(2*z)+sin(2*z)*cos(2*x)+0.35, x^2+y^2+z^2-4)', size: 2.2 },
  { name: 'Metaballs', fxyz: '1 - 0.9/((x-1)^2+y^2+z^2+0.05) - 0.9/((x+1)^2+y^2+z^2+0.05) - 0.9/(x^2+(y-1.2)^2+z^2+0.05)', size: 2.6 },
  { name: 'Heart', fxyz: '(x^2+9/4*z^2+y^2-1)^3 - x^2*y^3 - 9/80*z^2*y^3', size: 1.4 },
  { name: 'Blob', fxyz: 'x^2+y^2+z^2 - (1.25+0.35*sin(4*x)*sin(4*y)*sin(4*z))^2', size: 1.8 },
];
