/**
 * FORCE FIELDS — Phase 4. Regions of space that push, pull, or swirl every dynamic body each step.
 *
 * A field contributes a force; the Sandbox applies impulse = force · dt every physics step (so the
 * effect is framerate-independent and sleeping bodies get woken). The math here is pure — the
 * Sandbox owns the registry, the visual markers, and the per-step loop.
 *
 *   attractor / repeller — radial pull/push toward a point, force ∝ mass (so it accelerates
 *                          everything alike, like gravity) with a smooth cutoff at `radius`.
 *   wind                 — a constant force in a direction; NOT mass-scaled, so light things blow
 *                          faster than heavy ones (drag-like, and fun).
 *   vortex               — tangential swirl around a vertical axis through the center, plus a light
 *                          inward tug, so objects spiral rather than fly straight out (a tornado).
 */
import * as THREE from 'three';

export type FieldKind = 'attractor' | 'repeller' | 'wind' | 'vortex';

export interface Field {
  id: number;
  kind: FieldKind;
  pos: THREE.Vector3; // center (radial/vortex); the arrow origin for wind
  dir: THREE.Vector3; // wind blows this way (unit); unused by radial fields
  strength: number; // base magnitude; the Sandbox scales this by a live global multiplier
  radius: number; // influence cutoff (radial/vortex); wind is global
}

/** Per-kind base strength (tuned so a global multiplier of 1 gives lively but controllable motion)
 *  and marker color. */
export const FIELD_INFO: Record<FieldKind, { strength: number; radius: number; color: number; label: string }> = {
  attractor: { strength: 22, radius: 9, color: 0x5b8def, label: 'Attract' },
  repeller: { strength: 26, radius: 8, color: 0xdc4a4a, label: 'Repel' },
  wind: { strength: 6, radius: 0, color: 0x4fb89a, label: 'Wind' },
  vortex: { strength: 9, radius: 8, color: 0xa978e0, label: 'Vortex' }, // strength = target swirl m/s
};

const VORTEX_RESPONSE = 5; // how hard the vortex corrects a body toward its target swirl velocity (1/s)
const _d = new THREE.Vector3();

/**
 * Force this field exerts on a body of `mass` at `bodyPos` moving at `vel`, written into `out`.
 * `gain` is the Sandbox's live global strength multiplier.
 */
export function fieldForce(
  field: Field, bodyPos: THREE.Vector3, vel: THREE.Vector3, mass: number, gain: number, out: THREE.Vector3,
): THREE.Vector3 {
  out.set(0, 0, 0);
  const s = field.strength * gain;

  if (field.kind === 'wind') {
    return out.copy(field.dir).multiplyScalar(s); // constant, not mass-scaled
  }

  if (field.kind === 'vortex') {
    // A pure tangential force pumps in energy forever and flings bodies out. Instead, steer each
    // body toward a TARGET velocity field — swirl tangentially at ~s m/s plus a gentle inward draw
    // — so it circles stably (a tornado/whirlpool) rather than spiraling away.
    const rx = bodyPos.x - field.pos.x, rz = bodyPos.z - field.pos.z;
    const dist = Math.hypot(rx, rz);
    const influence = 1 - dist / field.radius;
    if (influence <= 0) return out;
    const inv = 1 / (dist || 1);
    const tx = -rz * inv, tz = rx * inv; // tangent (counter-clockwise)
    const targetVx = (tx * s - rx * inv * s * 0.3) * influence; // swirl + inward draw
    const targetVz = (tz * s - rz * inv * s * 0.3) * influence;
    return out.set((targetVx - vel.x) * mass * VORTEX_RESPONSE, 0, (targetVz - vel.z) * mass * VORTEX_RESPONSE);
  }

  // attractor / repeller
  _d.subVectors(field.pos, bodyPos);
  const dist = _d.length();
  const influence = 1 - dist / field.radius;
  if (influence <= 0) return out;
  const sign = field.kind === 'attractor' ? 1 : -1;
  return out.copy(_d).divideScalar(dist || 1).multiplyScalar(sign * s * mass * influence);
}
