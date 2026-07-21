/**
 * PERSISTENCE — Phase 7, first slice: save & load a scene.
 *
 * A scene is serialized to a plain JSON document (this file defines the shape) and rebuilt from it.
 * The Sandbox owns the encode/decode (it needs the world, the create* methods, and the material
 * registry); this module holds the data contract, the material lookup, and the file/quick-save I/O.
 *
 * What round-trips exactly: primitives (box/sphere), custom shapes rebuilt from their equations
 * (revolution / curve / surface / implicit), force fields, joints, and every world setting. What is
 * NOT captured yet: emergent procedural bodies — accreted planets (their painted skins) and shatter
 * debris — which have no equation to rebuild from. loadScene reports how many it skipped so the count
 * is honest, and joints touching a skipped body are dropped too.
 */
import { PLAIN, PRESETS, type Material } from './materials';

export const SCENE_VERSION = 1;
export const QUICKSAVE_KEY = 'physics-sandbox:quicksave:v1';

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

/** One saved body. `spec`/`specKind` are present for custom shapes (the equations to rebuild them). */
export interface EntityData {
  kind: 'box' | 'sphere' | 'custom';
  specKind?: 'revolution' | 'curve' | 'surface' | 'implicit';
  spec?: unknown; // the create-method spec (all strings + numbers → JSON-safe)
  size: number;
  matId: string;
  color: number; // hex — a plain body's per-object palette color
  pos: Vec3;
  quat: Vec4;
  linvel: Vec3;
  angvel: Vec3;
  frozen?: boolean;
  gravityScale?: number; // per-object gravity multiplier (omitted when the default 1)
}

/** A path field's flow curve — equations only; the sampled polyline is re-derived on load. */
export interface PathData {
  spec: { xt: string; yt: string; zt: string; t0: number; t1: number };
  label: string;
  scale: number;
  swirl: number;
  closed: boolean;
  drawn?: number[]; // freehand stroke as unit points (no equation to re-sample)
}

export interface FieldData {
  kind: string;
  shape: string;
  pos: Vec3;
  quat: Vec4;
  size: Vec3;
  strength: number;
  hidden: boolean;
  lift?: boolean;
  dir?: 1 | -1;
  sole?: boolean;
  path?: PathData;
}

/** A joint, by index into the saved `entities` array (both endpoints must survive to be restored). */
export interface JointLink {
  a: number;
  b: number;
  kind: string;
}

export interface WorldData {
  gravityY: number;
  timeScale: number;
  paused: boolean;
  selfGravity: boolean;
  selfG: number;
  accretion: boolean;
  breakage: boolean;
  fieldStrength: number;
}

export interface SceneData {
  version: number;
  world: WorldData;
  entities: EntityData[];
  fields: FieldData[];
  joints: JointLink[];
  camera?: { pos: Vec3; target: Vec3 };
  skipped?: number; // procedural bodies (accreted / debris) not serialized — informational
}

/** Resolve a saved material id back to a preset (falls back to Plain if the id is unknown). */
export function materialById(id: string): Material {
  if (id === PLAIN.id) return PLAIN;
  return PRESETS.find((m) => m.id === id) ?? PLAIN;
}

/** Basic structural check so a stray/old JSON file fails cleanly instead of half-loading. */
export function isSceneData(v: unknown): v is SceneData {
  const s = v as SceneData;
  return !!s && s.version === SCENE_VERSION && Array.isArray(s.entities)
    && Array.isArray(s.fields) && Array.isArray(s.joints) && !!s.world;
}

/** Trigger a browser download of the scene as a .json file. */
export function downloadScene(filename: string, data: SceneData) {
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Prompt the user for a .json file and resolve its parsed contents (null on cancel / read error). */
export function pickSceneFile(): Promise<unknown | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => {
        try { resolve(JSON.parse(String(reader.result))); }
        catch { resolve(null); }
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.click();
  });
}
