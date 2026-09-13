/**
 * DEV LAB — does the simulator match real life? Every experiment here builds a textbook situation in
 * a HEADLESS lab sandbox (the exact same physics code path as the live scene — Rapier, fields, joints,
 * accretion, breakage — just no renderer), runs it with fixed steps, measures the outcome, and compares
 * it to the analytic / real-world value. The live scene is never touched.
 *
 * Each result is PASS (within tolerance), WARN (within 3× tolerance) or FAIL. A failing experiment is a
 * concrete, reproducible accuracy bug with a number attached — that's the point: tune against these, not
 * against "looks right". Tolerances state what the model can honestly deliver (e.g. the integrator is
 * semi-implicit Euler, so a free fall leads the exact parabola by ½·g·dt·t — about 1% at 1.8 s).
 *
 * Units: sim mass is tonnes (density in water-units), so forces are kN and energies kJ — every result
 * below is a ratio, a speed, a length or a time, which are unit-free across that scale.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { Sandbox, type Entity } from '../sandbox';
import { PRESETS, type Material } from './materials';
import { SURFACE_PRESETS } from './shapes';
import type { FieldData } from './persistence';

export const DT = 1 / 60; // the sandbox's fixed physics step
const G = 9.81;
const deg = Math.PI / 180;
type Vec3 = [number, number, number];

export type Status = 'pass' | 'warn' | 'fail';

export interface LabResult {
  id: string; name: string; group: string; law: string;
  measured: number; expected: number; unit: string;
  errPct: number; // signed % error vs expected (or absolute error × 100 when expected is 0)
  tolPct: number; absTol?: number;
  status: Status;
  detail: string;
  ms: number; // wall-clock cost of the run
}

interface Outcome { measured: number; expected: number; unit: string; detail?: string; absTol?: number }

export interface Experiment {
  id: string;
  name: string;
  group: string;
  law: string; // the real-world law / value it's checked against (shown in the Lab list)
  tolPct: number;
  run(c: LabCtx): Outcome;
}

const preset = (id: string) => PRESETS.find((m) => m.id === id)!;

/** Helpers an experiment uses to build its scene in the lab world (and tidy up after). */
export class LabCtx {
  private extra: RAPIER.RigidBody[] = [];
  constructor(readonly S: Sandbox) {}

  V(x = 0, y = 0, z = 0) { return new THREE.Vector3(x, y, z); }

  /** An ad-hoc material (plain look). `density` in kg/m³ like the presets. */
  mat(p: Partial<Material>): Material {
    const m: Material = { id: '', name: 'Lab', density: 1000, friction: 0.5, restitution: 0, color: '', ...p };
    m.id = `lab:${m.density}:${m.friction}:${m.restitution}`;
    return m;
  }

  /** Put a body exactly at a pose with an exact velocity (spawn adds random spin/drift — kill it). */
  place(e: Entity, pos: Vec3, vel: Vec3 = [0, 0, 0], quat?: THREE.Quaternion, angvel: Vec3 = [0, 0, 0]) {
    e.body.setTranslation({ x: pos[0], y: pos[1], z: pos[2] }, true);
    const q = quat ?? new THREE.Quaternion();
    e.body.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
    e.body.setLinvel({ x: vel[0], y: vel[1], z: vel[2] }, true);
    e.body.setAngvel({ x: angvel[0], y: angvel[1], z: angvel[2] }, true);
    e.prevPos.set(...pos); e.currPos.set(...pos);
    e.prevQuat.copy(q); e.currQuat.copy(q);
    e.lastVel.set(...vel);
    return e;
  }

  sphere(pos: Vec3, r: number, mat: Material, vel: Vec3 = [0, 0, 0]) {
    return this.place(this.S.spawn('sphere', this.V(...pos), r, mat), pos, vel);
  }

  box(pos: Vec3, half: number, mat: Material, vel: Vec3 = [0, 0, 0], quat?: THREE.Quaternion) {
    return this.place(this.S.spawn('box', this.V(...pos), half, mat), pos, vel, quat);
  }

