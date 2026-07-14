/**
 * SHAPES SYSTEM — Phase 2 (the differentiator).
 *
 * The generality ladder (see docs/FEATURES.md §shapes):
 *   f(x) revolved         -> THREE.LatheGeometry           (vases, tops, eggs)   <-- IMPLEMENTED
 *   parametric curve      -> THREE.TubeGeometry            (springs, helices, knots)
 *   parametric surface    -> ParametricGeometry            (torus, seashells, Möbius)
 *   implicit / SDF        -> marching cubes                (gyroids, metaballs)
 *   superformula (Gielis) -> parametric eval               (shells, flowers, crystals)
 *
 * MASS PROPERTIES — the whole point. A solid of revolution has *closed-form* integrals for volume,
 * center of mass, and the full inertia tensor. We evaluate them by Simpson quadrature of the profile
 * f(x) and hand the exact tensor to Rapier (see Sandbox.createRevolution), so a lopsided vase or a
 * top tumbles with correct dynamics — not as if it were a uniform blob. This is the "Module-M"
 * promise made visible, and it's what a toy engine can't do.
 *
 * For a profile r = f(x), x ∈ [a,b], revolved about the vertical (Y) axis (x becomes height):
 *   V    = π ∫ f²           (volume)
 *   x_cm = (∫ x·f²) / (∫ f²)                                   (center of mass along the axis)
 *   I_y  = ½ρπ ∫ f⁴                                            (about the symmetry axis)
 *   I_x  = I_z = ρπ ∫ (¼ f⁴ + (x−x_cm)² f²)                    (transverse, through the c.o.m.)
 * The tensor is diagonal in the body's local axes, so no rotation frame is needed. Geometry is built
 * centered on x_cm, so the body origin *is* the center of mass.
 *
 * Collider: convex hull of the revolved profile (fast, fills any concavity — honest for a first
 * slice; an exact concave collider via convex decomposition is a later upgrade).
 */
import * as THREE from 'three';
import { parseExpression } from './expr';

/** The target spec set for Phase 2 (see the ladder above); `revolution` is implemented. */
export type ShapeSpec =
  | { type: 'box'; half: [number, number, number] }
  | { type: 'sphere'; radius: number }
  | { type: 'revolution'; fx: string; a: number; b: number }
  | { type: 'paramCurve'; xt: string; yt: string; zt: string; t0: number; t1: number; tube: number }
  | { type: 'paramSurface'; xuv: string; yuv: string; zuv: string; u0: number; u1: number; v0: number; v1: number; mode: 'shell' | 'solid'; thickness: number }
  | { type: 'implicit'; fxyz: string; iso: number }
  | { type: 'import'; url: string };

export interface RevolutionSpec {
  expr: string; // radius as a function of x (the axis coordinate)
  a: number; // domain start
  b: number; // domain end
  density: number; // kg per cubic sim-unit
  segments?: number; // radial resolution
}

export interface BuiltRevolution {
  geometry: THREE.BufferGeometry; // centered on the center of mass
  hull: Float32Array; // point cloud (x,y,z triplets) for a convex-hull collider
  volume: number; // m³
  mass: number; // kg
  inertia: { x: number; y: number; z: number }; // principal moments about the c.o.m. (I_x=I_z, I_y=axis)
  comHeight: number; // c.o.m. height in the original (uncentered) domain — informational
  height: number; // b − a
  maxRadius: number;
}

export type RevolutionResult = { ok: true; shape: BuiltRevolution } | { ok: false; error: string };

const INTEG_STEPS = 400; // even → Simpson's rule for the mass integrals
const PROFILE_SAMPLES = 128; // lathe profile resolution

