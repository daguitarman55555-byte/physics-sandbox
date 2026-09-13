/**
 * MEDIA — what liquids and air do to a body: buoyancy, pressure drag, skin friction, viscosity, added
 * mass, and (for spinning round bodies) Magnus lift. Pure math over a body's state; the Sandbox feeds
 * it each step and applies the resulting force + torque.
 *
 * Why this exists: a single "centre point" force can't twist anything. Real water rights a boat because
 * the buoyancy on its low side beats the high side; real wind spins a windmill because the pressure on
 * its blades is off-centre. So forces are evaluated at MANY points on the body and summed as force +
 * torque:
 *   - round bodies (spheres, accreted planets): exact spherical-cap submerged volume (buoyancy acts on
 *     the vertical through the centre — no torque, as in reality), sphere drag from the Clift–Gauvin
 *     correlation Cd(Re) (exact Stokes 6πμRv at low Reynolds number, ~0.42 at high), Magnus lift, and
 *     viscous/turbulent spin damping.
 *   - everything else: its bounding box split into 3×3×3 buoyancy cells (each with its own submerged
 *     fraction → righting torque), and six faces with a flat-plate pressure model (windward Cp 0.8,
 *     leeward base suction 0.25 → a face-on cube's Cd 1.05; skin friction Cf 0.02 tangentially).
 * Units follow the sim: density in water-units (t/m³), viscosity in kPa·s (= Pa·s ÷ 1000), forces kN.
 */
import * as THREE from 'three';
import type { Field } from './fields';

export const RHO_AIR = 1.225e-3; // sea-level air, t/m³
export const MU_AIR = 1.81e-8; // air viscosity 1.81e-5 Pa·s → kPa·s
export const C_ADDED = 0.5; // added-mass coefficient (exact for a sphere; a fair average for compact bodies)
// flat-plate face model: a face-on cube's pressure drag 0.8 + 0.25 = 1.05 (the measured cube Cd), plus
// turbulent skin friction Cf ≈ 0.005 on the faces the flow slides along
const CP_WIND = 0.8, CP_LEE = 0.25, CF_SKIN = 0.005;
const CELLS = 3; // buoyancy cells per axis for non-round bodies

/** A liquid's physical character. `density` lives in the field's `strength` (water-units). */
export interface FluidProps {
  preset: string;
  viscosity: number; // Pa·s (real units) — water 0.001, honey ~10
  waves: number; // wave amplitude (m); 0 = flat
  wavelength: number; // m
  current: number; // m/s along the tank's local +X
}

export const FLUID_PRESETS: Record<string, { label: string; density: number; viscosity: number; color: number }> = {
  water: { label: 'Water', density: 1.0, viscosity: 0.001, color: 0x2a7fce },
  sea: { label: 'Sea water', density: 1.025, viscosity: 0.00108, color: 0x1f6a9a },
  oil: { label: 'Oil', density: 0.92, viscosity: 0.08, color: 0xb59a2a },
  honey: { label: 'Honey', density: 1.42, viscosity: 10, color: 0xd08a1e },
  mercury: { label: 'Mercury', density: 13.53, viscosity: 0.0015, color: 0xb8bec8 },
};

export const defaultFluid = (): FluidProps => ({ preset: 'water', viscosity: 0.001, waves: 0, wavelength: 8, current: 0 });

/** How a body presents itself to a medium (cached per entity; rebuilt when its size changes). */
export interface MediumShape {
  round: boolean;
  R: number; // round: radius
  center: THREE.Vector3; // box-like: local bounding-box centre (relative to the centre of mass)
  half: THREE.Vector3; // box-like: local half extents
  areaK: number; // face-area scale so a non-box shape's frontal area matches its volume
  volume: number;
  sizeKey: number; // the entity size this was built for
}

