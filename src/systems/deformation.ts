/**
 * DEFORMATION SYSTEM — Phase 6, the flagged priority (where physics-lab failed). NOT YET IMPLEMENTED.
 *
 * WHY physics-lab failed: Rapier — and every mainstream engine — is a RIGID-body engine. A rigid
 * body is "shape + position + rotation" with no internal surface, so it cannot deform. Deformation
 * is a SEPARATE simulation running alongside Rapier, not a toggle on a rigid body.
 *
 * The workhorse is XPBD (Extended Position-Based Dynamics): the object becomes particles linked by
 * distance + volume + shape-matching constraints; each step you nudge particle POSITIONS to satisfy
 * them over a few iterations, then derive velocity from the position change. Compliance makes
 * stiffness stable and timestep-independent (what naive mass-springs get wrong and explode on).
 *
 * This is the same shape as the NGS position solver from the Python engine's Phase 8 — you already
 * think in this idiom. Ship the tiers in order:
 *   1. resize / morph tool (non-physical, easy)   2. elastic soft body (XPBD)
 *   3. plastic (dents that stay)                   4. fracture (P6)     5. FEM (heaviest)
 *
 * Prototype ONE pokeable squishy cube in isolation before integrating. Soft particles collide with
 * Rapier colliders both ways; the visible mesh is skinned to the particle cage.
 */
export const TODO = 'Phase 6 — highest effort; prototype a single squishy cube first. See docs/FEATURES.md.';
