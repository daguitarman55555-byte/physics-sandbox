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
import { Sandbox, setContactRules, type Entity } from '../sandbox';
import { PRESETS, type Material } from './materials';
import { SURFACE_PRESETS } from './shapes';
import { flowVelocity } from './fields';
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
    e.accel.set(0, 0, 0); e.hydroPrev = undefined; // a placed body starts with no motion history
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
    setContactRules(this.S.world.createCollider(RAPIER.ColliderDesc.cuboid(...half).setFriction(friction).setRestitution(restitution), b));
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

  /** Detonate a spherical charge right now (arcade: blast m/s · realistic: kg of TNT). */
  blast(pos: Vec3, radius: number, strength: number) {
    this.S.detonate({
      id: -1, kind: 'explosion', shape: 'sphere', pos: this.V(...pos), quat: new THREE.Quaternion(),
      size: this.V(radius, radius, radius), strength, hidden: false,
    });
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

/** Real sphere drag coefficient vs Reynolds number — the Clift–Gauvin fit to the experimental drag curve. */
function cdSphere(Re: number): number {
  return (24 / Re) * (1 + 0.15 * Re ** 0.687) + 0.42 / (1 + 42500 * Re ** -1.16);
}

/** Terminal velocity of a sphere (densities kg/m³, viscosity Pa·s, radius m) on the real drag curve. */
function terminalSphere(rhoS: number, rhoF: number, mu: number, R: number): number {
  const V = (4 / 3) * Math.PI * R ** 3, A = Math.PI * R * R, W = (rhoS - rhoF) * G * V;
  let lo = 0, hi = 500;
  for (let i = 0; i < 100; i++) {
    const v = (lo + hi) / 2;
    const drag = 0.5 * rhoF * A * cdSphere(Math.max((rhoF * v * 2 * R) / mu, 1e-9)) * v * v;
    if (drag < W) lo = v; else hi = v;
  }
  return (lo + hi) / 2;
}

/** How far a body's nearest face normal is tilted from vertical, in degrees (0 = sitting flat). */
function tiltDeg(e: Entity): number {
  const r = e.body.rotation();
  const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
  let best = 0;
  for (const ax of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) best = Math.max(best, Math.abs(ax.applyQuaternion(q).y));
  return (Math.acos(Math.min(1, best)) * 180) / Math.PI;
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
    id: 'ice-slide', group: 'Contacts', name: 'Ice sliding on the floor', law: 'a = μ·g, ice on concrete μ ≈ 0.1–0.2', tolPct: 10,
    run: (c) => {
      const ice = preset('ice');
      const e = c.box([0, 0.5, 0], 0.5, ice);
      c.S.step(30);
      c.place(e, [0, e.body.translation().y, 0], [5, 0, 0]);
      const n = 18;
      c.S.step(n);
      const a = (5 - e.body.linvel().x) / (n * DT);
      const mu = Math.sqrt(ice.friction * 0.7); // ice 0.05 on the 0.7 floor → 0.19
      return { measured: a, expected: mu * G, unit: 'm/s²', detail: `deceleration of an ice block pushed at 5 m/s — pair μ √(0.05·0.7) = ${mu.toFixed(3)}` };
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
  {
    id: 'rise-wood', group: 'Fluids', name: 'Wood ball released under water', law: 'a = g(ρf−ρs)/(ρs+½ρf)', tolPct: 2,
    run: (c) => {
      c.field({ kind: 'fluid', shape: 'box', pos: [0, 5, 0], size: [10, 5, 10], strength: 1 });
      const wood = preset('wood');
      const e = c.sphere([0, 4, 0], 0.5, wood);
      c.S.step(1);
      c.place(e, [0, 4, 0]);
      c.S.step(1);
      const rs = wood.density / 1000;
      return { measured: e.body.linvel().y / DT, expected: (G * (1 - rs)) / (rs + 0.5), unit: 'm/s²', detail: 'initial upward acceleration — buoyancy fights the ball’s mass PLUS the water it must shove aside' };
    },
  },
  {
    id: 'sink-terminal', group: 'Fluids', name: 'Steel pellet terminal speed in water', law: '(ρs−ρf)gV = ½ρf·Cd(Re)·A·v²', tolPct: 4,
    run: (c) => {
      c.field({ kind: 'fluid', shape: 'box', pos: [0, 10, 0], size: [10, 10, 10], strength: 1 });
      const steel = preset('steel'), R = 0.02;
      const e = c.sphere([0, 19.5, 0], R, steel);
      c.S.step(1); c.place(e, [0, 19.5, 0]);
      c.S.step(90);
      return { measured: -e.body.linvel().y, expected: terminalSphere(steel.density, 1000, 0.001, R), unit: 'm/s', detail: '4 cm steel ball after 1.5 s — vs the measured sphere drag curve' };
    },
  },
  {
    id: 'honey-settle', group: 'Fluids', name: 'Steel pellet sinking through honey', law: 'Stokes regime: v ≈ 2Δρ·g·R²/9μ (drag curve)', tolPct: 5,
    run: (c) => {
      c.field({ kind: 'fluid', shape: 'box', pos: [0, 5, 0], size: [10, 5, 10], strength: 1.42, fluid: { preset: 'honey', viscosity: 10, waves: 0, wavelength: 8, current: 0 } });
      const steel = preset('steel'), R = 0.02;
      const e = c.sphere([0, 9, 0], R, steel);
      c.S.step(1); c.place(e, [0, 9, 0]);
      c.S.step(60);
      return { measured: -e.body.linvel().y, expected: terminalSphere(steel.density, 1420, 10, R), unit: 'm/s', detail: `Re ≈ ${((1420 * 0.5 * 0.04) / 10).toFixed(1)} — viscosity, not inertia, sets the speed` };
    },
  },
  {
    id: 'float-ice-flat', group: 'Fluids', name: 'Ice cube floats flat', law: 'stable upright when ρ > 0.79 ρf', tolPct: 0,
    run: (c) => {
      c.field({ kind: 'fluid', shape: 'box', pos: [0, 5, 0], size: [10, 5, 10], strength: 1 });
      const q = new THREE.Quaternion().setFromAxisAngle(c.V(1, 0, 0), 10 * deg);
      const e = c.box([0, 9.5, 0], 0.5, preset('ice'), [0, 0, 0], q);
      c.S.step(900);
      return { measured: tiltDeg(e), expected: 0, absTol: 3, unit: '°', detail: 'released tilted 10°; a dense floater rights itself (metacentre above centre of mass)' };
    },
  },
  {
    id: 'float-wood-tilt', group: 'Fluids', name: 'Wood cube does NOT float flat', law: 'flat is unstable for 0.21 < ρ/ρf < 0.79', tolPct: 0,
    run: (c) => {
      c.field({ kind: 'fluid', shape: 'box', pos: [0, 5, 0], size: [10, 5, 10], strength: 1 });
      const q = new THREE.Quaternion().setFromAxisAngle(c.V(1, 0, 0), 4 * deg);
      const e = c.box([0, 9.6, 0], 0.5, preset('wood'), [0, 0, 0], q);
      c.S.step(900);
      const tilt = tiltDeg(e);
      return { measured: tilt, expected: 45, absTol: 25, unit: '°', detail: `released 4° off flat → settled at ${tilt.toFixed(1)}° (a ρ = 0.6 cube rolls onto an edge/corner — real metacentric instability)` };
    },
  },
  {
    id: 'wave-period', group: 'Fluids', name: 'Buoy bobbing on waves', law: 'deep water: T = √(2πλ/g)', tolPct: 3,
    run: (c) => {
      const lambda = 10;
      c.field({ kind: 'fluid', shape: 'box', pos: [0, 5, 0], size: [30, 5, 30], strength: 1, fluid: { preset: 'sea', viscosity: 0.001, waves: 0.25, wavelength: lambda, current: 0 } });
      const e = c.sphere([0, 9.9, 0], 0.3, preset('wood'));
      c.S.step(300);
      const ys: number[] = [];
      let mean = 0;
      for (let i = 0; i < 900; i++) { c.S.step(); ys.push(e.body.translation().y); }
      for (const y of ys) mean += y / ys.length;
      return { measured: periodOf(ys.map((y) => y - mean)), expected: Math.sqrt((2 * Math.PI * lambda) / G), unit: 's', detail: `λ = ${lambda} m, amplitude 0.25 m — the float rides the swell at the wave's own period` };
    },
  },
  {
    id: 'current-drift', group: 'Fluids', name: 'Neutral ball swept along by a current', law: '(m+½ρV)·dv/dt = ½ρ·Cd(Re)·A·(u−v)²', tolPct: 3,
    run: (c) => {
      const u = 1.5, R = 0.4, rho = 1000;
      c.field({ kind: 'fluid', shape: 'box', pos: [0, 5, 0], size: [40, 5, 40], strength: 1, fluid: { preset: 'water', viscosity: 0.001, waves: 0, wavelength: 8, current: u } });
      const e = c.sphere([-20, 5, 0], R, c.mat({ density: rho }));
      c.S.step(1); c.place(e, [-20, 5, 0]);
      c.S.step(600);
      // reference: integrate the real sphere drag curve (with added mass) finely over the same 10 s
      const V = (4 / 3) * Math.PI * R ** 3, A = Math.PI * R * R, mEff = 1.5 * rho * V;
      let v = 0;
      for (let i = 0; i < 10000; i++) {
        const w = u - v;
        v += (0.001 * 0.5 * rho * A * cdSphere(Math.max((rho * Math.abs(w) * 2 * R) / 0.001, 1e-9)) * w * Math.abs(w)) / mEff;
      }
      return { measured: e.body.linvel().x, expected: v, unit: 'm/s', detail: 'water-density ball after 10 s in a 1.5 m/s current — a float closes the gap to its current only hyperbolically' };
    },
  },
  // ------------------------------------------------------------------ air
  {
    id: 'air-terminal', group: 'Air', name: 'Foam ball terminal velocity', law: 'v = √(2mg / ρ·Cd·A), Cd ≈ 0.47', tolPct: 4,
    run: (c) => {
      c.S.setAirResistance(true);
      const foam = preset('foam'), R = 0.5;
      const e = c.sphere([0, 600, 0], R, foam);
      c.S.step(600);
      const m = (foam.density - 1.225) * (4 / 3) * Math.PI * R ** 3; // net of the air's own buoyancy
      return { measured: -e.body.linvel().y, expected: Math.sqrt((2 * m * G) / (1.225 * 0.47 * Math.PI * R * R)), unit: 'm/s', detail: '1 m expanded-polystyrene ball (30 kg/m³) after 10 s of fall' };
    },
  },
  {
    id: 'air-cube-drag', group: 'Air', name: 'Wind force on a cube', law: 'F = ½·ρ·1.05·A·u² (cube Cd)', tolPct: 5,
    run: (c) => {
      c.S.setGravityY(0);
      c.S.fieldModel = 'realistic';
      c.field({ kind: 'wind', shape: 'box', pos: [0, 20, 0], size: [30, 30, 30], strength: 20 });
      const foam = preset('foam');
      const e = c.box([0, 20, 0], 0.5, foam);
      c.S.step(1); c.place(e, [0, 20, 0]);
      c.S.step(1);
      const m = (foam.density / 1000);
      return { measured: e.body.linvel().x / DT, expected: (0.5 * 1.225e-3 * 1.05 * 1 * 400) / m, unit: 'm/s²', detail: 'realistic model: a 20 m/s wind on a face-on 1 m foam cube (initial acceleration)' };
    },
  },
  {
    id: 'air-heavy-light', group: 'Air', name: 'Gale moves foam, not steel', law: 'a = F/m — same wind, 260× the mass', tolPct: 2,
    run: (c) => {
      c.S.setGravityY(0);
      c.S.fieldModel = 'realistic';
      c.field({ kind: 'wind', shape: 'box', pos: [0, 20, 0], size: [30, 30, 30], strength: 25 });
      const f = c.box([0, 20, -3], 0.5, preset('foam'));
      const s = c.box([0, 20, 3], 0.5, preset('steel'));
      c.S.step(1); c.place(f, [0, 20, -3]); c.place(s, [0, 20, 3]);
      c.S.step(1);
      return { measured: f.body.linvel().x / Math.max(s.body.linvel().x, 1e-12), expected: 7800 / 30, unit: '×', detail: `25 m/s gale: foam cube picks up ${(f.body.linvel().x / DT).toFixed(1)} m/s², steel ${(s.body.linvel().x / DT).toFixed(3)} m/s² — same force, acceleration ∝ 1/mass` };
    },
  },
  {
    id: 'magnus', group: 'Air', name: 'Spinning ball curves (Magnus)', law: 'F = ½·ρ·A·C_L·v², C_L ≈ Rω/v', tolPct: 10,
    run: (c) => {
      c.S.setGravityY(0);
      c.S.setAirResistance(true);
      const foam = preset('foam'), R = 0.5, v = 15, w = 6;
      const e = c.sphere([0, 50, 0], R, foam);
      c.S.step(1);
      c.place(e, [0, 50, 0], [v, 0, 0], undefined, [0, w, 0]);
      c.S.step(1);
      const m = (foam.density / 1000) * (4 / 3) * Math.PI * R ** 3;
      const CL = Math.min(0.35, (R * w) / v);
      // ω = +y, v = +x → lift along ω × v = −z
      return { measured: -e.body.linvel().z / DT, expected: (0.5 * 1.225e-3 * Math.PI * R * R * CL * v * v) / m, unit: 'm/s²', detail: 'topspin-free sidespin at 6 rad/s on a 15 m/s foam ball — sideways acceleration' };
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
      return { measured: e.body.linvel().x, expected: 8 * (1 - Math.exp(-5)), unit: 'm/s', detail: 'velocity-target steering v = u(1 − e^(−5t)) after 1 s — the arcade semantics' };
    },
  },
  {
    id: 'floor-region', group: 'Fields', name: 'A region standing on the floor acts at the floor', law: 'no soft-edge fade at the ground face', tolPct: 2,
    run: (c) => {
      c.S.setGravityY(0);
      c.field({ kind: 'wind', shape: 'box', pos: [0, 5, 0], size: [20, 5, 20], strength: 8 });
      const e = c.sphere([-5, 0.6, 0], 0.4, c.mat({}));
      c.S.step(30);
      return { measured: e.body.linvel().x, expected: 8 * (1 - Math.exp(-2.5)), unit: 'm/s', detail: 'ball 0.6 m above the floor inside a wind box whose bottom face IS the floor, after 0.5 s (it used to feel ~5%)' };
    },
  },
  {
    id: 'wind-gusts', group: 'Fields', name: 'Gusty wind statistics', law: 'mean ≈ set speed, gust factor 1.3–1.6', tolPct: 0,
    run: (c) => {
      const rec = c.field({ kind: 'wind', shape: 'box', pos: [0, 10, 0], size: [60, 20, 60], strength: 12, gust: 0.6 });
      const u = c.V(), p = c.V();
      // a fixed anemometer: 3-s gust (peak of 3-s means) over a 10-min record, like met stations report
      const samples: number[] = [];
      for (let i = 0; i < 600 * 10; i++) { flowVelocity(rec.field, p.set(5, 8, -3), 1, u, i * 0.1); samples.push(u.length()); }
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      let peak3 = 0;
      for (let i = 30; i < samples.length; i++) { let s = 0; for (let j = i - 30; j < i; j++) s += samples[j]; peak3 = Math.max(peak3, s / 30); }
      return { measured: peak3 / mean, expected: 1.45, absTol: 0.2, unit: '×', detail: `10-min mean ${mean.toFixed(2)} m/s (set 12) · 3-s peak ${peak3.toFixed(1)} m/s at gustiness 0.6` };
    },
  },
  {
    id: 'charge-radius', group: 'Fields', name: 'Double charge → half the circle', law: 'r = m·v / (q·B)', tolPct: 2,
    run: (c) => {
      c.S.setGravityY(0);
      c.field({ kind: 'magnetic', pos: [0, 10, 0], size: [40, 40, 40], strength: 2 });
      const e = c.sphere([1.25, 10, 0], 0.2, c.mat({}), [0, 0, 5]);
      c.S.setEntityCharge(e, 2);
      let sum = 0;
      for (let i = 0; i < 94; i++) { c.S.step(); const t = e.body.translation(); sum += Math.hypot(t.x, t.z); }
      return { measured: sum / 94, expected: 5 / (2 * 2), unit: 'm', detail: 'q/m = 2 at 5 m/s in a turn-rate-2 field — mean distance from the centre over one loop' };
    },
  },
  {
    id: 'charge-neutral', group: 'Fields', name: 'Neutral matter ignores a magnetic field (Realistic)', law: 'F = q·v×B, q = 0', tolPct: 0,
    run: (c) => {
      c.S.setGravityY(0);
      c.S.fieldModel = 'realistic';
      c.field({ kind: 'magnetic', pos: [0, 10, 0], size: [40, 40, 40], strength: 4 });
      const e = c.sphere([0, 10, 0], 0.3, c.mat({}), [0, 0, 5]);
      c.S.step(60);
      return { measured: Math.abs(e.body.linvel().x), expected: 0, absTol: 1e-6, unit: 'm/s', detail: 'uncharged ball keeps a straight line through B' };
    },
  },
  {
    id: 'magnet-falloff', group: 'Fields', name: 'Magnet pull falls off steeply', law: 'F ∝ ∇(B²) → 1/r⁷ (softened dipole)', tolPct: 3,
    run: (c) => {
      c.S.setGravityY(0);
      c.field({ kind: 'magnet', pos: [0, 20, 0], size: [8, 8, 8], strength: 8 });
      const steel = preset('steel');
      const near = c.sphere([0, 18, 0], 0.15, steel);
      const far = c.sphere([0, 17, 4], 0.15, steel); // 3 m below the pole, offset sideways → use its axial distance
      c.S.step(1); c.place(near, [0, 18, 0]); c.place(far, [0, 17, 0.0001]);
      c.S.step(1);
      // on-axis |B|² of the softened dipole: ((2r² − s²)/(r² + s²)^2.5)² — pull ∝ its slope
      const b2 = (r: number) => ((2 * r * r - 0.25) / (r * r + 0.25) ** 2.5) ** 2;
      const slope = (r: number) => (b2(r + 1e-4) - b2(r - 1e-4)) / 2e-4;
      const expect = slope(2) / slope(3);
      return { measured: near.body.linvel().y / far.body.linvel().y, expected: expect, unit: '×', detail: `pull at 2 m vs 3 m below the pole — a pure dipole far-field would give ${((3 / 2) ** 7).toFixed(1)}×` };
    },
  },
  {
    id: 'magnet-wood', group: 'Fields', name: 'Magnet ignores wood', law: 'χ_wood ≈ 0', tolPct: 0,
    run: (c) => {
      c.S.setGravityY(0);
      c.field({ kind: 'magnet', pos: [0, 20, 0], size: [8, 8, 8], strength: 8 });
      const e = c.sphere([0, 18.8, 0], 0.3, preset('wood'));
      c.S.step(30);
      const v = e.body.linvel();
      return { measured: Math.hypot(v.x, v.y, v.z), expected: 0, absTol: 1e-9, unit: 'm/s', detail: 'wood ball 1.2 m under a strength-8 magnet' };
    },
  },
  {
    id: 'blast-scaling', group: 'Fields', name: 'Blast scaling (Hopkinson–Cranz)', law: 'same R/W^⅓ → impulse ∝ W^⅓', tolPct: 3,
    run: (c) => {
      c.S.setGravityY(0);
      c.S.fieldModel = 'realistic';
      const foam = preset('foam');
      const shot = (R: number, W: number) => {
        c.S.resetForLab(); c.S.setGravityY(0); c.S.fieldModel = 'realistic';
        const e = c.sphere([R, 30, 0], 0.5, foam);
        c.S.step(1); c.place(e, [R, 30, 0]);
        c.blast([0, 30, 0], 40, W);
        return e.body.linvel().x;
      };
      const v1 = shot(4, 1), v2 = shot(8, 8);
      return { measured: v2 / v1, expected: 2, unit: '×', detail: `1 kg TNT at 4 m → ${v1.toFixed(2)} m/s; 8 kg at 8 m → ${v2.toFixed(2)} m/s (same scaled distance)` };
    },
  },
  {
    id: 'blast-mass', group: 'Fields', name: 'Blast throws foam, not steel', law: 'Δv = impulse / m', tolPct: 3,
    run: (c) => {
      c.S.setGravityY(0);
      c.S.fieldModel = 'realistic';
      const f = c.sphere([5, 30, 0], 0.5, preset('foam'));
      const s = c.sphere([-5, 30, 0], 0.5, preset('steel'));
      c.S.step(1); c.place(f, [5, 30, 0]); c.place(s, [-5, 30, 0]);
      c.blast([0, 30, 0], 40, 5);
      return { measured: f.body.linvel().x / -s.body.linvel().x, expected: 7800 / 30, unit: '×', detail: `5 kg TNT at 5 m: foam ${f.body.linvel().x.toFixed(2)} m/s, steel ${(-s.body.linvel().x).toFixed(4)} m/s` };
    },
  },
  {
    id: 'blast-shield', group: 'Fields', name: 'A wall shelters from a blast', law: 'blocked line of sight → diffracted ~15%', tolPct: 0,
    run: (c) => {
      c.S.setGravityY(0);
      c.S.fieldModel = 'realistic';
      const foam = preset('foam');
      const open = c.sphere([5, 30, 0], 0.5, foam);
      const hid = c.sphere([0, 30, 5], 0.5, foam);
      c.fixedCuboid([0, 30, 2.5], [1.5, 1.5, 0.2], new THREE.Quaternion(), 0.5);
      c.S.step(1); c.place(open, [5, 30, 0]); c.place(hid, [0, 30, 5]);
      c.blast([0, 30, 0], 40, 5);
      return { measured: hid.body.linvel().z / open.body.linvel().x, expected: 0.15, absTol: 0.02, unit: '×', detail: 'two foam balls 5 m from the charge — one behind a wall' };
    },
  },
  {
    id: 'carried-momentum', group: 'Conservation', name: 'Carried gravity well conserves momentum (Realistic)', law: 'action = reaction', tolPct: 0,
    run: (c) => {
      c.S.setGravityY(0);
      c.S.fieldModel = 'realistic';
      const star = c.sphere([0, 20, 0], 0.5, preset('steel'));
      const moon = c.sphere([6, 20, 0], 0.4, c.mat({}));
      const well = c.field({ kind: 'gravitywell', pos: [0, 20, 0], size: [30, 30, 30], strength: 8 });
      c.S.attachField(well, star);
      c.S.step(1); c.place(star, [0, 20, 0]); c.place(moon, [6, 20, 0]);
      c.S.step(30); // before they meet (~0.85 s)
      const ms = star.body.mass(), mm = moon.body.mass();
      const vs = star.body.linvel(), vm = moon.body.linvel();
      const P = Math.hypot(ms * vs.x + mm * vm.x, ms * vs.y + mm * vm.y, ms * vs.z + mm * vm.z);
      const scale = mm * Math.hypot(vm.x, vm.y, vm.z) || 1;
      return { measured: P / scale, expected: 0, absTol: 0.01, unit: '×|p_moon|', detail: `after 0.5 s the moon falls in at ${Math.hypot(vm.x, vm.y, vm.z).toFixed(2)} m/s and the star recoils — total momentum stays ~0` };
    },
  },
  {
    id: 'carried-follows', group: 'Conservation', name: 'A carried field rides its object', law: 'field pose = carrier pose', tolPct: 0,
    run: (c) => {
      c.S.setGravityY(0);
      const cart = c.box([0, 10, 0], 0.5, c.mat({}), [3, 0, 0], undefined);
      const fan = c.field({ kind: 'wind', shape: 'box', pos: [0, 10, 0], size: [4, 2, 2], strength: 5 });
      c.S.attachField(fan, cart);
      c.S.step(1); c.place(cart, [0, 10, 0], [3, 0, 0], undefined, [0, 1, 0]);
      c.S.step(90);
      const t = cart.body.translation();
      c.S.step(1); // the field adopts the pose at the start of each step
      return { measured: fan.field.pos.distanceTo(c.V(t.x, t.y, t.z)), expected: 0, absTol: 0.01, unit: 'm', detail: 'a wind field mounted on a moving, spinning cart after 1.5 s' };
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