export function buildMediumShape(round: boolean, size: number, bbCenter: THREE.Vector3, bbHalf: THREE.Vector3, volume: number): MediumShape {
  const bbVol = 8 * Math.max(bbHalf.x, 1e-3) * Math.max(bbHalf.y, 1e-3) * Math.max(bbHalf.z, 1e-3);
  return {
    round, R: size, center: bbCenter.clone(), half: bbHalf.clone(),
    areaK: round ? 1 : Math.min(1, Math.pow(Math.max(volume, 1e-6) / bbVol, 2 / 3)),
    volume, sizeKey: size,
  };
}

/** Per-step body state the Sandbox reads once and hands to every medium. */
export interface BodyState {
  pos: THREE.Vector3; quat: THREE.Quaternion; vel: THREE.Vector3; angvel: THREE.Vector3;
  mass: number; gravityY: number;
}

/** Accumulated medium effects for one body over one step. */
export class MediaOut {
  force = new THREE.Vector3();
  torque = new THREE.Vector3();
  buoyancy = new THREE.Vector3(); // subset of force, for the dev breakdown
  drag = new THREE.Vector3(); // subset of force, for the dev breakdown
  vSub = 0; // submerged volume (m³) across all liquids
  rhoSub = 0; // Σ ρ·Vsub (for added mass)
  reset() { this.force.set(0, 0, 0); this.torque.set(0, 0, 0); this.buoyancy.set(0, 0, 0); this.drag.set(0, 0, 0); this.vSub = 0; this.rhoSub = 0; }
}

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _n = new THREE.Vector3();
const _r = new THREE.Vector3(), _pv = new THREE.Vector3(), _w = new THREE.Vector3(), _f = new THREE.Vector3();
const _u = new THREE.Vector3(), _l = new THREE.Vector3(), _iq = new THREE.Quaternion(), _dir = new THREE.Vector3();
const _axes: THREE.Vector3[] = [_a, _b, _c];
const _hs = new Float64Array(3);

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Volume of a spherical cap of height h on a sphere of radius R. */
export const capVolume = (h: number, R: number) => { const x = Math.min(Math.max(h, 0), 2 * R); return (Math.PI * x * x * (3 * R - x)) / 3; };

// ---------------------------------------------------------------------------------------------- liquids

/** Water surface height at (x, z): the tank top, plus a travelling deep-water wave along local +X. */
export function surfaceAt(field: Field, x: number, z: number, t: number): number {
  const top = field.pos.y + (field.shape === 'sphere' ? field.size.x : field.size.y);
  const fl = field.fluid;
  if (!fl || fl.waves <= 0) return top;
  const k = (2 * Math.PI) / Math.max(fl.wavelength, 0.5);
  const omega = Math.sqrt(9.81 * k); // deep-water dispersion ω² = g·k
  _dir.set(1, 0, 0).applyQuaternion(field.quat); _dir.y = 0;
  const len = Math.hypot(_dir.x, _dir.z) || 1;
  const xi = ((x - field.pos.x) * _dir.x + (z - field.pos.z) * _dir.z) / len;
  return top + fl.waves * Math.cos(k * xi - omega * t);
}

/** Water velocity at p: the tank's current plus the Airy wave orbital velocity (decays e^(−k·depth)). */
export function waterVelocity(field: Field, p: THREE.Vector3, t: number, out: THREE.Vector3): THREE.Vector3 {
  out.set(0, 0, 0);
  const fl = field.fluid;
  if (!fl) return out;
  _dir.set(1, 0, 0).applyQuaternion(field.quat); _dir.y = 0;
  const len = Math.hypot(_dir.x, _dir.z) || 1;
  _dir.x /= len; _dir.z /= len;
  if (fl.current) out.set(_dir.x * fl.current, 0, _dir.z * fl.current);
  if (fl.waves > 0) {
    const k = (2 * Math.PI) / Math.max(fl.wavelength, 0.5);
    const omega = Math.sqrt(9.81 * k);
    const top = field.pos.y + (field.shape === 'sphere' ? field.size.x : field.size.y);
    const xi = (p.x - field.pos.x) * _dir.x + (p.z - field.pos.z) * _dir.z;
    const th = k * xi - omega * t;
    const amp = fl.waves * omega * Math.exp(-k * Math.max(0, top - p.y));
    out.x += _dir.x * amp * Math.cos(th);
    out.z += _dir.z * amp * Math.cos(th);
    out.y += amp * Math.sin(th);
  }
  return out;
}

