/**
 * FORCE FIELDS — Phase 4. Regions of space that push, pull, or swirl every dynamic body inside them.
 *
 * A field contributes a force; the Sandbox applies impulse = force · dt every physics step (so the
 * effect is framerate-independent and sleeping bodies get woken). The math here is pure — the
 * Sandbox owns the registry, the visual markers, and the per-step loop.
 *
 * Every field is CONFINED to a region (a sphere, box, or cylinder you can orient and size), and the
 * force ramps smoothly to zero across the region's boundary (a smoothstep shell) so a body crossing
 * in or out is eased, never snapped. Wind included — it used to be global; now it's a gust you place.
 *
 *   attractor / repeller — radial pull/push toward the region's centre, force ∝ mass (accelerates
 *                          everything alike, like gravity).
 *   wind                 — a constant force along the region's local +X (aim it by rotating the
 *                          region); NOT mass-scaled, so light things blow faster than heavy ones.
 *   vortex               — tangential swirl about the region's vertical axis plus a light inward tug,
 *                          steered toward a target velocity so objects circle stably (a tornado).
 *   gravitywell          — a true Newtonian 1/r² pull toward the centre. Unlike the attractor it does
 *                          NOT steer toward a target velocity, so it never damps out sideways motion —
 *                          bodies keep the tangential speed they have and ORBIT instead of collapsing
 *                          into a jammed clump. On a resting pile it seeds a little spin so the cloud
 *                          swirls into an accretion disc rather than falling dead-straight to a point.
 */
import * as THREE from 'three';
import { parseExpression } from './expr';

export type FieldKind = 'attractor' | 'repeller' | 'wind' | 'vortex' | 'tornado' | 'path' | 'gravitywell' | 'turbulence' | 'explosion';
export type FieldShape = 'sphere' | 'box' | 'cylinder';

/**
 * A path field's flow curve, sampled to a polyline (the vortex generalized to any shape). Bodies in
 * the tube around it are steered to flow ALONG the tangent and drawn ONTO the curve; `swirl` adds a
 * corkscrew *around* the curve (a circle reproduces the plain vortex; a helix is a spiral updraft).
 */
/** A parametric curve x(t),y(t),z(t) over [t0,t1] — a preset, a catalog pick, or your own equations. */
export interface CurveSpec { xt: string; yt: string; zt: string; t0: number; t1: number }

export interface FieldPath {
  spec: CurveSpec; // the curve's equations (so it can be re-sampled + shown in the editor)
  label: string; // display name (preset/catalog name, or "custom")
  scale: number; // overall size of the curve (its bounding radius — every curve is normalized to fit)
  swirl: number; // 0 = pure flow along the path; up to ~1 = swirl around it (vortex tube)
  pts: Float32Array; // sampled points in the field's LOCAL frame (centred + scaled), flat xyz
  tans: Float32Array; // unit tangents at each sample, flat xyz
  closed: boolean;
  drawn?: Float32Array; // present for a FREEHAND-drawn flow: the stroke as unit points (bounding radius
  //                       1, centred). There's no equation to re-sample, so `scale` re-scales THESE.
}

export interface Field {
  id: number;
  kind: FieldKind;
  shape: FieldShape;
  pos: THREE.Vector3; // region centre
  quat: THREE.Quaternion; // region orientation (box/cylinder axes; wind blows along quat·+X)
  size: THREE.Vector3; // sphere → radius in .x; box → half-extents; cylinder → (radius, halfHeight, radius)
  strength: number; // base magnitude; the Sandbox scales this by a live global multiplier
  hidden: boolean; // marker invisible (the field still acts) — the region is just not drawn
  path?: FieldPath; // present only for kind 'path'; .size.x is the tube (capture) radius
  lift?: boolean; // path fields only: suspend world gravity inside the tube so bodies can follow a 3D
  //                 curve up into the air (like the gravity well does) instead of falling out of it
  dir?: 1 | -1; // flow direction for rotational/path kinds (vortex, tornado, gravity well, path):
  //               1 = default handedness, -1 = reversed (the editor's ⇄ Reverse-flow button). NOTE
  //               this is deliberately separate from `strength`'s SIGN: a NEGATIVE strength on a
  //               vortex both reverses the swirl and flips the inward draw outward (bodies fling
  //               out) — a liked, protected behavior — while `dir` only mirrors the handedness.
  sole?: boolean; // gravity wells only: this well's centre is the ONLY gravity inside its region —
  //                world gravity is FULLY suspended there (not eased by the soft edge), so "down"
  //                is wherever the well is. Other wells/attractors still add their own pull.
}

/** Per-kind defaults. Every `strength` is now a TARGET SPEED (m/s), so the scale is shared across all
 *  kinds — a 5 feels the same on any field. `size` = default region extent (path: tube radius). */
