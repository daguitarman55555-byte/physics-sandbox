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
 */
import * as THREE from 'three';
import { parseExpression } from './expr';

export type FieldKind = 'attractor' | 'repeller' | 'wind' | 'vortex' | 'path';
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
}

/** Per-kind defaults. Every `strength` is now a TARGET SPEED (m/s), so the scale is shared across all
 *  kinds — a 5 feels the same on any field. `size` = default region extent (path: tube radius). */
export const FIELD_INFO: Record<FieldKind, { strength: number; size: number; color: number; label: string }> = {
  attractor: { strength: 8, size: 6, color: 0x5b8def, label: 'Attract' },
  repeller: { strength: 8, size: 6, color: 0xdc4a4a, label: 'Repel' },
  wind: { strength: 8, size: 6, color: 0x4fb89a, label: 'Wind' },
  vortex: { strength: 8, size: 6, color: 0xa978e0, label: 'Vortex' },
  path: { strength: 8, size: 2.5, color: 0xe0a04f, label: 'Path' }, // size.x = tube (capture) radius
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
  return { pts, tans, closed };
}

const RESPONSE = 5; // how hard any field steers a body toward its target velocity (1/s) — uniform
const SOFT_EDGE = 0.55; // full strength inside this fraction of the region; smoothstep to 0 by the edge
const PATH_LOOKAHEAD = 4; // samples ahead the flow steers toward (follows curvature + draws onto the path)
const SWIRL_GAIN = 0.7; // path swirl scales with radius (0 at the centreline) and this cap — keeps it gentle
const _d = new THREE.Vector3();
const _iq = new THREE.Quaternion();
const _pl = new THREE.Vector3(); // body position in a path field's local frame
const _tv = new THREE.Vector3(); // target velocity being assembled

const smoothstep01 = (t: number) => t * t * (3 - 2 * t);

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
  if (field.kind === 'path') return field.path ? pathForce(field, bodyPos, vel, mass, gain, out) : out;
  const inf = fieldInfluence(field, bodyPos);
  if (inf <= 0) return out;
  const speed = field.strength * gain; // target speed (m/s) — SAME meaning for every kind

  if (field.kind === 'wind') {
    _tv.set(1, 0, 0).applyQuaternion(field.quat).multiplyScalar(speed); // blow toward wind velocity
  } else if (field.kind === 'vortex') {
    // swirl about the field's own axis (quat·+Y): work in region-local space so a tilted vortex
    // spins in its tilted plane. tangential swirl + a gentle inward draw = a stable tornado.
    _d.copy(bodyPos).sub(field.pos).applyQuaternion(_iq.copy(field.quat).invert());
    const invd = 1 / (Math.hypot(_d.x, _d.z) || 1);
    _tv.set((-_d.z * invd - _d.x * invd * 0.3) * speed, 0, (_d.x * invd - _d.z * invd * 0.3) * speed);
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
  // LOOK-AHEAD steering: aim the target velocity at a point a few samples ahead ON the curve. That
  // one vector both follows the curve's bends (centripetal, so fast flow on a tight loop doesn't fly
  // out) AND draws a stray body back onto the path — no separate radial pull term needed. At an OPEN
  // path's end we EXTRAPOLATE the ahead-point past the last sample along the final tangent, so bodies
  // flow out the end and leave the tube instead of piling up there.
  const nSamples = pts.length / 3;
  const si = bi / 3;
  const last = nSamples - 1;
  let ax: number, ay: number, az: number;
  if (path.closed) {
    const ai = ((si + PATH_LOOKAHEAD) % nSamples) * 3;
    ax = pts[ai]; ay = pts[ai + 1]; az = pts[ai + 2];
  } else if (si + PATH_LOOKAHEAD <= last) {
    const ai = (si + PATH_LOOKAHEAD) * 3;
    ax = pts[ai]; ay = pts[ai + 1]; az = pts[ai + 2];
  } else {
    const over = si + PATH_LOOKAHEAD - last; // samples past the end
    const L = last * 3;
    ax = pts[L] + tans[L] * over; ay = pts[L + 1] + tans[L + 1] * over; az = pts[L + 2] + tans[L + 2] * over;
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
