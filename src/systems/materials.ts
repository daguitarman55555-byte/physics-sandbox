/**
 * MATERIALS SYSTEM — Phase 3 + the material-composer extension. NOT YET IMPLEMENTED.
 *
 * A material is data: appearance (color + PBR texture maps you upload) and physics (density,
 * friction, restitution). Density × the shape's exact volume (Module M) → mass + inertia.
 *
 * Composer (see the "Extensions" design doc §1, §8):
 *   - element database (periodic table: density, color, crystal structure)
 *   - compound builder (formula → looked-up or derived properties)
 *   - mixtures / alloys (weighted blend; density by rule of mixtures; famous alloys special-cased)
 * Honest limit: linear blending is a believable MODEL, not materials science (real alloys are
 * non-linear). Density is essentially exact; deeper properties come from a table or an ML model.
 */
export interface Material {
  id: string;
  name: string;
  density: number; // kg/m^3 (÷1000 in sim units)
  friction: number;
  restitution: number;
  color: string;
  maps?: { albedo?: string; normal?: string; roughness?: string; metalness?: string };
}

export const PRESETS: Material[] = [
  { id: 'rubber', name: 'Rubber', density: 1100, friction: 0.9, restitution: 0.8, color: '#d94f4f' },
  { id: 'steel', name: 'Steel', density: 7800, friction: 0.4, restitution: 0.2, color: '#9aa4b6' },
  { id: 'ice', name: 'Ice', density: 900, friction: 0.05, restitution: 0.1, color: '#bfe3ff' },
  { id: 'wood', name: 'Wood', density: 600, friction: 0.5, restitution: 0.4, color: '#b98a52' },
];

export const TODO = 'Phase 3 — see src/systems/README.md';