export const FIELD_INFO: Record<FieldKind, { strength: number; size: number; color: number; label: string }> = {
  // Every field's base region is 10 (radius / half-extent) so they all start the same, roomy size.
  attractor: { strength: 8, size: 10, color: 0x5b8def, label: 'Attract' },
  repeller: { strength: 8, size: 10, color: 0xdc4a4a, label: 'Repel' },
  wind: { strength: 8, size: 10, color: 0x4fb89a, label: 'Wind' },
  vortex: { strength: 8, size: 10, color: 0xa978e0, label: 'Vortex' },
  // tornado: Rankine swirl + ground-level inflow + a core updraft that eases off with height, so
  // debris recirculates (up the core, out the top, falls outside, drawn back in at the ground).
  tornado: { strength: 10, size: 10, color: 0x8fd0e8, label: 'Tornado' },
  path: { strength: 8, size: 4, color: 0xe0a04f, label: 'Path' }, // size.x = tube (capture) radius; the
  //                                curve's own base size is 10 (set in beginPlace), the tube stays snug at 4
  // the well's `strength` is its MASS (how hard it pulls), not a target speed.
  gravitywell: { strength: 8, size: 10, color: 0xe05aa0, label: 'Gravity well' },
  // turbulence: `strength` is the drift speed of the eddies (target-velocity model, so mass-independent).
  // Softer default than the rest — its ever-shifting target makes the same number feel far stronger.
  turbulence: { strength: 6, size: 10, color: 0xe8d44d, label: 'Turbulence' },
  // explosion is a ONE-SHOT: position the ghost, and Place DETONATES it (radial impulse, shockwave,
  // camera shake) instead of leaving a field behind. `strength` = blast speed (m/s) at the centre.
  explosion: { strength: 14, size: 10, color: 0xff7a3d, label: 'Explosion' },
};

export const FIELD_SHAPES: FieldShape[] = ['sphere', 'box', 'cylinder'];

const TAU = 2 * Math.PI;
/** Quick-access flow curves (the editor's buttons). The full library lives in `systems/catalog.ts`. */
export const PATH_PRESETS: Record<string, { label: string } & CurveSpec> = {
  circle: { label: 'Circle', xt: 'cos(t)', yt: '0', zt: 'sin(t)', t0: 0, t1: TAU },
  loop: { label: 'Loop', xt: 'cos(t)', yt: 'sin(t)', zt: '0', t0: 0, t1: TAU }, // vertical
  figure8: { label: 'Figure-8', xt: 'sin(t)', yt: '0', zt: 'sin(2*t)/2', t0: 0, t1: TAU },
  helix: { label: 'Helix', xt: 'cos(t)', yt: '0.16*t', zt: 'sin(t)', t0: 0, t1: 4 * Math.PI },
  spiral: { label: 'Spiral', xt: 't*cos(t)', yt: '0', zt: 't*sin(t)', t0: 0, t1: 4 * Math.PI },
  wave: { label: 'Wave', xt: 't', yt: 'sin(2*t)*0.4', zt: '0', t0: -3.14, t1: 3.14 },
};
export const PATH_PRESET_KEYS = Object.keys(PATH_PRESETS);
const PATH_SAMPLES = 128; // resolution along t — high enough for many-petalled spirographs

/**
 * Sample a parametric curve to a local-space polyline + unit tangents. The curve is CENTRED on its
 * centroid and NORMALIZED so its bounding radius is `scale` — so any formula, whatever its raw
 * magnitude, sits centred at the field and is sized purely by `scale`. Closure is auto-detected
 * (start ≈ end), so a body flowing a closed loop wraps while an open path lets it out the end.
 * Returns null on a bad/undefined expression or a non-finite curve.
 */
export function samplePath(spec: CurveSpec, scale: number): { pts: Float32Array; tans: Float32Array; closed: boolean } | null {
  const cx = parseExpression(spec.xt), cy = parseExpression(spec.yt), cz = parseExpression(spec.zt);
  if (!cx.ok || !cy.ok || !cz.ok) return null;
  for (const c of [cx.expr, cy.expr, cz.expr]) if (c.vars.some((v) => v !== 't')) return null; // only t allowed
  const N = PATH_SAMPLES;
  const raw = new Float32Array((N + 1) * 3); // include both ends so we can test closure
  let cxm = 0, cym = 0, czm = 0;
  for (let i = 0; i <= N; i++) {
    const t = spec.t0 + (spec.t1 - spec.t0) * (i / N);
    const x = cx.expr.eval({ t }), y = cy.expr.eval({ t }), z = cz.expr.eval({ t });
    if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null;
    raw[i * 3] = x; raw[i * 3 + 1] = y; raw[i * 3 + 2] = z; cxm += x; cym += y; czm += z;
  }
  cxm /= N + 1; cym /= N + 1; czm /= N + 1;
  let maxR = 1e-6;
  for (let i = 0; i <= N; i++) maxR = Math.max(maxR, Math.hypot(raw[i * 3] - cxm, raw[i * 3 + 1] - cym, raw[i * 3 + 2] - czm));
  const k = scale / maxR; // centre + normalize to `scale` bounding radius
  const endGap = Math.hypot(raw[0] - raw[N * 3], raw[1] - raw[N * 3 + 1], raw[2] - raw[N * 3 + 2]) / maxR;
  const closed = endGap < 0.08; // start meets end → a loop
  const n = closed ? N : N + 1;
  const pts = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { pts[i * 3] = (raw[i * 3] - cxm) * k; pts[i * 3 + 1] = (raw[i * 3 + 1] - cym) * k; pts[i * 3 + 2] = (raw[i * 3 + 2] - czm) * k; }
  const tans = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
    const b = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    const dx = pts[b * 3] - pts[a * 3], dy = pts[b * 3 + 1] - pts[a * 3 + 1], dz = pts[b * 3 + 2] - pts[a * 3 + 2];
    const len = Math.hypot(dx, dy, dz) || 1;
    tans[i * 3] = dx / len; tans[i * 3 + 1] = dy / len; tans[i * 3 + 2] = dz / len;
  }
  layCurveFlat(pts, tans, n); // orient the curve flat by default so it lands on the object layer
  return { pts, tans, closed };
}

