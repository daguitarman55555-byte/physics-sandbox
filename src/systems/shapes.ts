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
  | { type: 'paramSurface'; xuv: string; yuv: string; zuv: string }
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
