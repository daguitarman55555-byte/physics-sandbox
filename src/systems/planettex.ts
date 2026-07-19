/**
 * Accreted-planet composition + baked patchwork textures. When accretion fuses bodies of different
 * materials, the merged planet remembers what it ate (a volume-weighted composition) and renders a
 * canvas-baked equirect map: the dominant material fills the surface, every minor ingredient shows
 * as irregular blotch patches covering ≈ its volume fraction — a 60% stone / 40% steel planet reads
 * as stony rock with steel veins. Patches sample the ingredients' REAL albedo maps (same CC0 files
 * the pools tile), so the merged surface is the source textures, not a tinted average.
 *
 * Kept independent of the Sandbox class: pure functions over Material + volumes, imported by
 * mergePair. Plain (untextured) ingredients contribute their palette color; merging plains blends
 * those colors volume-weighted.
 */
import * as THREE from 'three';
import { PRESETS, type Material } from './materials';

/** One ingredient of an accreted body. `color` is the visible tint for untextured (Plain) volume. */
export interface CompEntry { mat: Material; vol: number; color: THREE.Color }

/** Combine two compositions: same materials pool their volume (blending Plain's color), sorted desc. */
export function mergeComp(a: CompEntry[], b: CompEntry[]): CompEntry[] {
  const out: CompEntry[] = [];
  for (const src of [...a, ...b]) {
    const hit = out.find((c) => c.mat.id === src.mat.id);
    if (!hit) out.push({ mat: src.mat, vol: src.vol, color: src.color.clone() });
    else {
      hit.color.lerp(src.color, src.vol / (hit.vol + src.vol)); // volume-weighted color blend
      hit.vol += src.vol;
    }
  }
  return out.sort((x, y) => y.vol - x.vol);
}

// Albedo images for canvas baking. THREE's texture cache isn't reachable from here, but these are
// the same URLs the pools already fetched, so the browser cache makes the second load instant.
const imgCache = new Map<string, HTMLImageElement>();
function albedoImage(url: string): HTMLImageElement {
  let img = imgCache.get(url);
  if (!img) { img = new Image(); img.src = url; imgCache.set(url, img); }
  return img;
}
// warm the cache at module load so the first mixed merge already has pixels to sample
for (const m of PRESETS) if (m.maps?.albedo) albedoImage(m.maps.albedo);

/** A canvas fill for one ingredient: its tiled albedo (at ~2 m/tile like the pools) or a flat color. */
function styleFor(ctx: CanvasRenderingContext2D, c: CompEntry, pxPerM: number): string | CanvasPattern {
  const url = c.mat.maps?.albedo;
  if (url) {
    const img = albedoImage(url);
    if (img.complete && img.naturalWidth > 0) {
      const pat = ctx.createPattern(img, 'repeat')!;
      const s = (2 * pxPerM) / img.naturalWidth; // one tile ≈ 2 m of surface, matching pool tiling
      pat.setTransform(new DOMMatrix().scale(Math.max(s, 0.01)));
      return pat;
    }
    return c.mat.color; // map still downloading — flat fallback (rare; cache is warmed above)
  }
  return '#' + c.color.getHexString();
}

const W = 256; // equirect bake — small on purpose: blotches read fine, and merges re-bake often
const H = 128;

/**
 * Bake the patchwork material for a composition (sorted desc, ≥2 entries). Scalar roughness /
 * metalness / envMapIntensity are volume-weighted blends of the ingredients (patch-masked PBR maps
 * are a later nicety). The caller owns the canvas texture: `userData.ownedTex` marks it for
 * disposal with the mesh.
 */
export function bakePlanetMaterial(comp: CompEntry[], radius: number): THREE.MeshStandardMaterial {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const total = comp.reduce((s, c) => s + c.vol, 0) || 1;
  const pxPerM = W / (2 * Math.PI * radius); // canvas width wraps the equator

  ctx.fillStyle = styleFor(ctx, comp[0], pxPerM);
  ctx.fillRect(0, 0, W, H);
  for (let k = 1; k < comp.length; k++) {
    const frac = comp[k].vol / total;
    if (frac < 0.015) continue; // sub-1.5% ingredients are invisible at this scale
    ctx.fillStyle = styleFor(ctx, comp[k], pxPerM);
    const target = frac * W * H;
    let area = 0;
    for (let guard = 0; area < target && guard < 400; guard++) {
      const rx = 6 + Math.random() * 22, ry = rx * (0.5 + Math.random() * 0.9);
      const x = Math.random() * W, y = Math.random() * H;
      const rot = Math.random() * Math.PI;
      for (const dx of [0, -W, W]) { // repeat across the seam so patches wrap in longitude
        ctx.beginPath();
        ctx.ellipse(x + dx, y, rx, ry, rot, 0, Math.PI * 2);
        ctx.fill();
      }
      area += Math.PI * rx * ry * 0.85; // rough overlap discount
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  let rough = 0, metal = 0, env = 0;
  for (const c of comp) {
    const f = c.vol / total;
    rough += f * (c.mat.maps ? (c.mat.roughnessScale ?? 0.9) : 0.6);
    metal += f * (c.mat.maps?.metalness ? 0.85 : 0.1);
    env += f * (c.mat.envBoost ?? 1);
  }
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: rough, metalness: metal, envMapIntensity: env });
  m.userData.ownedTex = true;
  return m;
}