const _up = new THREE.Vector3(0, 1, 0);
const _nrm = new THREE.Vector3();
const _rot = new THREE.Quaternion();
const _rv = new THREE.Vector3();

/**
 * Lay a sampled flow curve FLAT by default: rotate it (in its own local frame) so its best-fit plane
 * is horizontal — the plane's normal points world-up. The normal is the least-variance axis of the
 * curve's points (a PCA plane fit), which is robust for closed loops, open curves, and even a flat
 * sine wave (whose net enclosed area is zero — that fools a Newell/area estimate but not PCA). This is
 * why every preset "just works" over a floor layer of objects: a Loop (a vertical circle in its raw
 * equations) gets laid down like a racetrack, while a genuinely 3D curve like a Helix — whose thin axis
 * already points up — is left standing as an updraft. Only the sampled points move; the field's own
 * quaternion is untouched, so the user can still tilt the whole thing with the R / rotate gizmo after.
 */
function layCurveFlat(pts: Float32Array, tans: Float32Array, n: number) {
  if (!planeNormal(pts, n, _nrm)) return; // no well-defined plane (e.g. a 3D-isotropic tangle) — leave it
  if (Math.abs(_nrm.y) > 0.999) return; // already horizontal — nothing to rotate
  _rot.setFromUnitVectors(_nrm, _up); // rotate the plane normal onto world-up
  for (let i = 0; i < n; i++) {
    _rv.set(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]).applyQuaternion(_rot);
    pts[i * 3] = _rv.x; pts[i * 3 + 1] = _rv.y; pts[i * 3 + 2] = _rv.z;
    _rv.set(tans[i * 3], tans[i * 3 + 1], tans[i * 3 + 2]).applyQuaternion(_rot);
    tans[i * 3] = _rv.x; tans[i * 3 + 1] = _rv.y; tans[i * 3 + 2] = _rv.z;
  }
}

/**
 * Best-fit plane normal of a point set = the eigenvector of its covariance matrix with the SMALLEST
 * eigenvalue (the direction the points vary least along). Solved with a cyclic Jacobi rotation sweep —
 * exact enough for a 3×3 symmetric matrix in a dozen sweeps. Points are assumed ~zero-mean (samplePath
 * centres them). Returns false if the curve is too round to have a meaningful plane (smallest and
 * largest spreads are comparable), so a tangled 3D knot isn't yanked to some arbitrary orientation.
 */
function planeNormal(pts: Float32Array, n: number, out: THREE.Vector3): boolean {
  let c00 = 0, c01 = 0, c02 = 0, c11 = 0, c12 = 0, c22 = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
    c00 += x * x; c01 += x * y; c02 += x * z; c11 += y * y; c12 += y * z; c22 += z * z;
  }
  const m = [[c00, c01, c02], [c01, c11, c12], [c02, c12, c22]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; // accumulates the eigenvectors
  for (let sweep = 0; sweep < 12; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      if (Math.abs(m[p][q]) < 1e-12) continue;
      const phi = 0.5 * Math.atan2(2 * m[p][q], m[q][q] - m[p][p]);
      const c = Math.cos(phi), s = Math.sin(phi);
      for (let k = 0; k < 3; k++) { const kp = m[k][p], kq = m[k][q]; m[k][p] = c * kp - s * kq; m[k][q] = s * kp + c * kq; }
      for (let k = 0; k < 3; k++) { const pk = m[p][k], qk = m[q][k]; m[p][k] = c * pk - s * qk; m[q][k] = s * pk + c * qk; }
      for (let k = 0; k < 3; k++) { const kp = v[k][p], kq = v[k][q]; v[k][p] = c * kp - s * kq; v[k][q] = s * kp + c * kq; }
    }
  }
  const ev = [m[0][0], m[1][1], m[2][2]];
  let lo = 0, hi = 0;
  for (let i = 1; i < 3; i++) { if (ev[i] < ev[lo]) lo = i; if (ev[i] > ev[hi]) hi = i; }
  if (ev[lo] > 0.15 * ev[hi]) return false; // not appreciably flatter in any direction → no clear plane
  out.set(v[0][lo], v[1][lo], v[2][lo]).normalize();
  return true;
}

const RESPONSE = 5; // how hard any field steers a body toward its target velocity (1/s) — uniform
const SOFT_EDGE = 0.55; // full strength inside this fraction of the region; smoothstep to 0 by the edge
const PATH_LOOKAHEAD = 4; // samples ahead the flow steers toward (follows curvature + draws onto the path)
const SWIRL_GAIN = 0.7; // path swirl scales with radius (0 at the centreline) and this cap — keeps it gentle
// Gravity well: GM = strength·gain·WELL_GM sets how hard the 1/r² pull is; WELL_SOFT (metres) is a
// Plummer softening length so the force stays finite at the centre (no singular slingshot).
const WELL_GM = 60;
const WELL_SOFT = 1.5;
const _d = new THREE.Vector3();
const _ax = new THREE.Vector3(); // gravity well's local spin axis in world space
const _iq = new THREE.Quaternion();
const _pl = new THREE.Vector3(); // body position in a path field's local frame
const _tv = new THREE.Vector3(); // target velocity being assembled

const smoothstep01 = (t: number) => t * t * (3 - 2 * t);

