/**
 * FIELD FLOW — the "make the force visible" system.
 *
 * Every field gets a cloud of lightweight, glowing TRACER particles that drift by the field's OWN force
 * (the exact same `fieldForce` the physics uses), so you can literally see the wind blow, the vortex
 * swirl, the attractor suck inward, the gravity well's orbits, turbulence churn, and a flow curve
 * stream — before you drop a single object in. It's pure eye-candy + read-out: the tracers are visual
 * only, never touch the physics, and are advected on the render thread. Additive-blended soft dots that
 * fade in and out over a short life read as flowing energy; a stalled field (nothing moving) looks
 * calm, a strong one looks fast — the motion IS the strength read-out.
 *
 * Truthful by construction: because a tracer is pushed by `fieldForce(field, pos, vel, 1, gain)`, what
 * you watch is exactly what a unit-mass object would do. The ghost being placed is fed in too, so you
 * preview the flow while you position it.
 */
import * as THREE from 'three';
import { fieldForce, FIELD_INFO, type Field } from './fields';

const PER_FIELD = 260; // tracers per field — cheap (a handful of fields × 260 is trivial to advect)
const MAX_LIFE = 1.9; // seconds a tracer lives before it respawns (keeps the flow continuous, not piled)
const DOT_SIZE = 0.55; // world-space size of a tracer dot
const SPEED_CAP = 16; // clamp tracer speed so a strong field streaks stay watchable, not teleporting
const DAMP = 0.985; // gentle drag so a tracer that coasts out of the region slows instead of flying off

/** A soft radial dot so tracers read as glowing motes rather than hard squares. (Shared with the
 *  draw pad, which uses the same texture to make sketch strokes glow.) */
export function softDot(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.65)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

interface Viz {
  points: THREE.Points;
  pos: Float32Array; // 3·N current positions
  vel: Float32Array; // 3·N current velocities
  life: Float32Array; // N remaining life (seconds)
  posAttr: THREE.BufferAttribute;
  colAttr: THREE.BufferAttribute;
  color: THREE.Color; // the field's kind color (tracers are tinted by it, dimmed by fade)
  bound: number; // respawn a tracer once it drifts past this distance from the field centre
}

export class FieldFlow {
  private enabled = true;
  private group = new THREE.Group();
  private viz = new Map<number, Viz>();
  private dot = softDot();
  private last = performance.now();

  private _p = new THREE.Vector3();
  private _v = new THREE.Vector3();
  private _f = new THREE.Vector3();

  constructor(scene: THREE.Scene) { scene.add(this.group); }

  setEnabled(on: boolean) { this.enabled = on; this.group.visible = on; }
  get isEnabled(): boolean { return this.enabled; }

  /** Advance every field's tracer cloud one frame. Pass the live fields plus (optionally) the ghost —
   *  identify the ghost via `ghostId` and its cloud renders dimmed, so a mere preview never reads as a
   *  force that's already live. */
  update(fields: Field[], gain: number, ghostId = -1) {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.05); // clamp so a hitch doesn't fling tracers
    this.last = now;
    if (!this.enabled) return;