/** Is a horizontal position inside the tank's footprint (in its own axes), padded by `pad`? */
function inFootprint(field: Field, x: number, z: number, pad: number): boolean {
  const sz = field.size;
  _l.set(x - field.pos.x, 0, z - field.pos.z);
  if (field.shape === 'sphere') return Math.hypot(_l.x, _l.z) < sz.x + pad;
  _l.applyQuaternion(_iq.copy(field.quat).invert());
  return field.shape === 'box' ? Math.abs(_l.x) < sz.x + pad && Math.abs(_l.z) < sz.z + pad : Math.hypot(_l.x, _l.z) < sz.x + pad;
}

function bottomAt(field: Field, x: number, z: number): number {
  if (field.shape !== 'sphere') return field.pos.y - field.size.y;
  const r = Math.min(Math.hypot(x - field.pos.x, z - field.pos.z), field.size.x);
  return field.pos.y - Math.sqrt(Math.max(0, field.size.x * field.size.x - r * r));
}

/**
 * Buoyancy + drag of one liquid region on a body. Adds into `out` (force at the centre of mass plus
 * torque about it). `density` is the liquid's density (water-units, strength × global gain).
 */
export function liquidForces(field: Field, shape: MediumShape, st: BodyState, density: number, t: number, out: MediaOut) {
  const g = -st.gravityY;
  const mu = (field.fluid?.viscosity ?? 0.001) / 1000;
  const p = st.pos;
  const reach = shape.round ? shape.R : Math.hypot(shape.half.x, shape.half.y, shape.half.z) + shape.center.length();
  if (!inFootprint(field, p.x, p.z, reach)) return;
  const top = field.pos.y + (field.shape === 'sphere' ? field.size.x : field.size.y) + (field.fluid?.waves ?? 0);
  if (p.y - reach > top) return; // wholly above the highest possible wave crest

  if (shape.round) {
    const R = shape.R;
    if (!inFootprint(field, p.x, p.z, 0)) return;
    const S = surfaceAt(field, p.x, p.z, t), B = bottomAt(field, p.x, p.z);
    const bottom = p.y - R;
    const vSub = Math.max(0, capVolume(S - bottom, R) - capVolume(B - bottom, R)) * (shape.volume / ((4 / 3) * Math.PI * R ** 3));
    if (vSub <= 0) return;
    const frac = vSub / shape.volume;
    const Fb = density * g * vSub; // Archimedes (on the vertical through the centre → no torque)
    out.force.y += Fb; out.buoyancy.y += Fb;
    out.vSub += vSub; out.rhoSub += density * vSub;
    waterVelocity(field, p, t, _u);
    sphereDrag(R, _u, st, density, mu, frac, out);
    if (frac < 0.999) {
      const d = Math.min(Math.abs(S - p.y), R);
      radiationDamping(Math.PI * (R * R - d * d), density, vSub, st, _u, out);
    }
    return;
  }

  // box-like: buoyancy cells (righting torque) + six drag faces
  const h = shape.half, c0 = shape.center, q = st.quat;
  // world-space local axes and each axis' vertical projection (the Y row of the rotation matrix)
  const ax = _a.set(1, 0, 0).applyQuaternion(q), ay = _b.set(0, 1, 0).applyQuaternion(q), az = _c.set(0, 0, 1).applyQuaternion(q);
  const cellH = (h.x * Math.abs(ax.y) + h.y * Math.abs(ay.y) + h.z * Math.abs(az.y)) / CELLS; // cell vertical half-extent
  const vCell = shape.volume / CELLS ** 3;
  let vSub = 0;
  for (let i = 0; i < CELLS; i++) for (let j = 0; j < CELLS; j++) for (let k = 0; k < CELLS; k++) {
    const lx = c0.x + h.x * ((2 * i + 1) / CELLS - 1), ly = c0.y + h.y * ((2 * j + 1) / CELLS - 1), lz = c0.z + h.z * ((2 * k + 1) / CELLS - 1);
    _r.set(ax.x * lx + ay.x * ly + az.x * lz, ax.y * lx + ay.y * ly + az.y * lz, ax.z * lx + ay.z * ly + az.z * lz);
    const cx = p.x + _r.x, cy = p.y + _r.y, cz = p.z + _r.z;
    if (!inFootprint(field, cx, cz, 0)) continue;
    const S = surfaceAt(field, cx, cz, t), B = bottomAt(field, cx, cz);
    const overlap = Math.min(cy + cellH, S) - Math.max(cy - cellH, B);
    if (overlap <= 0) continue;
    const sub = cellH > 1e-6 ? clamp01(overlap / (2 * cellH)) : 1;
    const Fb = density * g * vCell * sub;
    vSub += vCell * sub;
    out.force.y += Fb; out.buoyancy.y += Fb;
    out.torque.x += -_r.z * Fb; out.torque.z += _r.x * Fb; // r × (0, Fb, 0)
  }
  if (vSub <= 0) return;
  out.vSub += vSub; out.rhoSub += density * vSub;
  const frac = vSub / shape.volume;
  if (frac < 0.999) {
    // waterplane area ≈ the body's horizontal footprint (its projection onto the ground plane)
    const Awp = 4 * (h.y * h.z * Math.abs(ax.y) + h.x * h.z * Math.abs(ay.y) + h.x * h.y * Math.abs(az.y)) * shape.areaK;
    waterVelocity(field, p, t, _u);
    radiationDamping(Awp, density, vSub, st, _u, out);
  }
  facesDrag(shape, st, density, mu, frac, out, (pt, o) => waterVelocity(field, pt, t, o), (pt, hv) => {
    const S = surfaceAt(field, pt.x, pt.z, t), B = bottomAt(field, pt.x, pt.z);
    const ov = Math.min(pt.y + hv, S) - Math.max(pt.y - hv, B);
    return ov <= 0 ? 0 : hv > 1e-6 ? clamp01(ov / (2 * hv)) : 1;
  });
}