export function buildRevolution(spec: RevolutionSpec): RevolutionResult {
  const parsed = parseExpression(spec.expr);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const compiled = parsed.expr;
  const otherVars = compiled.vars.filter((v) => v !== 'x');
  if (otherVars.length) return { ok: false, error: `Only "x" is allowed here (found "${otherVars[0]}").` };
  const f = (x: number): number => compiled.eval({ x });

  const { a, b } = spec;
  if (!isFinite(a) || !isFinite(b)) return { ok: false, error: 'Domain must be finite numbers.' };
  if (!(b > a)) return { ok: false, error: 'Domain end must be greater than start.' };

  const density = spec.density > 0 ? spec.density : 1;
  const N = INTEG_STEPS;
  const h = (b - a) / N;

  // sample the profile; validate finiteness and non-negativity (radius can't be < 0)
  const r = new Array<number>(N + 1);
  for (let i = 0; i <= N; i++) {
    const x = a + i * h;
    let v = f(x);
    if (!isFinite(v)) return { ok: false, error: `f(${x.toFixed(2)}) is not a finite number.` };
    if (v < -1e-6) return { ok: false, error: `Radius goes negative near x=${x.toFixed(2)} (f must be ≥ 0).` };
    if (v < 0) v = 0;
    r[i] = v;
  }

  // Simpson's rule over precomputed sample values g[0..N]
  const simpson = (g: number[]): number => {
    let s = g[0] + g[N];
    for (let i = 1; i < N; i++) s += g[i] * (i % 2 ? 4 : 2);
    return (s * h) / 3;
  };

  const f2 = r.map((v) => v * v);
  const f4 = r.map((v) => v * v * v * v);
  const xf2 = r.map((v, i) => (a + i * h) * v * v);

  const S0 = simpson(f2); // ∫ f²
  if (S0 <= 1e-9) return { ok: false, error: 'Shape encloses ~zero volume.' };
  const S1 = simpson(xf2); // ∫ x·f²
  const S4 = simpson(f4); // ∫ f⁴
  const xcm = S1 / S0;
  const f2c = r.map((v, i) => { const d = a + i * h - xcm; return d * d * v * v; });
  const S2c = simpson(f2c); // ∫ (x−x_cm)²·f²

  const volume = Math.PI * S0;
  const mass = density * volume;
  const Iy = 0.5 * density * Math.PI * S4; // symmetry (vertical) axis
  const Ix = density * Math.PI * (0.25 * S4 + S2c); // transverse, through the c.o.m.

  const maxRadius = Math.max(...r);

  // ---- geometry: LatheGeometry from the profile, centered on the c.o.m., end-capped ----
  const segments = spec.segments ?? 48;
  const pts: THREE.Vector2[] = [];
  const rStart = Math.max(f(a), 0);
  if (rStart > 1e-4) pts.push(new THREE.Vector2(0, a - xcm)); // flat cap at the bottom
  for (let i = 0; i <= PROFILE_SAMPLES; i++) {
    const x = a + ((b - a) * i) / PROFILE_SAMPLES;
    pts.push(new THREE.Vector2(Math.max(f(x), 0), x - xcm));
  }
  const rEnd = Math.max(f(b), 0);
  if (rEnd > 1e-4) pts.push(new THREE.Vector2(0, b - xcm)); // flat cap at the top
  const geometry = new THREE.LatheGeometry(pts, segments);
  geometry.computeVertexNormals();

  // ---- convex-hull point cloud (coarser than the render mesh) ----
  const hullProfile = 48;
  const hullAngles = 18;
  const cloud: number[] = [];
  for (let i = 0; i <= hullProfile; i++) {
    const x = a + ((b - a) * i) / hullProfile;
    const rr = Math.max(f(x), 0);
    const y = x - xcm;
    if (rr < 1e-5) { cloud.push(0, y, 0); continue; }
    for (let j = 0; j < hullAngles; j++) {
      const th = (2 * Math.PI * j) / hullAngles;
      cloud.push(rr * Math.cos(th), y, rr * Math.sin(th));
    }
  }

  return {
    ok: true,
    shape: {
      geometry,
      hull: new Float32Array(cloud),
      volume,
      mass,
      inertia: { x: Ix, y: Iy, z: Ix },
      comHeight: xcm,
      height: b - a,
      maxRadius,
    },
  };
}

/** Preset profiles for the shape creator — all guaranteed f ≥ 0 across their domain. */
export interface RevPreset { name: string; expr: string; a: number; b: number; }
export const REV_PRESETS: RevPreset[] = [
  { name: 'Vase', expr: '1.1 + 0.55*sin(x*0.9)', a: 0, b: 6 },
  { name: 'Egg', expr: '1.3*sqrt(max(1 - ((x-1.6)/1.6)^2, 0))', a: 0, b: 3.2 },
  { name: 'Top', expr: '1.4*sqrt(max(x,0))*exp(-0.5*x)', a: 0, b: 4 },
  { name: 'Dome', expr: 'sqrt(max(4 - x^2, 0))', a: 0, b: 2 },
];