/**
 * How strongly a PATH field's tube acts at `bodyPos`: 1 near the centreline, easing to 0 at the tube
 * wall (same smoothstep shell as the point fields), 0 outside. Mirrors the `inf` that `pathForce`
 * computes internally — exposed so the Sandbox can suspend gravity for bodies inside a lift-tube.
 */
export function pathInfluence(field: Field, bodyPos: THREE.Vector3): number {
  const path = field.path;
  if (!path) return 0;
  const pts = path.pts;
  _pl.copy(bodyPos).sub(field.pos).applyQuaternion(_iq.copy(field.quat).invert());
  let bd2 = Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const dx = _pl.x - pts[i], dy = _pl.y - pts[i + 1], dz = _pl.z - pts[i + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bd2) bd2 = d2;
  }
  const R = Math.max(field.size.x, 0.5);
  const n = Math.sqrt(bd2) / R;
  if (n >= 1) return 0;
  return n <= SOFT_EDGE ? 1 : 1 - smoothstep01((n - SOFT_EDGE) / (1 - SOFT_EDGE));
}

/**
 * How strongly the field acts at `bodyPos`: 1 well inside the region, easing to 0 at its boundary
 * (a smoothstep shell over the outer `1-SOFT_EDGE` of the region), and exactly 0 outside — so the
 * field only has effect within its space, with a smooth transition rather than a hard wall.
 */
export function fieldInfluence(field: Field, bodyPos: THREE.Vector3): number {
  _d.copy(bodyPos).sub(field.pos);
  if (field.shape !== 'sphere') _d.applyQuaternion(_iq.copy(field.quat).invert()); // into region-local axes
  const sz = field.size;
  let n: number; // normalized reach: 0 at centre, 1 at the boundary
  if (field.shape === 'sphere') {
    n = _d.length() / Math.max(sz.x, 1e-3);
  } else if (field.shape === 'box') {
    n = Math.max(Math.abs(_d.x) / Math.max(sz.x, 1e-3), Math.abs(_d.y) / Math.max(sz.y, 1e-3), Math.abs(_d.z) / Math.max(sz.z, 1e-3));
  } else {
    n = Math.max(Math.hypot(_d.x, _d.z) / Math.max(sz.x, 1e-3), Math.abs(_d.y) / Math.max(sz.y, 1e-3));
  }
  if (n >= 1) return 0; // outside the region
  if (n <= SOFT_EDGE) return 1; // solid interior
  const t = (n - SOFT_EDGE) / (1 - SOFT_EDGE); // 0 at the inner shell, 1 at the boundary
  return 1 - t * t * (3 - 2 * t); // smoothstep down to 0
}

/**
 * Force this field exerts on a body of `mass` at `bodyPos` moving at `vel`, written into `out`.
 * `gain` is the Sandbox's live global strength multiplier. Zero outside the region.
 *
 * ONE MODEL for every kind: each builds a TARGET VELOCITY of magnitude ≈ `strength` (in m/s) and
 * steers the body toward it. That's why `strength` means the same thing everywhere — a 5 is "move
 * bodies at ~5 m/s," whether it's an attractor sucking inward, wind blowing sideways, or a vortex
 * swirling. The force is mass-scaled so heavy and light bodies reach that speed alike, and scaled by
 * `inf` so the effect fades smoothly across the region boundary.
 */
export function fieldForce(
  field: Field, bodyPos: THREE.Vector3, vel: THREE.Vector3, mass: number, gain: number, out: THREE.Vector3,
): THREE.Vector3 {
  out.set(0, 0, 0);
  if (field.kind === 'explosion') return out; // one-shot: it detonates on Place, never acts as a field
  if (field.kind === 'path') return field.path ? pathForce(field, bodyPos, vel, mass, gain, out) : out;
  if (field.kind === 'gravitywell') return wellForce(field, bodyPos, vel, mass, gain, out);
  if (field.kind === 'turbulence') return turbulenceForce(field, bodyPos, vel, mass, gain, out);
  if (field.kind === 'tornado') return tornadoForce(field, bodyPos, vel, mass, gain, out);
  const inf = fieldInfluence(field, bodyPos);
  if (inf <= 0) return out;
  const speed = field.strength * gain; // target speed (m/s) — SAME meaning for every kind

  if (field.kind === 'wind') {
    _tv.set(1, 0, 0).applyQuaternion(field.quat).multiplyScalar(speed); // blow toward wind velocity
  } else if (field.kind === 'vortex') {
    // A pure whirlpool: swirl about the field's own axis (quat·+Y) — NO vertical motion (that's the
    // tornado's job). Work in region-local space so a tilted vortex spins in its tilted plane.
    // RANKINE profile — the standard model of a real vortex: solid-body rotation in the core
    // (tangential speed ∝ r) and a free, decaying swirl outside it (∝ 1/r) — plus a gentle inward
    // draw. `dir` mirrors the handedness (the ⇄ Reverse button); a NEGATIVE strength still reverses
    // swirl AND flips the draw outward (bodies fling out) — a deliberate, protected behavior.
    _d.copy(bodyPos).sub(field.pos).applyQuaternion(_iq.copy(field.quat).invert());
    const dir = field.dir ?? 1;
    const rDist = Math.hypot(_d.x, _d.z);
    const invd = 1 / (rDist || 1);
    const prof = rankine(rDist, Math.max(field.size.x, 1e-3)); // local swirl fraction (0 at the axis)
    const vt = prof * speed * dir; // tangential target speed
    // the inward draw follows the LOCAL swirl strength (∝ the Rankine profile), like the pressure
    // inflow of a real vortex — NOT a constant fraction of `speed`. A constant draw at high strength
    // crushed everything onto the axis into a standing pillar (measured: 986 objects at median
    // radius 1.6 under a strength-600 target): the axis is calm in a real vortex, and with the draw
    // fading in the core, strong swirl and inward draw balance at a finite radius → rings and orbits.
    const draw = 0.3 * speed * prof;
    _tv.set(
      -_d.z * invd * vt - _d.x * invd * draw,
      0,
      _d.x * invd * vt - _d.z * invd * draw,
    );
    _tv.applyQuaternion(field.quat); // target velocity back into world space
  } else {
    // attractor / repeller — toward / away from the centre
    _d.subVectors(field.pos, bodyPos);
    const sign = field.kind === 'attractor' ? 1 : -1;
    _tv.copy(_d).divideScalar(_d.length() || 1).multiplyScalar(sign * speed);
  }
  return out.set(_tv.x - vel.x, _tv.y - vel.y, _tv.z - vel.z).multiplyScalar(mass * RESPONSE * inf);
}