/**
 * WAVE-RADIATION damping for a body piercing the surface. A bobbing or rolling float makes waves that
 * carry energy away — the main reason real floats settle within a few cycles (quadratic drag is tiny at
 * bobbing speeds, so without this a floating block rang forever). Modelled as a damping ratio ζ on the
 * heave spring k = ρ·g·A_wp (and on roll/pitch, with the waterplane's own second moment ≈ A²/12).
 */
const RADIATION_ZETA = 0.2;
function radiationDamping(Awp: number, density: number, vSub: number, st: BodyState, u: THREE.Vector3, out: MediaOut) {
  if (Awp <= 1e-6) return;
  const g = -st.gravityY;
  const mEff = st.mass + C_ADDED * density * vSub;
  const k = density * g * Awp;
  const c = 2 * RADIATION_ZETA * Math.sqrt(k * mEff);
  const fy = -c * (st.vel.y - u.y);
  out.force.y += fy; out.drag.y += fy;
  // roll & pitch: k_rot = ρ·g·I_wp with I_wp ≈ A²/12, body inertia ≈ m_eff·A/6 → c_rot ≈ c·A/√72
  const cr = c * Awp / Math.sqrt(72);
  out.torque.x -= cr * st.angvel.x;
  out.torque.z -= cr * st.angvel.z;
}

// ---------------------------------------------------------------------------------------------- air

const stillAir = (_p: THREE.Vector3, o: THREE.Vector3) => { o.set(0, 0, 0); };