  /** A static, non-entity collider (ramps, walls). Removed after the experiment. */
  fixedCuboid(pos: Vec3, half: Vec3, quat: THREE.Quaternion, friction: number, restitution = 0) {
    const b = this.S.world.createRigidBody(RAPIER.RigidBodyDesc.fixed()
      .setTranslation(...pos).setRotation({ x: quat.x, y: quat.y, z: quat.z, w: quat.w }));
    this.S.world.createCollider(RAPIER.ColliderDesc.cuboid(...half).setFriction(friction).setRestitution(restitution), b);
    this.extra.push(b);
    return b;
  }

  /** A fixed, collider-less pivot body (joint anchors). */
  anchor(pos: Vec3) {
    const b = this.S.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...pos));
    this.extra.push(b);
    return b;
  }

  field(fd: Partial<FieldData> & { kind: string }) {
    return this.S.addField({ shape: 'sphere', pos: [0, 0, 0], quat: [0, 0, 0, 1], size: [10, 10, 10], strength: 1, hidden: false, ...fd });
  }

  /** A ramp of `deg` degrees sloping DOWN toward +x. Returns the down-slope unit vector, surface normal
   *  and a start point on the surface 8 m up-slope from the centre. */
  ramp(angleDeg: number, friction: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(this.V(0, 0, 1), -angleDeg * deg);
    const centre = this.V(0, 10, 0);
    this.fixedCuboid([0, 10, 0], [12, 0.5, 3], q, friction);
    const n = this.V(0, 1, 0).applyQuaternion(q);
    const down = this.V(1, 0, 0).applyQuaternion(q);
    const surface = centre.clone().addScaledVector(n, 0.5).addScaledVector(down, -8);
    return { q, n, down, surface };
  }

  totalMass() { return this.S.entities.reduce((s, e) => s + e.body.mass(), 0); }

  cleanup() {
    for (const b of this.extra) if (b.isValid()) this.S.world.removeRigidBody(b);
    this.extra = [];
  }
}

/** Times (s) at which a sampled signal changes sign, linearly interpolated between steps. */
function signCrossings(samples: number[], dir: 'up' | 'down' | 'any' = 'any'): number[] {
  const out: number[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i];
    const up = a < 0 && b >= 0, down = a > 0 && b <= 0;
    if ((dir === 'up' && up) || (dir === 'down' && down) || (dir === 'any' && (up || down))) {
      out.push((i - 1 + a / (a - b)) * DT);
    }
  }
  return out;
}

/** Period from same-direction crossings (averaged over all complete cycles). */
function periodOf(samples: number[]): number {
  const c = signCrossings(samples, 'up');
  return c.length >= 2 ? (c[c.length - 1] - c[0]) / (c.length - 1) : NaN;
}

/** Depth h (as a fraction of the diameter) at which a floating sphere displaces `frac` of its volume. */
function sphereDraftFraction(frac: number): number {
  let lo = 0, hi = 2; // h in units of r
  for (let i = 0; i < 60; i++) {
    const h = (lo + hi) / 2;
    const vf = (h * h * (3 - h)) / 4; // cap volume πh²(3r−h)/3 over (4/3)πr³, with r = 1
    if (vf < frac) lo = h; else hi = h;
  }
  return (lo + hi) / 4; // h / (2r)
}

function pendulum(c: LabCtx, seconds: number) {
  const L = 3, r = 0.2, th0 = 10 * deg, py = 20;
  const bx = L * Math.sin(th0), by = py - L * Math.cos(th0);
  const ball = c.sphere([bx, by, 0], r, c.mat({ friction: 0 }));
  const piv = c.anchor([0, py, 0]);
  c.S.world.createImpulseJoint(RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: -bx, y: py - by, z: 0 }), piv, ball.body, true);
  const xs: number[] = [];
  for (let i = 0; i < Math.round(seconds / DT); i++) { c.S.step(); xs.push(ball.body.translation().x); }
  const T0 = 2 * Math.PI * Math.sqrt((L * L + 0.4 * r * r) / (G * L)); // physical pendulum (ball has size)
  const T = T0 * (1 + (th0 * th0) / 16 + (11 * th0 ** 4) / 3072); // finite-amplitude correction
  return { xs, T };
}