/**
 * Rankine vortex tangential-speed profile, normalized to peak 1 at the core radius: v ∝ r inside the
 * core (solid-body rotation — the fluid turns as one piece, so the very axis is calm), v ∝ 1/r
 * outside it (a free vortex, conserving circulation). This is the standard first-order model of real
 * whirlpools and tornado winds, and it's also what makes the sim stable: a constant-speed swirl at
 * tiny radius would demand impossible centripetal force and sling bodies straight out.
 */
function rankine(r: number, R: number): number {
  const rc = 0.35 * R; // core radius — solid-body inside, free vortex outside
  return r <= rc ? r / rc : rc / Math.max(r, 1e-6);
}

// Tornado shape constants: how the three flow components (swirl / inflow / updraft) are distributed.
const TORNADO_INFLOW = 0.7; // ground-level radial inflow fraction of `speed` (decays with height²)
const TORNADO_LIFT = 1.15; // funnel-wall updraft fraction of `speed` (fades with height). Must be
//                            comfortably >1: the net climb is target·(wall·gust·(1−hf)) − g/RESPONSE,
//                            and at 0.7 the product dropped below gravity by mid-column, so all the
//                            debris hovered in the bottom third (measured: nothing above y=6)
// The updraft lives in the funnel WALL — an annulus around rf≈0.5, zero at the axis and the rim. A
// core-centred updraft never lifted anything (measured: maxY 1.6): centrifugal balance FORBIDS the
// core — a body circling at Rankine speed near the axis needs ~45 m/s² centripetal but the inflow
// supplies ~19, so debris settles in an equilibrium annulus at rf≈0.5. Real tornadoes are the same:
// calm core, debris spiralling up the wall. Put the lift where the debris actually is.
// NB the marker's funnel is drawn POINTIER (0.06·R tip) than this physics cone: the visible funnel
// of a real tornado is condensation, while the DEBRIS CLOUD swirls wider around it — and here that's
// forced by the physics: at ground level, centrifugal balance against the Rankine swirl parks debris
// at rf≈0.35–0.5, so a lift annulus at a pointy tip radius acts where debris cannot exist and nothing
// rises (measured: 2 airborne with BOT=0.06 — same bug class as the original core-centred updraft).
const TORNADO_WALL_BOT = 0.3; // physics cone radius at the GROUND (where debris CAN orbit)
const TORNADO_WALL_TOP = 0.85; // physics cone radius at the TOP
const TORNADO_WALL_W = 0.35; // half-width of the wall annulus the updraft lives in
const TORNADO_GUST = 0.45; // lift modulation depth from drifting noise (varies each body's stall height)
// Suction sub-vortices: real tornadoes carry 2–5 smaller vortices orbiting the main funnel, and
// they're what scatters debris AROUND the cone. Without an azimuth-dependent term every body at a
// given height gets the IDENTICAL steering target, so collisions bead the debris into one rotating
// chain on one side of the funnel (reported: "objects holding in one line" — the gust noise varies
// with position, so a tight clump shares one gust value and stays a clump). A wave traveling around
// the azimuth pushes each angular position differently, shearing chains apart over the surface.
const TORNADO_SUBV = 0.22; // sub-vortex strength (radial ripple) as a fraction of `speed`
const TORNADO_SUBV_N = 3; // how many sub-vortices ride around the funnel
const TORNADO_SUBV_RATE = 2.4; // rad/s — how fast they orbit the main axis

/**
 * A tornado: the vortex's Rankine swirl PLUS the vertical structure of a real twister. The radial
 * flow steers debris toward the FUNNEL SURFACE — a cone, narrow at the ground and widening with
 * height: bodies outside it are drawn in, and bodies caught in the EYE are pushed OUT to the wall
 * (the eye of a real tornado is calm, and an inward-only inflow trapped objects dead-centre on the
 * axis forever — reported). The updraft rides that wall and fades linearly with height, so debris
 * STALLS around ¾ height, arcs outward, falls outside the funnel, and the ground inflow drags it
 * back in — a recirculating fountain in the SHAPE of the funnel, not a one-way launcher off the top.
 * `dir` mirrors the swirl handedness; negative strength reverses swirl and blows debris outward.
 */