// ============================================================ parametric curves
//
// x(t), y(t), z(t) swept into a tube of radius r (springs, knots, rings). Mass properties are
// integrated numerically along the centerline: each short segment is treated as a solid cylinder
// (its own axial/transverse inertia + parallel-axis transfer to the c.o.m.). Unlike a revolution
// solid, the resulting tensor is NOT diagonal in body axes, so we diagonalize it (Jacobi) and hand
// Rapier the principal moments plus the principal-frame quaternion.
//
// Collision: a chain of capsules along the curve — honest concave collision (a ball can pass
// through a spring's coils), where a convex hull would dishonestly fill them in.

export interface ParamCurveSpec {
  xt: string; yt: string; zt: string; // coordinates as functions of t
  t0: number; t1: number;
  tube: number; // tube (cross-section) radius
  density: number;
}

export interface BuiltParamCurve {
  geometry: THREE.BufferGeometry; // centered on the center of mass
  capsules: Array<{ center: [number, number, number]; halfHeight: number; quat: [number, number, number, number] }>;
  tube: number;
  length: number; // centerline arc length
  volume: number;
  mass: number;
  inertia: { x: number; y: number; z: number }; // principal moments about the c.o.m.
  inertiaFrame: { x: number; y: number; z: number; w: number }; // rotation into the principal frame
  maxRadius: number; // bounding radius (for fallback collider + spawn height)
  closed: boolean;
}

export type ParamCurveResult = { ok: true; shape: BuiltParamCurve } | { ok: false; error: string };

const CURVE_SAMPLES = 600; // mass-integration resolution along t

/** Jacobi eigendecomposition of a symmetric 3×3 matrix → eigenvalues + orthonormal eigenvectors. */
function eigenSymmetric3(A: number[][]): { values: number[]; vectors: THREE.Vector3[] } {
  const a = A.map((row) => row.slice());
  let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-12) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(a[p][q]) < 1e-14) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return {
    values: [a[0][0], a[1][1], a[2][2]],
    vectors: [
      new THREE.Vector3(v[0][0], v[1][0], v[2][0]),
      new THREE.Vector3(v[0][1], v[1][1], v[2][1]),
      new THREE.Vector3(v[0][2], v[1][2], v[2][2]),
    ],
  };
}