export const EXPERIMENTS: Experiment[] = [
  // ------------------------------------------------------------------ mechanics (engine + constants)
  {
    id: 'free-fall', group: 'Mechanics', name: 'Free fall', law: 'd = ½·g·t²', tolPct: 1.5,
    run: (c) => {
      const e = c.sphere([0, 40, 0], 0.5, c.mat({}));
      const n = 108;
      c.S.step(n);
      const t = n * DT;
      const d = 40 - e.body.translation().y;
      return {
        measured: d, expected: 0.5 * G * t * t, unit: 'm',
        detail: `drop after ${t.toFixed(2)} s · the fixed-step integrator is ${((d - 0.5 * G * t * t) * 100).toFixed(1)} cm ahead of the exact parabola`,
      };
    },
  },
  {
    id: 'projectile', group: 'Mechanics', name: 'Projectile range (45°)', law: 'R = v²·sin 2θ / g', tolPct: 1.5,
    run: (c) => {
      const v0 = 15, th = 45 * deg, y0 = 30;
      const e = c.sphere([0, y0, 0], 0.3, c.mat({}), [v0 * Math.cos(th), v0 * Math.sin(th), 0]);
      let px = 0, py = y0, x = NaN;
      for (let i = 0; i < 600; i++) {
        c.S.step();
        const t = e.body.translation();
        if (i > 5 && t.y < y0 && py >= y0) { x = px + (t.x - px) * ((py - y0) / (py - t.y)); break; }
        px = t.x; py = t.y;
      }
      return { measured: x, expected: (v0 * v0 * Math.sin(2 * th)) / G, unit: 'm', detail: 'range back to launch height, v₀ = 15 m/s, no air' };
    },
  },
  {
    id: 'pendulum-period', group: 'Mechanics', name: 'Pendulum period', law: 'T = 2π√(I/mgL)·(1+θ²/16)', tolPct: 1,
    run: (c) => {
      const { xs, T } = pendulum(c, 18);
      return { measured: periodOf(xs), expected: T, unit: 's', detail: 'L = 3 m ball on a ball joint, θ₀ = 10°, averaged over ~5 swings' };
    },
  },
  {
    id: 'pendulum-energy', group: 'Mechanics', name: 'Pendulum amplitude kept', law: 'no friction → energy conserved', tolPct: 2,
    run: (c) => {
      const { xs, T } = pendulum(c, 36);
      const per = Math.round(T / DT);
      const amp = (a: number, b: number) => xs.slice(a, b).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
      const first = amp(0, per), last = amp(xs.length - per, xs.length);
      return { measured: last / first, expected: 1, unit: '×', detail: `swing amplitude after ~${Math.round(36 / T)} periods vs the first (joint/solver damping shows up here)` };
    },
  },
  {
    id: 'spring-period', group: 'Mechanics', name: 'Spring oscillator (mass matters)', law: 'T = 2π√(m/k)', tolPct: 2,
    run: (c) => {
      c.S.setGravityY(0);
      const k = 2, rest = 1.5, r = 0.3, rho = 8; // heavy ball: an acceleration-based spring would ignore this
      const m = rho * (4 / 3) * Math.PI * r ** 3;
      const piv = c.anchor([0, 20, 0]);
      const ball = c.sphere([rest + 0.5, 20, 0], r, c.mat({ density: rho * 1000 }));
      c.S.world.createImpulseJoint(RAPIER.JointData.spring(rest, k, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), piv, ball.body, true);
      const xs: number[] = [];
      for (let i = 0; i < 1100; i++) { c.S.step(); xs.push(ball.body.translation().x - rest); }
      return { measured: periodOf(xs), expected: 2 * Math.PI * Math.sqrt(m / k), unit: 's', detail: `m = ${(m * 1000).toFixed(0)} kg, k = ${k * 1000} N/m, undamped spring joint` };
    },
  },
  {
    id: 'restitution', group: 'Contacts', name: 'Rubber ball bounce', law: 'h₁ = e²·h₀ (e = 0.8 rubber)', tolPct: 5,
    run: (c) => {
      const rub = preset('rubber');
      const e = c.sphere([0, 5.5, 0], 0.5, rub);
      let bounced = false, pvy = 0, apex = NaN;
      for (let i = 0; i < 900; i++) {
        c.S.step();
        const vy = e.body.linvel().y;
        if (!bounced && vy > 0.3) bounced = true;
        if (bounced && pvy > 0 && vy <= 0) { apex = e.body.translation().y; break; }
        pvy = vy;
      }
      return { measured: Math.sqrt(Math.max(0, apex - 0.5) / 5), expected: rub.restitution, unit: 'e', detail: `dropped 5 m onto the floor; effective COR = √(h₁/h₀), rebound ${(apex - 0.5).toFixed(2)} m` };
    },
  },
  {
    id: 'ice-slide', group: 'Contacts', name: 'Ice sliding on the floor', law: 'a = μ_ice·g (μ = 0.05)', tolPct: 10,
    run: (c) => {
      const ice = preset('ice');
      const e = c.box([0, 0.5, 0], 0.5, ice);
      c.S.step(30);
      c.place(e, [0, e.body.translation().y, 0], [5, 0, 0]);
      const n = 18;
      c.S.step(n);
      const a = (5 - e.body.linvel().x) / (n * DT);
      return { measured: a, expected: ice.friction * G, unit: 'm/s²', detail: 'deceleration of an ice block pushed at 5 m/s (pair friction = the slippery surface)' };
    },
  },
  {
    id: 'incline-slide', group: 'Contacts', name: 'Box sliding down a 30° ramp', law: 'a = g(sin θ − μ cos θ)', tolPct: 3,
    run: (c) => {
      const mu = 0.2, half = 0.3;
      const rp = c.ramp(30, mu);
      const start = rp.surface.clone().addScaledVector(rp.n, half);
      const e = c.box([start.x, start.y, start.z], half, c.mat({ friction: mu }), [0, 0, 0], rp.q);
      const n = 60;
      c.S.step(n);
      const t = e.body.translation();
      const s = c.V(t.x, t.y, t.z).sub(start).dot(rp.down);
      return { measured: (2 * s) / (n * DT) ** 2, expected: G * (Math.sin(30 * deg) - mu * Math.cos(30 * deg)), unit: 'm/s²', detail: `μ = ${mu} on both surfaces, from rest, over 1 s` };
    },
  },
  {
    id: 'rolling-solid', group: 'Contacts', name: 'Solid ball rolling down a ramp', law: 'a = (5/7)·g·sin θ', tolPct: 2,
    run: (c) => {
      const r = 0.4;
      const rp = c.ramp(30, 0.8);
      const start = rp.surface.clone().addScaledVector(rp.n, r);
      const e = c.sphere([start.x, start.y, start.z], r, c.mat({ friction: 0.8 }));
      const n = 60;
      c.S.step(n);
      const t = e.body.translation();
      const s = c.V(t.x, t.y, t.z).sub(start).dot(rp.down);
      return { measured: (2 * s) / (n * DT) ** 2, expected: (5 / 7) * G * Math.sin(30 * deg), unit: 'm/s²', detail: 'rolling without slipping: I = (2/5)·m·r²' };
    },
  },
  {
    id: 'shell-inertia', group: 'Shapes', name: 'Hollow ball inertia', law: 'I/m = (2/5)(b⁵−a⁵)/(b³−a³)', tolPct: 2,
    run: (c) => {
      const p = SURFACE_PRESETS.find((s) => s.name === 'Hollow ball')!;
      const res = c.S.createParamSurface({ ...p, density: 1 }, c.mat({}));
      if (!res.ok) throw new Error(res.error);
      c.S.setGravityY(0);
      c.S.step(1);
      const I = res.entity.body.principalInertia(), m = res.entity.body.mass();
      const a = 1.3 - p.thickness / 2, b = 1.3 + p.thickness / 2;
      return { measured: (I.x + I.y + I.z) / 3 / m, expected: 0.4 * (b ** 5 - a ** 5) / (b ** 3 - a ** 3), unit: 'm²', detail: `shell R = 1.3 m, wall ${p.thickness} m — mass properties from the surface creator` };
    },
  },
  {
    id: 'rolling-hollow', group: 'Shapes', name: 'Hollow ball rolling down a ramp', law: 'a = g·sin θ / (1 + I/mR²)', tolPct: 4,
    run: (c) => {
      const p = SURFACE_PRESETS.find((s) => s.name === 'Hollow ball')!;
      const res = c.S.createParamSurface({ ...p, density: 1 }, c.mat({ friction: 0.9 }));
      if (!res.ok) throw new Error(res.error);
      const e = res.entity;
      const R = 1.3 + p.thickness / 2; // the shell collider is rounded outward by half the wall
      const rp = c.ramp(30, 0.9);
      const start = rp.surface.clone().addScaledVector(rp.n, R + 0.002);
      c.place(e, [start.x, start.y + 30, start.z]); // park far above for the mass-finalizing step
      c.S.setGravityY(0); c.S.step(1); c.S.setGravityY(-G);
      const I = e.body.principalInertia(), m = e.body.mass();
      const k = (I.x + I.y + I.z) / 3 / (m * R * R);
      c.place(e, [start.x, start.y, start.z]);
      const n = 60;
      c.S.step(n);
      const t = e.body.translation();
      const s = c.V(t.x, t.y, t.z).sub(start).dot(rp.down);
      return { measured: (2 * s) / (n * DT) ** 2, expected: (G * Math.sin(30 * deg)) / (1 + k), unit: 'm/s²', detail: `I/mR² = ${k.toFixed(3)} (thin shell → 2/3) · faceted slab collider` };
    },
  },
  {
    id: 'elastic-collision', group: 'Contacts', name: 'Elastic collision (1 kg·3 kg)', law: "v₂' = 2m₁v₁/(m₁+m₂)", tolPct: 2,
    run: (c) => {
      c.S.setGravityY(0);
      c.sphere([-3, 10, 0], 0.5, c.mat({ restitution: 1, friction: 0, density: 1000 }), [4, 0, 0]);
      const b = c.sphere([0, 10, 0], 0.5, c.mat({ restitution: 1, friction: 0, density: 3000 }));
      c.S.step(90);
      return { measured: b.body.linvel().x, expected: (2 * 1 * 4) / (1 + 3), unit: 'm/s', detail: 'head-on, zero-G, restitution 1 — target ball speed after impact' };
    },
  },
  {
    id: 'momentum-collision', group: 'Conservation', name: 'Momentum through a collision', law: 'Σ m·v constant', tolPct: 0.5,
    run: (c) => {
      c.S.setGravityY(0);
      const a = c.sphere([-3, 10, 0.1], 0.5, c.mat({ restitution: 0.5, friction: 0.3, density: 1000 }), [4, 0, 0]);
      const b = c.sphere([0, 10, 0], 0.5, c.mat({ restitution: 0.5, friction: 0.3, density: 3000 }));
      c.S.step(90);
      const ma = a.body.mass(), mb = b.body.mass();
      return { measured: ma * a.body.linvel().x + mb * b.body.linvel().x, expected: ma * 4, unit: 'kN·s', detail: 'slightly off-centre, restitution 0.5 — x-momentum after the hit' };
    },
  },
  // ------------------------------------------------------------------ fluids
  {
    id: 'buoy-box', group: 'Fluids', name: 'Floating wood block draft', law: 'submerged fraction = ρ_wood/ρ_water', tolPct: 2,
    run: (c) => {
      c.field({ kind: 'fluid', shape: 'box', pos: [0, 5, 0], size: [10, 5, 10], strength: 1 });
      const wood = preset('wood');
      const e = c.box([0, 9.6, 0], 0.5, wood);
      c.S.step(540);
      let y = 0;
      for (let i = 0; i < 60; i++) { c.S.step(); y += e.body.translation().y / 60; }
      return { measured: 10 - (y - 0.5), expected: wood.density / 1000, unit: '', detail: '1 m wood cube in water, averaged once settled' };
    },
  },
  {
    id: 'buoy-sphere', group: 'Fluids', name: 'Floating wood ball draft', law: 'cap volume πh²(3r−h)/3 = ρ ratio · V', tolPct: 2,
    run: (c) => {
      c.field({ kind: 'fluid', shape: 'box', pos: [0, 5, 0], size: [10, 5, 10], strength: 1 });
      const wood = preset('wood');
      const e = c.sphere([0, 9.6, 0], 0.5, wood);
      c.S.step(540);
      let y = 0;
      for (let i = 0; i < 60; i++) { c.S.step(); y += e.body.translation().y / 60; }
      return { measured: (10 - (y - 0.5)) / 1, expected: sphereDraftFraction(wood.density / 1000), unit: 'h/2r', detail: 'a ball displaces less volume per depth near its poles' };
    },
  },
  {
    id: 'sink-steel', group: 'Fluids', name: 'Steel ball released under water', law: 'a = g(ρs−ρf)/(ρs+½ρf)', tolPct: 2,
    run: (c) => {
      c.field({ kind: 'fluid', shape: 'box', pos: [0, 5, 0], size: [10, 5, 10], strength: 1 });
      const steel = preset('steel');
      const e = c.sphere([0, 4, 0], 0.5, steel);
      c.S.step(1); // mass finalizes; buoyancy acts from this step on
      c.place(e, [0, 4, 0]);
      c.S.step(1);
      const rs = steel.density / 1000, rf = 1;
      return { measured: -e.body.linvel().y / DT, expected: (G * (rs - rf)) / (rs + 0.5 * rf), unit: 'm/s²', detail: 'initial acceleration — real bodies also drag along ½ their displaced water (added mass)' };
    },
  },
  {
    id: 'raised-tank', group: 'Fluids', name: 'Nothing floats under a raised tank', law: 'buoyancy only inside the water', tolPct: 0,
    run: (c) => {
      c.field({ kind: 'fluid', shape: 'box', pos: [0, 20, 0], size: [10, 5, 10], strength: 1 });
      const e = c.sphere([0, 0.5, 0], 0.5, preset('wood'));
      c.S.step(120);
      return { measured: e.body.translation().y, expected: 0.5, unit: 'm', absTol: 0.02, detail: 'wood ball resting on the floor 14 m below a water tank' };
    },
  },
  // ------------------------------------------------------------------ fields
  {
    id: 'drag-decay', group: 'Fields', name: 'Drag zone velocity decay', law: 'v = v₀·e^(−kt)', tolPct: 1,
    run: (c) => {
      c.S.setGravityY(0);
      c.field({ kind: 'drag', pos: [0, 10, 0], size: [30, 30, 30], strength: 2 });
      const e = c.sphere([-4, 10, 0], 0.4, c.mat({}), [10, 0, 0]);
      c.S.step(60);
      return { measured: e.body.linvel().x, expected: 10 * Math.exp(-2), unit: 'm/s', detail: 'k = 2 /s, v₀ = 10 m/s, after 1 s' };
    },
  },
  {
    id: 'cyclotron-speed', group: 'Fields', name: 'Magnetic field keeps speed', law: 'F ⊥ v → |v| constant', tolPct: 1,
    run: (c) => {
      c.S.setGravityY(0);
      c.field({ kind: 'magnetic', pos: [0, 10, 0], size: [40, 40, 40], strength: 2 });
      const e = c.sphere([2.5, 10, 0], 0.3, c.mat({}), [0, 0, 5]);
      c.S.step(Math.round((3 * Math.PI) / DT)); // three revolutions (T = 2π/ω = π s)
      const v = e.body.linvel();
      return { measured: Math.hypot(v.x, v.y, v.z), expected: 5, unit: 'm/s', detail: 'charged body circling for 3 revolutions (magnetic force does no work)' };
    },
  },
  {
    id: 'cyclotron-radius', group: 'Fields', name: 'Magnetic circle radius', law: 'r = v/ω', tolPct: 2,
    run: (c) => {
      c.S.setGravityY(0);
      c.field({ kind: 'magnetic', pos: [0, 10, 0], size: [40, 40, 40], strength: 2 });
      const e = c.sphere([2.5, 10, 0], 0.3, c.mat({}), [0, 0, 5]);
      let sum = 0, n = 0;
      for (let i = 0; i < 189; i++) { c.S.step(); const t = e.body.translation(); sum += Math.hypot(t.x, t.z); n++; }
      return { measured: sum / n, expected: 5 / 2, unit: 'm', detail: 'mean distance from the circle centre over one revolution' };
    },
  },
  {
    id: 'well-orbit', group: 'Fields', name: 'Gravity well circular orbit', law: 'T = 2πr / √(a·r)', tolPct: 1,
    run: (c) => {
      c.S.setGravityY(0);
      const strength = 8, r = 10;
      c.field({ kind: 'gravitywell', pos: [0, 20, 0], size: [60, 60, 60], strength });
      const a = (strength * 60) / (r * r + 1.5 * 1.5); // WELL_GM 60, Plummer softening 1.5
      const v = Math.sqrt(a * r);
      const e = c.sphere([r, 20, 0], 0.3, c.mat({}), [0, 0, v]);
      const zs: number[] = [];
      let rMax = 0, rMin = Infinity;
      for (let i = 0; i < Math.round((2.3 * 2 * Math.PI * r) / v / DT); i++) {
        c.S.step();
        const t = e.body.translation();
        zs.push(t.x > 0 ? t.z : NaN);
        const rr = Math.hypot(t.x, t.z); rMax = Math.max(rMax, rr); rMin = Math.min(rMin, rr);
      }
      return { measured: periodOf(zs.map((z) => (Number.isNaN(z) ? 1 : z))), expected: (2 * Math.PI * r) / v, unit: 's', detail: `softened 1/r² pull; radius stayed ${rMin.toFixed(2)}–${rMax.toFixed(2)} m` };
    },
  },
  {
    id: 'binary-orbit', group: 'Fields', name: 'Mutual gravity binary orbit', law: 'T = 2π·(d/2)/v, softened', tolPct: 1,
    run: (c) => {
      c.S.setGravityY(0);
      c.S.setSelfGravity(true);
      const rho = 50, r = 0.5, d = 6;
      const m = rho * (4 / 3) * Math.PI * r ** 3;
      const a = (1 * m * d) / (d * d + 0.36) ** 1.5; // Plummer-softened (ε = 0.6), G = 1
      const v = Math.sqrt(a * (d / 2));
      const mat = c.mat({ density: rho * 1000 });
      c.sphere([-d / 2, 20, 0], r, mat, [0, 0, -v]);
      const b = c.sphere([d / 2, 20, 0], r, mat, [0, 0, v]);
      const zs: number[] = [];
      for (let i = 0; i < Math.round((2.2 * 2 * Math.PI * (d / 2)) / v / DT); i++) {
        c.S.step();
        const t = b.body.translation();
        zs.push(t.x > 0 ? t.z : 1);
      }
      return { measured: periodOf(zs), expected: (2 * Math.PI * (d / 2)) / v, unit: 's', detail: `two ${(m * 1000).toFixed(0)} kg balls 6 m apart, Barnes-Hut tree` };
    },
  },
  {
    id: 'wind-arcade', group: 'Fields', name: 'Wind reaches wind speed', law: 'arcade model: v → strength', tolPct: 1,
    run: (c) => {
      c.S.setGravityY(0);
      c.field({ kind: 'wind', shape: 'box', pos: [0, 10, 0], size: [20, 20, 20], strength: 8 });
      const e = c.sphere([-8, 10, 0], 0.4, c.mat({}));
      c.S.step(60);
      return { measured: e.body.linvel().x, expected: 8 * (1 - (1 - 5 * DT) ** 60), unit: 'm/s', detail: 'velocity-target steering (response 5/s) after 1 s — the arcade semantics' };
    },
  },
  // ------------------------------------------------------------------ conservation through emergent systems
  {
    id: 'accretion-mass', group: 'Conservation', name: 'Mass through accretion', law: 'Σ m constant', tolPct: 0.1,
    run: (c) => {
      c.S.setGravityY(0);
      c.S.setSelfGravity(true);
      c.S.setAccretion(true);
      const r = 0.4, rho = 20;
      const mat = c.mat({ density: rho * 1000, restitution: 0.1 });
      let n = 0;
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 3; k++) {
        c.sphere([i * 0.95 - 1.4, 20 + j * 0.95, k * 0.95 - 1], r, mat, [1 + 0.1 * Math.sin(n * 1.7), 0.1 * Math.cos(n * 2.3), 0]);
        n++;
      }
      const m0 = n * rho * (4 / 3) * Math.PI * r ** 3;
      c.S.step(600);
      c.S.setAccretion(false);
      c.S.step(1); // let bodies merged on the last step finalize their mass
      return { measured: c.totalMass(), expected: m0, unit: 't', detail: `${n} self-gravitating balls → ${c.S.entities.length} bodies after 10 s` };
    },
  },
  {
    id: 'breakage-mass', group: 'Conservation', name: 'Mass through a shatter', law: 'Σ m constant', tolPct: 0.1,
    run: (c) => {
      c.S.setBreakage(true);
      const stone = preset('stone');
      c.sphere([0, 3, 0], 1, stone, [0, -40, 0]);
      const m0 = (stone.density / 1000) * (4 / 3) * Math.PI;
      c.S.step(60);
      c.S.setBreakage(false);
      c.S.step(1);
      return { measured: c.totalMass(), expected: m0, unit: 't', detail: `stone ball slammed into the floor at 40 m/s → ${c.S.entities.length} pieces` };
    },
  },
  {
    id: 'determinism', group: 'Conservation', name: 'Deterministic replay', law: 'same inputs → same result', tolPct: 0,
    run: () => {
      const once = () => {
        const S = new Sandbox(document.createElement('canvas'), { headless: true });
        const lab = new LabCtx(S);
        for (let i = 0; i < 24; i++) lab.box([(i % 6) * 1.2 - 3, 0.5 + Math.floor(i / 6) * 1.05, 0], 0.5, lab.mat({}));
        lab.field({ kind: 'tornado', shape: 'cylinder', pos: [0, 6, 0], size: [10, 9, 10], strength: 10 });
        lab.field({ kind: 'turbulence', pos: [0, 3, 0], size: [8, 8, 8], strength: 6 });
        S.step(400);
        const pts = S.entities.map((e) => e.body.translation());
        lab.cleanup();
        S.dispose();
        return pts;
      };
      const a = once(), b = once();
      let worst = a.length === b.length ? 0 : Infinity;
      for (let i = 0; i < Math.min(a.length, b.length); i++) worst = Math.max(worst, Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y, a[i].z - b[i].z));
      return { measured: worst, expected: 0, unit: 'm', absTol: 0, detail: '24 boxes in a tornado + turbulence, run twice in fresh worlds — worst position difference' };
    },
  },
];