/** The air's own Archimedes lift on a body (kN) — 0.12% of a plain body's weight, 4% of foam's. */
export const airBuoyancy = (shape: MediumShape, gravityY: number) => RHO_AIR * -gravityY * shape.volume;

/** Below this relative speed² (m²/s²) still-air drag is negligible (< 10⁻⁵ g on foam) — skip the work. */
export const AIR_STILL_V2 = 0.01;

/**
 * Air on a body: drag against the local wind `flowAt` (still air when null), Magnus lift on spinning
 * round bodies, and the air's own (tiny) buoyancy. `weight` scales it (the dry fraction of a body
 * that's partly under water, or a flow field's influence when global air is off).
 */
export function airForces(shape: MediumShape, st: BodyState, weight: number, out: MediaOut,
  flowAt: ((p: THREE.Vector3, o: THREE.Vector3) => void) | null, buoyant = true) {
  if (weight <= 0) return;
  if (buoyant) { const Fb = airBuoyancy(shape, st.gravityY) * weight; out.force.y += Fb; out.buoyancy.y += Fb; }
  if (shape.round) {
    if (flowAt) flowAt(st.pos, _u); else _u.set(0, 0, 0);
    sphereDrag(shape.R, _u, st, RHO_AIR, MU_AIR, weight, out);
  } else {
    facesDrag(shape, st, RHO_AIR, MU_AIR, weight, out, flowAt ?? stillAir, () => weight);
  }
}

// ---------------------------------------------------------------------------------------------- drag models

/** Sphere in a medium with flow `u`: Clift–Gauvin drag, Magnus lift, spin damping — all × `frac`. */
function sphereDrag(R: number, u: THREE.Vector3, st: BodyState, rho: number, mu: number, frac: number, out: MediaOut) {
  _w.set(u.x - st.vel.x, u.y - st.vel.y, u.z - st.vel.z); // flow relative to the body
  const wm = _w.length();
  const A = Math.PI * R * R, D = 2 * R;
  if (wm > 1e-9) {
    const Re = (rho * wm * D) / mu;
    // Cd·|w| without dividing by |w| (keeps the Stokes limit finite): 24μ/(ρD)·(1+0.15Re^0.687) + 0.42|w|/(1+42500Re^-1.16)
    const cdw = ((24 * mu) / (rho * D)) * (1 + 0.15 * Math.pow(Re, 0.687)) + (0.42 * wm) / (1 + 42500 * Math.pow(Re, -1.16));
    const k = 0.5 * rho * A * cdw * frac;
    _f.set(_w.x * k, _w.y * k, _w.z * k);
    out.force.add(_f); out.drag.add(_f);
    // Magnus: lift ⊥ to the spin axis and the relative velocity; C_L ≈ spin ratio S = R|ω|/|v|, capped
    const om = st.angvel.length();
    if (om > 1e-6) {
      const CL = Math.min(0.35, (R * om) / wm);
      // v_rel = −w, so ω × v_rel = w × ω
      _n.crossVectors(_w, st.angvel).multiplyScalar((0.5 * rho * A * CL * wm * frac) / om);
      out.force.add(_n); out.drag.add(_n);
    }
  }
  // spin damping: Stokes rotational 8πμR³ω + a small turbulent term
  const om = st.angvel.length();
  if (om > 1e-9) {
    const kt = (8 * Math.PI * mu * R ** 3 + 0.02 * rho * R ** 5 * om) * frac;
    out.torque.x -= st.angvel.x * kt; out.torque.y -= st.angvel.y * kt; out.torque.z -= st.angvel.z * kt;
  }
}

/**
 * Six-face flat-plate model for box-like bodies. For each face: relative flow at the face centre (so
 * spin and off-centre wind produce torque), windward pressure / leeward suction on its normal
 * component, skin friction on the tangential part, × the face's immersed fraction. Plus a low-Reynolds
 * viscous term (Stokes drag of the equal-volume sphere) so syrupy liquids resist slow motion.
 */