export function buildParamCurve(spec: ParamCurveSpec): ParamCurveResult {
  // compile the three coordinate expressions; only "t" may appear
  const fns: Array<(t: number) => number> = [];
  for (const [label, src] of [['x(t)', spec.xt], ['y(t)', spec.yt], ['z(t)', spec.zt]] as const) {
    const parsed = parseExpression(src);
    if (!parsed.ok) return { ok: false, error: `${label}: ${parsed.error}` };
    const other = parsed.expr.vars.filter((v) => v !== 't');
    if (other.length) return { ok: false, error: `${label}: only "t" is allowed (found "${other[0]}").` };
    const compiled = parsed.expr;
    fns.push((t: number) => compiled.eval({ t }));
  }
  const [fx, fy, fz] = fns;

  const { t0, t1, tube } = spec;
  if (!isFinite(t0) || !isFinite(t1)) return { ok: false, error: 'Domain must be finite numbers.' };
  if (!(t1 > t0)) return { ok: false, error: 'Domain end must be greater than start.' };
  if (!(tube > 0.015)) return { ok: false, error: 'Tube radius must be at least 0.02.' };
  const density = spec.density > 0 ? spec.density : 1;

  // ---- sample the centerline ----
  const N = CURVE_SAMPLES;
  const pts: THREE.Vector3[] = new Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const t = t0 + ((t1 - t0) * i) / N;
    const x = fx(t), y = fy(t), z = fz(t);
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
      return { ok: false, error: `Curve is not finite near t=${t.toFixed(2)}.` };
    }
    pts[i] = new THREE.Vector3(x, y, z);
  }

  // arc length + center of mass (uniform tube → mass ∝ length)
  let length = 0;
  const com = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const ds = pts[i + 1].distanceTo(pts[i]);
    length += ds;
    com.addScaledVector(new THREE.Vector3().addVectors(pts[i], pts[i + 1]).multiplyScalar(0.5), ds);
  }
  if (length < 1e-4) return { ok: false, error: 'Curve has ~zero length (is it a single point?).' };
  com.divideScalar(length);
  if (tube > length / 4) return { ok: false, error: 'Tube radius is too large for this curve length.' };

  const volume = Math.PI * tube * tube * length; // thin-tube approximation (ignores coil self-overlap)
  const mass = density * volume;

  // ---- inertia tensor about the c.o.m. (segments as solid cylinders) ----
  // I_seg = Itrans·δ + (Iax − Itrans)·u⊗u  +  dm·(|d|²δ − d⊗d)      [own term + parallel axis]
  const I = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const u = new THREE.Vector3(), d = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    const ds = pts[i + 1].distanceTo(pts[i]);
    if (ds < 1e-12) continue;
    const dm = (mass * ds) / length;
    u.subVectors(pts[i + 1], pts[i]).divideScalar(ds);
    d.addVectors(pts[i], pts[i + 1]).multiplyScalar(0.5).sub(com);
    const iAx = 0.5 * dm * tube * tube;
    const iTr = dm * (tube * tube / 4 + (ds * ds) / 12);
    const d2 = d.lengthSq();
    const uArr = [u.x, u.y, u.z], dArr = [d.x, d.y, d.z];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        const delta = r === c ? 1 : 0;
        I[r][c] += iTr * delta + (iAx - iTr) * uArr[r] * uArr[c] + dm * (d2 * delta - dArr[r] * dArr[c]);
      }
    }
  }
  const eig = eigenSymmetric3(I);
  const principal = eig.values.map((v) => Math.max(v, 1e-9));
  // build the principal frame; enforce a right-handed basis for a valid rotation quaternion
  const [e0, e1] = eig.vectors;
  const e2 = new THREE.Vector3().crossVectors(e0, e1); // = ±vectors[2]; the cross guarantees det=+1
  const frame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(e0, e1, e2));

  // ---- render geometry: a tube swept along the (c.o.m.-centered) curve ----
  const closed = pts[0].distanceTo(pts[N]) < Math.max(1e-3, length * 1e-3);
  class CenterlineCurve extends THREE.Curve<THREE.Vector3> {
    constructor() { super(); }
    getPoint(s: number, target = new THREE.Vector3()): THREE.Vector3 {
      const t = t0 + (t1 - t0) * Math.min(Math.max(s, 0), 1);
      return target.set(fx(t), fy(t), fz(t)).sub(com);
    }
  }
  const tubularSegments = Math.min(360, Math.max(96, Math.round(length * 14)));
  const geometry = new THREE.TubeGeometry(new CenterlineCurve(), tubularSegments, tube, 12, closed);

  // ---- capsule chain for collision (chunked; caps overlap at joints for continuity) ----
  const chunkCount = Math.min(48, Math.max(10, Math.round(length / (1.8 * tube))));
  const capsules: BuiltParamCurve['capsules'] = [];
  const yAxis = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < chunkCount; k++) {
    const a = pts[Math.round((N * k) / chunkCount)].clone().sub(com);
    const b = pts[Math.round((N * (k + 1)) / chunkCount)].clone().sub(com);
    const seg = new THREE.Vector3().subVectors(b, a);
    let segLen = seg.length();
    if (segLen < 1e-6) continue;
    seg.divideScalar(segLen);
    // open ends: pull the end capsules in by one tube radius, so the rounded cap lands exactly on
    // the curve end instead of overshooting past it by r
    if (!closed) {
      if (k === 0) { const trim = Math.min(tube, 0.45 * segLen); a.addScaledVector(seg, trim); segLen -= trim; }
      if (k === chunkCount - 1) { const trim = Math.min(tube, 0.45 * segLen); b.addScaledVector(seg, -trim); segLen -= trim; }
    }
    const q = new THREE.Quaternion().setFromUnitVectors(yAxis, seg);
    const c = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
    capsules.push({ center: [c.x, c.y, c.z], halfHeight: segLen / 2, quat: [q.x, q.y, q.z, q.w] });
  }

  let maxRadius = 0;
  for (const p of pts) maxRadius = Math.max(maxRadius, p.distanceTo(com));
  maxRadius += tube;

  return {
    ok: true,
    shape: {
      geometry, capsules, tube, length, volume, mass,
      inertia: { x: principal[0], y: principal[1], z: principal[2] },
      inertiaFrame: { x: frame.x, y: frame.y, z: frame.z, w: frame.w },
      maxRadius, closed,
    },
  };
}