    const seen = new Set<number>();
    for (const field of fields) {
      if (field.hidden) continue; // a hidden field still acts, but we don't draw its flow either
      seen.add(field.id);
      let v = this.viz.get(field.id);
      if (!v) { v = this.make(field); this.viz.set(field.id, v); }
      (v.points.material as THREE.PointsMaterial).opacity = field.id === ghostId ? 0.35 : 1;
      this.advect(field, v, gain, dt);
    }
    // drop clouds whose field is gone (deleted / committed-away / hidden)
    for (const [id, v] of this.viz) {
      if (seen.has(id)) continue;
      this.group.remove(v.points);
      v.points.geometry.dispose();
      (v.points.material as THREE.Material).dispose();
      this.viz.delete(id);
    }
  }

  dispose() {
    for (const v of this.viz.values()) {
      this.group.remove(v.points);
      v.points.geometry.dispose();
      (v.points.material as THREE.Material).dispose();
    }
    this.viz.clear();
    this.dot.dispose();
  }

  // ---- per-field cloud ----------------------------------------------------------------------------
  private make(field: Field): Viz {
    const n = PER_FIELD;
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3), life = new Float32Array(n), col = new Float32Array(n * 3);
    const bound = this.boundFor(field);
    for (let i = 0; i < n; i++) this.reseed(field, pos, vel, life, i, true);
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(pos, 3); posAttr.setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(col, 3); colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', colAttr);
    const mat = new THREE.PointsMaterial({
      size: DOT_SIZE, map: this.dot, vertexColors: true, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.group.add(points);
    return { points, pos, vel, life, posAttr, colAttr, color: new THREE.Color(FIELD_INFO[field.kind].color), bound };
  }

  private advect(field: Field, v: Viz, gain: number, dt: number) {
    const { pos, vel, life, color } = v;
    const col = v.colAttr.array as Float32Array;
    const cx = field.pos.x, cy = field.pos.y, cz = field.pos.z;
    const b2 = v.bound * v.bound;
    for (let i = 0; i < PER_FIELD; i++) {
      const j = i * 3;
      this._p.set(pos[j], pos[j + 1], pos[j + 2]);
      this._v.set(vel[j], vel[j + 1], vel[j + 2]);
      fieldForce(field, this._p, this._v, 1, gain, this._f); // force on a unit-mass tracer (truthful)
      this._v.addScaledVector(this._f, dt); // integrate (mass 1 → force is acceleration)
      this._v.multiplyScalar(DAMP); // gentle drag: keeps orbits tidy, stops escapees coasting forever
      const sp = this._v.length();
      if (sp > SPEED_CAP) this._v.multiplyScalar(SPEED_CAP / sp);
      this._p.addScaledVector(this._v, dt);
      life[i] -= dt;

      const dx = this._p.x - cx, dy = this._p.y - cy, dz = this._p.z - cz;
      if (life[i] <= 0 || dx * dx + dy * dy + dz * dz > b2) {
        this.reseed(field, pos, vel, life, i, false); // died or drifted out → respawn in the region
      } else {
        pos[j] = this._p.x; pos[j + 1] = this._p.y; pos[j + 2] = this._p.z;
        vel[j] = this._v.x; vel[j + 1] = this._v.y; vel[j + 2] = this._v.z;
      }
      // fade in from birth, out toward death (sin over the life fraction) → soft, breathing motes
      const fade = Math.sin(Math.PI * Math.max(0, Math.min(1, life[i] / MAX_LIFE)));
      col[j] = color.r * fade; col[j + 1] = color.g * fade; col[j + 2] = color.b * fade;
    }
    v.posAttr.needsUpdate = true;
    v.colAttr.needsUpdate = true;
  }

  /** Drop tracer `i` back into the field's region with a fresh (staggered) life and zero velocity. */
  private reseed(field: Field, pos: Float32Array, vel: Float32Array, life: Float32Array, i: number, stagger: boolean) {
    this.randomInRegion(field, this._p);
    const j = i * 3;
    pos[j] = this._p.x; pos[j + 1] = this._p.y; pos[j + 2] = this._p.z;
    vel[j] = 0; vel[j + 1] = 0; vel[j + 2] = 0;
    life[i] = stagger ? Math.random() * MAX_LIFE : MAX_LIFE; // stagger on first fill so they don't pulse together
  }

  /** A random point inside the field's region (or tube, for a path), in world space. */
  private randomInRegion(field: Field, out: THREE.Vector3) {
    const s = field.size;
    if (field.kind === 'path' && field.path) {
      const p = field.path.pts, n = p.length / 3;
      const k = Math.floor(Math.random() * n) * 3;
      const r = s.x * 0.7;
      out.set(p[k] + (Math.random() - 0.5) * 2 * r, p[k + 1] + (Math.random() - 0.5) * 2 * r, p[k + 2] + (Math.random() - 0.5) * 2 * r);
      out.applyQuaternion(field.quat).add(field.pos);
      return;
    }
    if (field.shape === 'sphere') {
      const r = s.x * Math.cbrt(Math.random()); // uniform in the ball's volume
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, k = Math.sqrt(1 - u * u);
      out.set(r * k * Math.cos(a), r * u, r * k * Math.sin(a)).add(field.pos); // sphere region ignores quat
      return;
    }
    if (field.shape === 'cylinder') {
      const rr = s.x * Math.sqrt(Math.random()), a = Math.random() * Math.PI * 2;
      out.set(rr * Math.cos(a), (Math.random() * 2 - 1) * s.y, rr * Math.sin(a));
    } else { // box
      out.set((Math.random() * 2 - 1) * s.x, (Math.random() * 2 - 1) * s.y, (Math.random() * 2 - 1) * s.z);
    }
    out.applyQuaternion(field.quat).add(field.pos);
  }

  private boundFor(field: Field): number {
    // keep tracers snug to the region: respawn as soon as one drifts just past the boundary, so the
    // cloud reads as "the field" instead of a scatter of escapees coasting off across the scene
    if (field.kind === 'path' && field.path) return field.path.scale * 1.15 + field.size.x;
    const s = field.size;
    return Math.max(s.x, s.y, s.z) * 1.08 + 0.5;
  }
}