function facesDrag(shape: MediumShape, st: BodyState, rho: number, mu: number, frac: number, out: MediaOut,
  flowAt: (p: THREE.Vector3, o: THREE.Vector3) => void, immersed: (p: THREE.Vector3, halfV: number) => number) {
  const h = shape.half, c0 = shape.center, q = st.quat;
  const ax = _a.set(1, 0, 0).applyQuaternion(q), ay = _b.set(0, 1, 0).applyQuaternion(q), az = _c.set(0, 0, 1).applyQuaternion(q);
  _axes[0] = ax; _axes[1] = ay; _axes[2] = az;
  _hs[0] = h.x; _hs[1] = h.y; _hs[2] = h.z;
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, c = (a + 2) % 3;
    const area = 4 * _hs[b] * _hs[c] * shape.areaK;
    const halfV = _hs[b] * Math.abs(_axes[b].y) + _hs[c] * Math.abs(_axes[c].y); // face's vertical half-extent
    for (let s = 0; s < 2; s++) {
      const sgn = s === 0 ? 1 : -1;
      const hs = _hs;
      _n.copy(_axes[a]).multiplyScalar(sgn);
      // face centre offset from the centre of mass (world)
      _r.set(
        ax.x * c0.x + ay.x * c0.y + az.x * c0.z + _n.x * hs[a],
        ax.y * c0.x + ay.y * c0.y + az.y * c0.z + _n.y * hs[a],
        ax.z * c0.x + ay.z * c0.y + az.z * c0.z + _n.z * hs[a],
      );
      _pv.set(st.pos.x + _r.x, st.pos.y + _r.y, st.pos.z + _r.z);
      const imm = immersed(_pv, halfV);
      if (imm <= 0) continue;
      flowAt(_pv, _u);
      // relative flow at the face = flow − (v + ω × r)
      _w.set(
        _u.x - (st.vel.x + st.angvel.y * _r.z - st.angvel.z * _r.y),
        _u.y - (st.vel.y + st.angvel.z * _r.x - st.angvel.x * _r.z),
        _u.z - (st.vel.z + st.angvel.x * _r.y - st.angvel.y * _r.x),
      );
      const wn = _w.dot(_n);
      const kA = 0.5 * rho * area * imm;
      // windward face (flow into it): pressure pushes along −n; leeward: base suction pulls along +n.
      // Both oppose the relative motion and are ∝ (normal flow)².
      const pn = wn < 0 ? -CP_WIND * wn * wn : CP_LEE * wn * wn;
      _f.copy(_n).multiplyScalar(kA * pn);
      // skin friction along the tangential flow
      const tx = _w.x - _n.x * wn, ty = _w.y - _n.y * wn, tz = _w.z - _n.z * wn;
      const tm = Math.hypot(tx, ty, tz);
      _f.x += kA * CF_SKIN * tm * tx; _f.y += kA * CF_SKIN * tm * ty; _f.z += kA * CF_SKIN * tm * tz;
      out.force.add(_f); out.drag.add(_f);
      out.torque.x += _r.y * _f.z - _r.z * _f.y;
      out.torque.y += _r.z * _f.x - _r.x * _f.z;
      out.torque.z += _r.x * _f.y - _r.y * _f.x;
    }
  }
  // low-Reynolds viscous resistance of the equal-volume sphere (dominates in honey, negligible in air)
  const Req = Math.cbrt((3 * shape.volume) / (4 * Math.PI));
  flowAt(st.pos, _u);
  const kv = 6 * Math.PI * mu * Req * frac;
  _f.set((_u.x - st.vel.x) * kv, (_u.y - st.vel.y) * kv, (_u.z - st.vel.z) * kv);
  out.force.add(_f); out.drag.add(_f);
  const kr = 8 * Math.PI * mu * Req ** 3 * frac;
  out.torque.x -= st.angvel.x * kr; out.torque.y -= st.angvel.y * kr; out.torque.z -= st.angvel.z * kr;
}
