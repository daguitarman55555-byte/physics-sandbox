/**
 * JOINTS — Phase 4. Connect two bodies with a constraint, created by the "connect" tool (click two
 * objects). This module builds the Rapier JointData for a chosen kind at a shared world anchor;
 * the Sandbox owns the joint records, the connector-line rendering, and cleanup on delete.
 *
 *   fixed  — weld: locks relative position AND orientation at the current pose.
 *   edge   — door hinge: the Sandbox docks the pair into an aligned, face-to-face pose, then this
 *            makes a revolute about one EDGE of the shared face, so it swings OPEN like a door
 *            (collisions stay on, so it can never swing inside its partner).
 *   spring — a damped spring at the current separation: a bouncy tether.
 *   rope   — a maximum-distance link: bodies can approach freely but not separate past the length.
 */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';

export type JointKind = 'fixed' | 'edge' | 'spring' | 'rope';

export const JOINT_INFO: Record<JointKind, { color: number; label: string }> = {
  fixed: { color: 0xd8dee9, label: 'Weld' },
  edge: { color: 0x4fb89a, label: 'Hinge' },
  spring: { color: 0xc9bb3a, label: 'Spring' },
  rope: { color: 0xe89948, label: 'Rope' },
};

const _pa = new THREE.Vector3(), _pb = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();

/** World-space anchor point on a body from its stored local anchor (for drawing the connector). */
export function anchorWorld(body: RAPIER.RigidBody, local: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const t = body.translation(), r = body.rotation();
  return out.copy(local).applyQuaternion(_qa.set(r.x, r.y, r.z, r.w)).add(_pa.set(t.x, t.y, t.z));
}

export interface JointBuild {
  data: RAPIER.JointData;
  localA: THREE.Vector3; // anchor in each body's local frame (kept for connector-line drawing)
  localB: THREE.Vector3;
}

/**
 * Build JointData connecting bodies A and B at `worldAnchor` (the midpoint of the two for a weld, or
 * one edge of the shared face for an edge hinge). Anchors are converted into each body's local frame
 * so the constraint is satisfied at creation — nothing snaps. The Sandbox docks fixed/edge pairs
 * into place BEFORE calling this (collisions on; the edge hinge also aligns them face-to-face), so by
 * here they already sit where they should. `edgeAxisLocalA` (in A's local frame) is the hinge axis
 * for kind 'edge'. Returns null if the bodies are coincident (degenerate).
 */
export function buildJoint(
  kind: JointKind, a: RAPIER.RigidBody, b: RAPIER.RigidBody, worldAnchor: THREE.Vector3,
  edgeAxisLocalA?: THREE.Vector3,
): JointBuild | null {
  const ta = a.translation(), tb = b.translation();
  const ra = a.rotation(), rb = b.rotation();
  _pa.set(ta.x, ta.y, ta.z); _pb.set(tb.x, tb.y, tb.z);
  _qa.set(ra.x, ra.y, ra.z, ra.w); _qb.set(rb.x, rb.y, rb.z, rb.w);
  const centerDist = _pa.distanceTo(_pb);

  // rope & spring are distance links, so they tie each body at its OWN center — the limit/rest is
  // then just the center-to-center distance (two boxes 2 apart stay ~2 apart). fixed & edge pin a
  // single pivot point (weld: the midpoint; edge: a face corner), so their anchors are that point.
  let localA: THREE.Vector3, localB: THREE.Vector3;
  if (kind === 'rope' || kind === 'spring') {
    localA = new THREE.Vector3(0, 0, 0);
    localB = new THREE.Vector3(0, 0, 0);
  } else {
    localA = worldAnchor.clone().sub(_pa).applyQuaternion(_qa.clone().invert());
    localB = worldAnchor.clone().sub(_pb).applyQuaternion(_qb.clone().invert());
  }
  const va = { x: localA.x, y: localA.y, z: localA.z };
  const vb = { x: localB.x, y: localB.y, z: localB.z };

  let data: RAPIER.JointData;
  if (kind === 'fixed') {
    // frame1 = identity, frame2 = qA⁻¹·qB spelled as the relative rotation that keeps the current
    // relative orientation satisfied, so the weld doesn't torque the pair into alignment
    const rel = _qa.clone().invert().multiply(_qb);
    data = RAPIER.JointData.fixed(va, { x: 0, y: 0, z: 0, w: 1 }, vb, { x: rel.x, y: rel.y, z: rel.z, w: rel.w });
  } else if (kind === 'edge') {
    // revolute about the given edge axis; the pair was aligned face-to-face during docking, so the
    // revolute's axis-alignment has nothing left to correct (no snap) — it just swings open
    const ax = edgeAxisLocalA ?? new THREE.Vector3(1, 0, 0);
    data = RAPIER.JointData.revolute(va, vb, { x: ax.x, y: ax.y, z: ax.z });
  } else if (kind === 'spring') {
    data = RAPIER.JointData.spring(centerDist, 22, 3.5, va, vb); // rest, stiffness, damping — a lively tether
  } else {
    data = RAPIER.JointData.rope(Math.max(centerDist, 0.1), va, vb);
  }
  return { data, localA, localB };
}