/** Presets for the parametric-curve creator. */
export interface CurvePreset { name: string; xt: string; yt: string; zt: string; t0: number; t1: number; tube: number; }
export const CURVE_PRESETS: CurvePreset[] = [
  { name: 'Spring', xt: '1.1*cos(t)', yt: '0.18*t', zt: '1.1*sin(t)', t0: 0, t1: 25.13, tube: 0.16 },
  { name: 'Knot', xt: '0.55*(sin(t)+2*sin(2*t))', yt: '0.55*(cos(t)-2*cos(2*t))', zt: '-0.55*sin(3*t)', t0: 0, t1: 6.283, tube: 0.22 },
  { name: 'Ring', xt: '1.6*cos(t)', yt: '0', zt: '1.6*sin(t)', t0: 0, t1: 6.283, tube: 0.3 },
  { name: 'Wave', xt: 't-3', yt: '0.6*sin(2*t)', zt: '0', t0: 0, t1: 6, tube: 0.2 },
];

// ============================================================ parametric surfaces
//
// x(u,v), y(u,v), z(u,v) over [u0,u1]×[v0,v1] — torus, Möbius strips, hollow balls, rippled
// sheets. The surface is sampled on a grid, triangulated, and the mass comes from the triangles,
// in one of two physical readings the user picks:
//
//   shell — the surface is a thin sheet of wall thickness h (sheet metal). Works for ANY surface,
//           open or closed. Each triangle is an exact lamina: ∫ r⊗r dA over a triangle is
//           (A/3)·Σ mᵢ⊗mᵢ (edge-midpoint quadrature — exact for quadratics), plus dm·h²/12·n⊗n
//           for the through-thickness spread.
//   solid — the surface is the boundary of a filled body (requires a closed surface). Divergence
//           theorem over signed tetrahedra (origin,p0,p1,p2): the exact polyhedron volume, c.o.m.,
//           and second moments (canonical-tet map, the Mirtich/Eberly construction).
//
// A hollow ball vs. a filled one is the classic rolling-race demo (2/3·mR² vs 2/5·mR²) — that's
// why the mode is user-facing and not an implementation detail.
//
// Closure is auto-detected: closed ⟺ each boundary pair (u=u0/u1, v=v0/v1) is either a seam
// (matches its opposite pointwise — torus) or both edges collapse to poles (sphere). A Möbius
// strip's seam matches with a flip, so it correctly reads as open.
//
// Like the curves, the tensor is generally non-diagonal → Jacobi → principal moments + frame.
//
// COLLIDER: a slab tiling — the 2D analogue of the curves' capsule chain. A coarse version of the
// sampling grid is tiled with one small convex hull per cell (its 4 corners pushed along the
// vertex normals: ±h/2 for a shell wall, a skin just inside the boundary for a solid). Neighboring
// cells share corner points, so the tiling is watertight, and concavity is real: a ball threads a
// torus's hole, a bowl cups a marble, a Möbius strip collides as a twisted band. All pieces are
// convex → robust dynamic contacts (no dynamic-trimesh pitfalls).

export interface ParamSurfaceSpec {
  xuv: string; yuv: string; zuv: string; // coordinates as functions of u and v
  u0: number; u1: number; v0: number; v1: number;
  mode: 'shell' | 'solid';
  thickness: number; // shell wall thickness (ignored in solid mode)
  density: number;
}

export interface BuiltParamSurface {
  geometry: THREE.BufferGeometry; // centered on the center of mass
  slabs: Float32Array[]; // per-cell point clouds (c.o.m.-centered) — one convex collider each
  supportPoints: Float32Array; // every slab corner, flattened — exact support-point queries
  area: number; // m² of the mid-surface
  volume: number; // m³ — shell: area × thickness · solid: enclosed volume
  mass: number;
  inertia: { x: number; y: number; z: number }; // principal moments about the c.o.m.
  inertiaFrame: { x: number; y: number; z: number; w: number };
  maxRadius: number; // bounding radius (spawn height + fallback collider)
  uvSpan: [number, number]; // world arc lengths of the mid u-/v-parameter lines — texture tiling
  closed: boolean;
  mode: 'shell' | 'solid';
}

export type ParamSurfaceResult = { ok: true; shape: BuiltParamSurface } | { ok: false; error: string };

const SURF_GRID = 96; // cells per axis — one grid drives mass integration AND the render mesh