function tornadoForce(
  field: Field, bodyPos: THREE.Vector3, vel: THREE.Vector3, mass: number, gain: number, out: THREE.Vector3,
): THREE.Vector3 {
  const inf = fieldInfluence(field, bodyPos);
  if (inf <= 0) return out;
  const speed = field.strength * gain;
  const dir = field.dir ?? 1;
  _d.copy(bodyPos).sub(field.pos).applyQuaternion(_iq.copy(field.quat).invert()); // region-local
  const R = Math.max(field.size.x, 1e-3);
  const H = Math.max(field.size.y, 1e-3); // half-height: local y runs -H (ground end) … +H (top)
  const rDist = Math.hypot(_d.x, _d.z);
  const invd = 1 / (rDist || 1);
  const rf = rDist / R; // 0 at the axis … 1 at the radial edge
  const hf = THREE.MathUtils.clamp((_d.y + H) / (2 * H), 0, 1); // 0 at the ground … 1 at the top

  const vt = rankine(rDist, R) * speed * dir; // Rankine swirl, same as the vortex
  // signed radial steering toward the funnel surface at this height: + = outward (a body in the eye
  // is expelled to the wall), − = inward (stray debris is gathered). Strongest in the ground layer
  // (boundary-layer convergence — why debris gets dragged toward a twister), gentler aloft so the
  // cone shape still holds up high without crushing the swirl.
  const coneR = TORNADO_WALL_BOT + (TORNADO_WALL_TOP - TORNADO_WALL_BOT) * hf;
  const coef = TORNADO_INFLOW * (0.35 + 0.65 * (1 - hf) * (1 - hf));
  // sub-vortex traveling wave (see constants above): each azimuth gets a different radial push, and
  // the pattern itself orbits the axis, so debris shears apart around the cone instead of beading
  // into one rotating chain. The snap gain is soft (1.5, was 3) for the same reason — a hard pin
  // onto the exact cone radius put every body on the same rail.
  const theta = Math.atan2(_d.z, _d.x);
  const tSec = typeof performance !== 'undefined' ? performance.now() * 0.001 : 0;
  const wave = Math.sin(TORNADO_SUBV_N * theta - dir * TORNADO_SUBV_RATE * tSec + hf * 3);
  // snap gain is TIGHT near the ground (the funnel tip must hold debris against full Rankine swirl)
  // and LOOSE aloft (a soft shell up high lets the sub-vortices spread debris over the cone surface)
  const snap = 1.5 + 1.8 * (1 - hf);
  const vRad = speed * (coef * THREE.MathUtils.clamp((coneR - rf) * snap, -1, 1) + TORNADO_SUBV * wave);
  // updraft on the funnel WALL (the annulus around the cone surface — the core is centrifugally
  // forbidden and the eye is calm), fading LINEARLY with height so debris tops out inside the column
  // instead of launching off the top. The lift is MODULATED by slowly-drifting noise (±TORNADO_GUST
  // around a 0.65 mean → gusts of 0.2×…1.1×): with uniform lift every object stalled at the SAME
  // equilibrium height and the debris collapsed into one flat ring (reported); gusty lift gives every
  // location and moment a different stall height, so debris spreads over the whole cone surface and
  // visibly churns up and down it.
  const gust = 0.8 + TORNADO_GUST * turbNoise(bodyPos.x * 0.25, bodyPos.y * 0.25 + tSec * 0.5, bodyPos.z * 0.25);
  const lift = speed * TORNADO_LIFT * gust
    * Math.max(0, 1 - Math.abs(rf - coneR) / TORNADO_WALL_W)
    * (1 - hf);

  _tv.set(
    -_d.z * invd * vt + _d.x * invd * vRad,
    lift,
    _d.x * invd * vt + _d.z * invd * vRad,
  );
  _tv.applyQuaternion(field.quat);
  return out.set(_tv.x - vel.x, _tv.y - vel.y, _tv.z - vel.z).multiplyScalar(mass * RESPONSE * inf);
}

/**
 * A true gravity well: a Newtonian 1/r² pull toward the region centre (Plummer-softened so it's finite
 * at the middle), plus a Coriolis-like curl about the region's axis that curves radial infall into
 * orbits. Crucially there is NO velocity-target damping (that's what makes the attractor collapse a
 * crowd into a jammed clump) — the pull is conservative, so bodies keep their sideways speed and circle.
 * Both terms are mass-scaled, so the resulting ACCELERATION is mass-independent and everything orbits
 * alike, exactly like real gravity. Force fades to zero across the region boundary (the usual shell).
 */
function wellForce(
  field: Field, bodyPos: THREE.Vector3, vel: THREE.Vector3, mass: number, gain: number, out: THREE.Vector3,
): THREE.Vector3 {
  const inf = fieldInfluence(field, bodyPos);
  if (inf <= 0) return out;
  _d.subVectors(field.pos, bodyPos); // toward the centre
  const r = _d.length() || 1e-3;
  const gm = field.strength * gain * WELL_GM;
  const a = gm / (r * r + WELL_SOFT * WELL_SOFT); // 1/r² pull, softened so it never blows up at r→0
  _d.divideScalar(r); // unit vector toward the centre
  // central pull: force = m·a (⇒ acceleration a, mass-independent). No `vel` term ⇒ conservative ⇒
  // orbits. This is the ONLY force a well exerts — it used to add a Coriolis-style k·(axis × v) term
  // to "seed" orbits, but that is cyclotron dynamics: it curves a body into a circle of radius v/k
  // around WHEREVER IT HAPPENS TO BE, so objects visibly orbited empty space instead of the well
  // (reported by Rafael, and physically inevitable in hindsight). Orbits are now seeded honestly, by
  // a one-time tangential ORBITAL-INSERTION kick when the well is placed (wellOrbitalVelocity below),
  // after which pure Newtonian gravity does the rest — everything orbits the actual centre.
  return out.set(_d.x * a, _d.y * a, _d.z * a).multiplyScalar(mass * inf);
}

