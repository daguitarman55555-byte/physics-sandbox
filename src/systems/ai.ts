/**
 * AI SCENARIO BUILDER — portable, model-agnostic. NOT YET IMPLEMENTED.
 *
 * Smarter than calling one AI's API: move the instructions, not the service.
 *   1. exportPrompt() copies a self-contained brief (instructions + the scene JSON schema + examples).
 *   2. The user pastes it into ANY chatbot (free ChatGPT / Claude / Gemini) — or hands it to a person.
 *   3. importScene(json) validates the returned JSON against the schema and builds it through the
 *      SAME loader as save/load.
 *
 * No API key, no cost, no lock-in, human-fallback — and safe, because the AI emits validated DATA,
 * never code. A one-click built-in API call can be added later on top of the same schema.
 */
import type { ShapeSpec } from './shapes';

export interface SceneSpec {
  version: 1;
  gravity: [number, number, number];
  objects: Array<{ shape: ShapeSpec; position: [number, number, number]; material?: string; velocity?: [number, number, number] }>;
}

export function exportPrompt(): string {
  return [
    'You are building a scene for a physics sandbox. Reply with ONLY valid JSON matching this schema:',
    '{ "version": 1, "gravity": [x,y,z], "objects": [ { "shape": {...}, "position": [x,y,z], "material"?, "velocity"? } ] }',
    'Shapes: {"type":"box","half":[hx,hy,hz]} | {"type":"sphere","radius":r}. Y is up. Keep it fun and physically sensible.',
  ].join('\n');
}

export const TODO = 'Extension — validate imported JSON, then build via the save/load loader.';