export function buildParamSurface(spec: ParamSurfaceSpec): ParamSurfaceResult {
  // compile the three coordinate expressions; only "u" and "v" may appear
  const fns: Array<(u: number, v: number) => number> = [];
  for (const [label, src] of [['x(u,v)', spec.xuv], ['y(u,v)', spec.yuv], ['z(u,v)', spec.zuv]] as const) {
    const parsed = parseExpression(src);
    if (!parsed.ok) return { ok: false, error: `${label}: ${parsed.error}` };
    const other = parsed.expr.vars.filter((n) => n !== 'u' && n !== 'v');
    if (other.length) return { ok: false, error: `${label}: only "u" and "v" are allowed (found "${other[0]}").` };
    const compiled = parsed.expr;
    fns.push((u, v) => compiled.eval({ u, v }));
  }
  const [fx, fy, fz] = fns;

  const { u0, u1, v0, v1 } = spec;
  if (![u0, u1, v0, v1].every(isFinite)) return { ok: false, error: 'Domain must be finite numbers.' };
  if (!(u1 > u0) || !(v1 > v0)) return { ok: false, error: 'Domain end must be greater than start.' };
  const density = spec.density > 0 ? spec.density : 1;
  const h = spec.thickness;
  if (spec.mode === 'shell' && !(h >= 0.01)) return { ok: false, error: 'Shell thickness must be at least 0.01.' };

  // ---- sample the grid (i along u, j along v) ----
  const N = SURF_GRID;
  const P: THREE.Vector3[] = new Array((N + 1) * (N + 1));
  for (let i = 0; i <= N; i++) {
    const u = u0 + ((u1 - u0) * i) / N;
    for (let j = 0; j <= N; j++) {
      const v = v0 + ((v1 - v0) * j) / N;
      const x = fx(u, v), y = fy(u, v), z = fz(u, v);
      if (!isFinite(x) || !isFinite(y) || !isFinite(z)) {
        return { ok: false, error: `Surface is not finite near (u,v) = (${u.toFixed(2)}, ${v.toFixed(2)}).` };
      }
      P[i * (N + 1) + j] = new THREE.Vector3(x, y, z);
    }
  }
  const at = (i: number, j: number) => P[i * (N + 1) + j];

  // ---- closed? each boundary pair is a seam, or both of its edges are poles ----
  const bbMin = P[0].clone(), bbMax = P[0].clone();
  for (const p of P) { bbMin.min(p); bbMax.max(p); }
  const tol = Math.max(1e-5, 1e-3 * bbMin.distanceTo(bbMax));
  let uSeam = true, uPole0 = true, uPole1 = true, vSeam = true, vPole0 = true, vPole1 = true;
  for (let k = 0; k <= N; k++) {
    if (at(0, k).distanceTo(at(N, k)) > tol) uSeam = false;
    if (at(0, k).distanceTo(at(0, 0)) > tol) uPole0 = false;
    if (at(N, k).distanceTo(at(N, 0)) > tol) uPole1 = false;
    if (at(k, 0).distanceTo(at(k, N)) > tol) vSeam = false;
    if (at(k, 0).distanceTo(at(0, 0)) > tol) vPole0 = false;
    if (at(k, N).distanceTo(at(0, N)) > tol) vPole1 = false;
  }
  const closed = (uSeam || (uPole0 && uPole1)) && (vSeam || (vPole0 && vPole1));
  if (spec.mode === 'solid' && !closed) {
    return { ok: false, error: 'Surface is open (has free edges) — use shell, or close the seams.' };
  }

  // ---- mass properties over the triangulation ----
  // Everything reduces to M, S1 = ∫r dm, C = ∫ r⊗r dm; then I = tr(C)δ − C about the c.o.m.
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const S1 = new THREE.Vector3();
  let area = 0;
  let vol6 = 0; // 6 × signed enclosed volume (solid mode)
  const outerAdd = (p: THREE.Vector3, w: number) => {
    C[0][0] += w * p.x * p.x; C[1][1] += w * p.y * p.y; C[2][2] += w * p.z * p.z;
    const xy = w * p.x * p.y, xz = w * p.x * p.z, yz = w * p.y * p.z;
    C[0][1] += xy; C[1][0] += xy;
    C[0][2] += xz; C[2][0] += xz;
    C[1][2] += yz; C[2][1] += yz;
  };
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cross = new THREE.Vector3(), tmp = new THREE.Vector3();
  const tri = (p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3) => {
    cross.crossVectors(e1.subVectors(p1, p0), e2.subVectors(p2, p0));
    const A = cross.length() / 2;
    area += A;
    if (spec.mode === 'shell') {
      if (A < 1e-12) return; // degenerate (pole) triangle
      S1.addScaledVector(tmp.addVectors(p0, p1).add(p2), A / 3); // A · centroid
      outerAdd(tmp.addVectors(p0, p1).multiplyScalar(0.5), A / 3); // exact lamina: (A/3)·Σ mᵢ⊗mᵢ
      outerAdd(tmp.addVectors(p1, p2).multiplyScalar(0.5), A / 3);
      outerAdd(tmp.addVectors(p2, p0).multiplyScalar(0.5), A / 3);
      outerAdd(cross.divideScalar(2 * A), A * h * h / 12); // through-thickness spread along n̂
    } else {
      // signed tet (origin, p0, p1, p2):  V=det/6 · ∫r = det·s/24 · ∫r⊗r = det·(Σpᵢ⊗pᵢ + s⊗s)/120
      const det = p0.dot(cross.crossVectors(p1, p2));
      vol6 += det;
      S1.addScaledVector(tmp.addVectors(p0, p1).add(p2), det);
      outerAdd(p0, det); outerAdd(p1, det); outerAdd(p2, det);
      outerAdd(tmp, det); // tmp still holds s = p0+p1+p2
    }
  };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const p00 = at(i, j), p10 = at(i + 1, j), p01 = at(i, j + 1), p11 = at(i + 1, j + 1);
      tri(p00, p10, p11);
      tri(p00, p11, p01);
    }
  }

  let mass: number, volume: number;
  let outwardSgn = 1; // sign that makes (ru×rv) point out of a closed surface (solid slabs need it)
  const com = new THREE.Vector3();
  if (spec.mode === 'shell') {
    if (area < 1e-6) return { ok: false, error: 'Surface has ~zero area.' };
    volume = area * h;
    mass = density * volume;
    com.copy(S1).divideScalar(area);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] *= density * h;
  } else {
    const sgn = vol6 < 0 ? -1 : 1; // grid winding decides the sign — flip everything if inward
    outwardSgn = sgn;
    volume = (sgn * vol6) / 6;
    if (volume < 1e-6) return { ok: false, error: 'Enclosed volume is ~zero — use shell.' };
    mass = density * volume;
    com.copy(S1).multiplyScalar(sgn / 24).divideScalar(volume);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r][c] *= (sgn * density) / 120;
  }
  outerAdd(com, -mass); // parallel-axis: C about the c.o.m.
  const trC = C[0][0] + C[1][1] + C[2][2];
  const I = [
    [trC - C[0][0], -C[0][1], -C[0][2]],
    [-C[1][0], trC - C[1][1], -C[1][2]],
    [-C[2][0], -C[2][1], trC - C[2][2]],
  ];
  const eig = eigenSymmetric3(I);
  const principal = eig.values.map((x) => Math.max(x, 1e-9));
  const [b0, b1] = eig.vectors;
  const b2 = new THREE.Vector3().crossVectors(b0, b1); // right-handed basis → valid rotation
  const frame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(b0, b1, b2));

  // ---- render geometry: the same grid, c.o.m.-centered, indexed + averaged normals ----
  const positions = new Float32Array((N + 1) * (N + 1) * 3);
  for (let k = 0; k < P.length; k++) {
    positions[k * 3] = P[k].x - com.x;
    positions[k * 3 + 1] = P[k].y - com.y;
    positions[k * 3 + 2] = P[k].z - com.z;
  }
  const indices = new Uint32Array(N * N * 6);
  let w = 0;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = i * (N + 1) + j, b = (i + 1) * (N + 1) + j, c = (i + 1) * (N + 1) + j + 1, d = i * (N + 1) + j + 1;
      indices[w++] = a; indices[w++] = b; indices[w++] = c;
      indices[w++] = a; indices[w++] = c; indices[w++] = d;
    }
  }
  const uvs = new Float32Array((N + 1) * (N + 1) * 2);
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const k = i * (N + 1) + j;
      uvs[k * 2] = i / N;
      uvs[k * 2 + 1] = j / N;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  // texture-tiling spans: how long the surface is along each parameter (measured mid-line)
  const mid = N / 2;
  let uLen = 0, vLen = 0;
  for (let k = 0; k < N; k++) {
    uLen += at(k + 1, mid).distanceTo(at(k, mid));
    vLen += at(mid, k + 1).distanceTo(at(mid, k));
  }

  let maxRadius = 0;
  for (const p of P) maxRadius = Math.max(maxRadius, p.distanceTo(com));
  if (spec.mode === 'shell') maxRadius += h / 2;

  // ---- slab-tiled compound collider: one thin convex hull per coarse grid cell ----
  const SLAB_GRID = 16; // 16×16 cells (≤256 pieces); corners land on fine-grid points (96/16 = 6)
  const cs = N / SLAB_GRID;
  // vertex normal from fine-grid differences — null at degenerate points (poles)
  const cornerNormal = (i: number, j: number): THREE.Vector3 | null => {
    const ru = new THREE.Vector3().subVectors(at(Math.min(i + 1, N), j), at(Math.max(i - 1, 0), j));
    const rv = new THREE.Vector3().subVectors(at(i, Math.min(j + 1, N)), at(i, Math.max(j - 1, 0)));
    const n = ru.cross(rv);
    const len = n.length();
    return len > 1e-9 ? n.divideScalar(len) : null;
  };
  // shell: wall spans ±h/2 around the mid-surface. solid: outer face ON the boundary, inner face a
  // skin-depth inside it (contacts only ever see the boundary; CCD keeps things out of the hollow).
  const skin = spec.mode === 'shell' ? h / 2 : Math.min(0.3, Math.max(0.05, 0.08 * maxRadius));
  const slabs: Float32Array[] = [];
  const support: number[] = [];
  for (let a = 0; a < SLAB_GRID; a++) {
    for (let b = 0; b < SLAB_GRID; b++) {
      const corners = [
        [a * cs, b * cs], [(a + 1) * cs, b * cs],
        [(a + 1) * cs, (b + 1) * cs], [a * cs, (b + 1) * cs],
      ] as const;
      // zero-extent cell (fully collapsed at a pole) — nothing to collide with
      const c0 = at(corners[0][0], corners[0][1]);
      if (corners.every(([i, j]) => at(i, j).distanceTo(c0) < 1e-6)) continue;
      const pts: number[] = [];
      for (const [i, j] of corners) {
        const p = at(i, j);
        const n = cornerNormal(i, j);
        if (!n) { pts.push(p.x - com.x, p.y - com.y, p.z - com.z); continue; } // pole corner: bare point
        if (spec.mode === 'shell') {
          pts.push(
            p.x + n.x * skin - com.x, p.y + n.y * skin - com.y, p.z + n.z * skin - com.z,
            p.x - n.x * skin - com.x, p.y - n.y * skin - com.y, p.z - n.z * skin - com.z,
          );
        } else {
          n.multiplyScalar(outwardSgn);
          pts.push(
            p.x - com.x, p.y - com.y, p.z - com.z,
            p.x - n.x * skin - com.x, p.y - n.y * skin - com.y, p.z - n.z * skin - com.z,
          );
        }
      }
      if (pts.length >= 12) { // ≥4 points — enough for Rapier to attempt a hull
        slabs.push(new Float32Array(pts));
        support.push(...pts);
      }
    }
  }

  return {
    ok: true,
    shape: {
      geometry, slabs, supportPoints: new Float32Array(support), area, volume, mass,
      inertia: { x: principal[0], y: principal[1], z: principal[2] },
      inertiaFrame: { x: frame.x, y: frame.y, z: frame.z, w: frame.w },
      maxRadius, uvSpan: [uLen, vLen], closed, mode: spec.mode,
    },
  };
}