/**
 * The circular-orbit velocity at `bodyPos` around a well: magnitude √(a·r) (the speed at which the
 * softened 1/r² pull exactly supplies the centripetal force), direction tangential — perpendicular to
 * the radius, in the plane normal to the well's axis (quat·+Y), handedness set by `dir`. Used by the
 * Sandbox for ORBITAL INSERTION: when a well is placed, each captured body's tangential velocity
 * component is set to this, so a resting crowd immediately orbits the centre — real orbital mechanics
 * (v = √(GM/r) is exactly how satellites are inserted), not a fudge force.
 */
export function wellOrbitalVelocity(field: Field, bodyPos: THREE.Vector3, gain: number, out: THREE.Vector3): THREE.Vector3 {
  _d.subVectors(bodyPos, field.pos);
  const r = _d.length() || 1e-3;
  const gm = field.strength * gain * WELL_GM;
  // the EFFECTIVE pull includes the region's soft-edge influence (wellForce scales by it), so the
  // balancing circular speed must too — inserting at full-strength speed near the edge overshoots
  // by √(1/inf) and flings bodies straight out of the region (measured: orbits died in ~4 s)
  const a = (gm / (r * r + WELL_SOFT * WELL_SOFT)) * fieldInfluence(field, bodyPos);
  const vCirc = Math.sqrt(a * r);
  _ax.set(0, 1, 0).applyQuaternion(field.quat); // orbit plane normal = the well's axis
  out.crossVectors(_ax, _d); // tangential direction (axis × radius)
  const len = out.length();
  if (len < 1e-6) return out.set(0, 0, 0); // on the axis — no defined tangent
  return out.multiplyScalar(((field.dir ?? 1) * vCirc) / len);
}

// ---- Turbulence: a curl-of-noise velocity field. The curl of a vector potential is divergence-free,
// so bodies swirl in eddies (like leaves in gusty air) instead of piling up at sources/sinks. -------
const TURB_FREQ = 0.22; // spatial frequency of the eddies (smaller = bigger, lazier swirls)
const TURB_TIMESCALE = 0.35; // how fast the eddy pattern churns over time
const TURB_EPS = 0.7; // finite-difference step used to take the curl of the noise potential
// Turbulence steers far more gently than the other fields. With the shared RESPONSE the field felt
// like a blender: its target velocity keeps CHANGING DIRECTION, so a body is always far from target
// and the correction force never lets up (wind settles once you reach wind speed — turbulence never
// settles). A low response turns that into gusts that nudge rather than yank.
const TURB_RESPONSE = 1.6;

/** Cheap deterministic value-noise hash → [-1, 1] (the classic sin-scramble; quality is unimportant). */
function turbHash(i: number, j: number, k: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453;
  return 2 * (s - Math.floor(s)) - 1;
}

/** Smooth 3D value noise in [-1, 1] (trilinear blend of lattice hashes, smoothstep weights). */
function turbNoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const L = (a: number, b: number, t: number) => a + (b - a) * t;
  const c00 = L(turbHash(xi, yi, zi), turbHash(xi + 1, yi, zi), u);
  const c10 = L(turbHash(xi, yi + 1, zi), turbHash(xi + 1, yi + 1, zi), u);
  const c01 = L(turbHash(xi, yi, zi + 1), turbHash(xi + 1, yi, zi + 1), u);
  const c11 = L(turbHash(xi, yi + 1, zi + 1), turbHash(xi + 1, yi + 1, zi + 1), u);
  return L(L(c00, c10, v), L(c01, c11, v), w);
}

// three near-independent scalar potentials (same noise, large lattice offsets)
const _psi1 = (x: number, y: number, z: number) => turbNoise(x, y, z);
const _psi2 = (x: number, y: number, z: number) => turbNoise(x + 31.4, y + 11.7, z + 47.2);
const _psi3 = (x: number, y: number, z: number) => turbNoise(x + 5.2, y + 63.1, z + 21.9);

/** Unit swirl direction = normalized curl of the noise potential (∇×Ψ) at (x,y,z), drifting with t. */
function curlNoise(x: number, y: number, z: number, t: number, out: THREE.Vector3): THREE.Vector3 {
  const e = TURB_EPS, Z = z + t; // scroll the field along z over time so the eddies churn
  const cx = (_psi3(x, y + e, Z) - _psi3(x, y - e, Z)) - (_psi2(x, y, Z + e) - _psi2(x, y, Z - e));
  const cy = (_psi1(x, y, Z + e) - _psi1(x, y, Z - e)) - (_psi3(x + e, y, Z) - _psi3(x - e, y, Z));
  const cz = (_psi2(x + e, y, Z) - _psi2(x - e, y, Z)) - (_psi1(x, y + e, Z) - _psi1(x, y - e, Z));
  const len = Math.hypot(cx, cy, cz) || 1;
  return out.set(cx / len, cy / len, cz / len);
}