/** Runs experiments in one reusable headless lab world and keeps the latest result of each. */
export class DevLab {
  private S: Sandbox | null = null;
  readonly results = new Map<string, LabResult>();

  private get lab(): Sandbox {
    return (this.S ??= new Sandbox(document.createElement('canvas'), { headless: true }));
  }

  run(id: string): LabResult {
    const ex = EXPERIMENTS.find((x) => x.id === id);
    if (!ex) throw new Error(`no experiment "${id}"`);
    const S = this.lab;
    S.resetForLab();
    const ctx = new LabCtx(S);
    const t0 = performance.now();
    let out: Outcome;
    try {
      out = ex.run(ctx);
    } catch (err) {
      out = { measured: NaN, expected: NaN, unit: '', detail: `threw: ${(err as Error)?.message ?? err}` };
    } finally {
      ctx.cleanup();
      S.resetForLab();
    }
    const errPct = out.expected !== 0 ? ((out.measured - out.expected) / Math.abs(out.expected)) * 100 : (out.measured - out.expected) * 100;
    let status: Status;
    if (!Number.isFinite(out.measured)) status = 'fail';
    else if (out.absTol != null) {
      const d = Math.abs(out.measured - out.expected);
      status = d <= out.absTol ? 'pass' : d <= Math.max(3 * out.absTol, 1e-9) ? 'warn' : 'fail';
    } else {
      const a = Math.abs(errPct);
      status = a <= ex.tolPct ? 'pass' : a <= 3 * ex.tolPct ? 'warn' : 'fail';
    }
    const res: LabResult = {
      id: ex.id, name: ex.name, group: ex.group, law: ex.law,
      measured: out.measured, expected: out.expected, unit: out.unit,
      errPct, tolPct: ex.tolPct, absTol: out.absTol, status,
      detail: out.detail ?? '', ms: performance.now() - t0,
    };
    this.results.set(ex.id, res);
    return res;
  }

  /** Run everything (yielding between experiments so the page stays responsive). */
  async runAll(onEach?: (r: LabResult) => void): Promise<LabResult[]> {
    const out: LabResult[] = [];
    for (const ex of EXPERIMENTS) {
      const r = this.run(ex.id);
      out.push(r);
      onEach?.(r);
      await new Promise((res) => setTimeout(res, 0));
    }
    return out;
  }
}