/** Presets for the parametric-surface creator. */
export interface SurfacePreset {
  name: string; xuv: string; yuv: string; zuv: string;
  u0: number; u1: number; v0: number; v1: number; mode: 'shell' | 'solid'; thickness: number;
}
export const SURFACE_PRESETS: SurfacePreset[] = [
  { name: 'Torus', xuv: '(1.3+0.55*cos(v))*cos(u)', yuv: '0.55*sin(v)', zuv: '(1.3+0.55*cos(v))*sin(u)', u0: 0, u1: 6.2832, v0: 0, v1: 6.2832, mode: 'solid', thickness: 0.1 },
  { name: 'Hollow ball', xuv: '1.3*sin(v)*cos(u)', yuv: '1.3*cos(v)', zuv: '1.3*sin(v)*sin(u)', u0: 0, u1: 6.2832, v0: 0, v1: 3.1416, mode: 'shell', thickness: 0.12 },
  { name: 'Möbius', xuv: '(1.2+v*cos(u/2))*cos(u)', yuv: 'v*sin(u/2)', zuv: '(1.2+v*cos(u/2))*sin(u)', u0: 0, u1: 6.2832, v0: -0.45, v1: 0.45, mode: 'shell', thickness: 0.08 },
  { name: 'Ripple', xuv: 'u', yuv: '0.35*sin(1.5*u)*cos(1.5*v)', zuv: 'v', u0: -1.8, u1: 1.8, v0: -1.8, v1: 1.8, mode: 'shell', thickness: 0.1 },
];