/**
 * Turbulence: steer each body toward the local curl-noise velocity — an incompressible swirl that
 * varies over space and drifts over time, so a crowd churns and eddies (leaves in gusty air) rather
 * than being pushed one way. Same target-velocity model as the other fields, so `strength` is the
 * drift speed and it's mass-independent; confined + eased by the region influence like everything else.
 */
function turbulenceForce(
  field: Field, bodyPos: THREE.Vector3, vel: THREE.Vector3, mass: number, gain: number, out: THREE.Vector3,
): THREE.Vector3 {
  const inf = fieldInfluence(field, bodyPos);
  if (inf <= 0) return out;
  const t = (typeof performance !== 'undefined' ? performance.now() * 0.001 : 0) * TURB_TIMESCALE;
  curlNoise(bodyPos.x * TURB_FREQ, bodyPos.y * TURB_FREQ, bodyPos.z * TURB_FREQ, t, _tv);
  _tv.multiplyScalar(field.strength * gain);
  return out.set(_tv.x - vel.x, _tv.y - vel.y, _tv.z - vel.z).multiplyScalar(mass * TURB_RESPONSE * inf);
}

/**
 * Steer a body along its nearest point on the flow curve. Confined to a tube of radius `size.x`
 * around the curve, with the same smoothstep boundary. Target velocity = tangent·flow (ride the
 * path) + offset·pull (settle onto it) + optional swirl around the curve axis; then a velocity
 * correction toward that target (the vortex's trick, so bodies join the flow smoothly).
 */
function pathForce(
  field: Field, bodyPos: THREE.Vector3, vel: THREE.Vector3, mass: number, gain: number, out: THREE.Vector3,
): THREE.Vector3 {
  const path = field.path!;
  const pts = path.pts, tans = path.tans;
  _pl.copy(bodyPos).sub(field.pos).applyQuaternion(_iq.copy(field.quat).invert()); // into the curve's frame
  // nearest sample on the polyline
  let bi = 0, bd2 = Infinity;
  for (let i = 0; i < pts.length; i += 3) {
    const dx = _pl.x - pts[i], dy = _pl.y - pts[i + 1], dz = _pl.z - pts[i + 2];
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < bd2) { bd2 = d2; bi = i; }
  }
  const dist = Math.sqrt(bd2);
  const R = Math.max(field.size.x, 0.5);
  if (dist >= R) return out; // outside the tube
  const n = dist / R;
  const inf = n <= SOFT_EDGE ? 1 : 1 - smoothstep01((n - SOFT_EDGE) / (1 - SOFT_EDGE));

  const speed = field.strength * gain;
  const dir = field.dir ?? 1; // -1 = the ⇄ Reverse button: flow runs the curve backwards
  // LOOK-AHEAD steering: aim the target velocity at a point a few samples ahead ON the curve (behind,
  // when reversed). That one vector both follows the curve's bends (centripetal, so fast flow on a
  // tight loop doesn't fly out) AND draws a stray body back onto the path — no separate radial pull
  // term needed. At an OPEN path's end we EXTRAPOLATE the ahead-point past the last sample along the
  // final tangent, so bodies flow out the end and leave the tube instead of piling up there.
  const nSamples = pts.length / 3;
  const si = bi / 3;
  const last = nSamples - 1;
  const look = PATH_LOOKAHEAD * dir;
  let ax: number, ay: number, az: number;
  if (path.closed) {
    const ai = (((si + look) % nSamples + nSamples) % nSamples) * 3;
    ax = pts[ai]; ay = pts[ai + 1]; az = pts[ai + 2];
  } else if (si + look <= last && si + look >= 0) {
    const ai = (si + look) * 3;
    ax = pts[ai]; ay = pts[ai + 1]; az = pts[ai + 2];
  } else if (dir > 0) {
    const over = si + look - last; // samples past the far end
    const L = last * 3;
    ax = pts[L] + tans[L] * over; ay = pts[L + 1] + tans[L + 1] * over; az = pts[L + 2] + tans[L + 2] * over;
  } else {
    const over = -(si + look); // samples past the START (reversed flow exits there)
    ax = pts[0] - tans[0] * over; ay = pts[1] - tans[1] * over; az = pts[2] - tans[2] * over;
  }
  const dx = ax - _pl.x, dy = ay - _pl.y, dz = az - _pl.z;
  const dl = Math.hypot(dx, dy, dz) || 1;
  _tv.set((dx / dl) * speed, (dy / dl) * speed, (dz / dl) * speed);
  if (path.swirl > 0 && dist > 1e-3) {
    // corkscrew: swirl about the tangent axis, magnitude ∝ radius (0 on the centreline, capped by
    // SWIRL_GAIN) — a solid-body-rotation profile, so it's smooth instead of a violent spin
    const tx = tans[bi], ty = tans[bi + 1], tz = tans[bi + 2];
    const rx = (_pl.x - pts[bi]) / dist, ry = (_pl.y - pts[bi + 1]) / dist, rz = (_pl.z - pts[bi + 2]) / dist;
    const mag = speed * path.swirl * SWIRL_GAIN * (dist / R); // ramps from the centreline outward
    _tv.x += (ty * rz - tz * ry) * mag;
    _tv.y += (tz * rx - tx * rz) * mag;
    _tv.z += (tx * ry - ty * rx) * mag;
  }
  _tv.applyQuaternion(field.quat); // target velocity back into world space
  return out.set(_tv.x - vel.x, _tv.y - vel.y, _tv.z - vel.z).multiplyScalar(mass * RESPONSE * inf);
}
