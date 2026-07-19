/**
 * Accreted-planet composition + persistent painted "skin". Where the first cut re-baked a random
 * patchwork on every merge, a planet now OWNS its surface for life: the bigger body of a merger
 * keeps its canvases, orientation, and spin, and every body it absorbs is painted on at the spot
 * where it actually hit (impact direction → equirect UV), sized by its volume, with a faint crater
 * rim. Surfaces are baked into FOUR maps — albedo, normal, roughness, metalness — all sampled from
 * the ingredients' real PBR files at pool-matching texel density, so wood patches keep their grain
 * relief and steel patches gleam. History is never reshuffled: what you watched crash in stays
 * where it landed.
 *
 * Kept independent of the Sandbox class: the skin works purely in the planet's LOCAL frame; the
 * caller converts world impact positions into local directions.
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

// Source images for canvas baking. Same URLs the pools already fetched — the browser HTTP cache
// makes these second loads instant. Warmed for every preset map at module load.
const imgCache = new Map<string, HTMLImageElement>();
function srcImage(url: string): HTMLImageElement {
  let img = imgCache.get(url);
  if (!img) { img = new Image(); img.src = url; imgCache.set(url, img); }
  return img;
}
for (const m of PRESETS) for (const url of Object.values(m.maps ?? {})) if (url) srcImage(url);

const TARGET_PXM = 96; // painted texel density (px per surface metre) — chosen so a 2 m texture
//                        tile lands at ~192 px from a 1024 px source: real grain survives the bake
const MIN_W = 1024;
const MAX_W = 2048; // albedo/normal cap (rough/metal bake at half) — a planet is ~25 MB of GPU maps
const TILE_M = 2; // one source-texture tile ≈ 2 m of surface, matching the instanced pools
const FLUSH_MS = 300; // min interval between GPU re-uploads of a planet's canvases (the lag lever)

type LayerKind = 'albedo' | 'normal' | 'rough' | 'metal';
interface Layer { kind: LayerKind; canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture }

/** Flat fallback fills per layer for materials with no map of that kind. */
function flatStyle(kind: LayerKind, c: CompEntry): string {
  if (kind === 'albedo') return '#' + c.color.getHexString();
  if (kind === 'normal') return '#8080ff'; // tangent-space "straight up"
  if (kind === 'rough') return '#999999'; // ≈ the pools' plain roughness 0.6
  return c.mat.maps ? '#000000' : '#1a1a1a'; // textured non-metals are metalness 0; plain ≈ 0.1
}

/** The source-map URL for a layer, if the material has one. */
function mapUrl(kind: LayerKind, mat: Material): string | undefined {
  if (kind === 'albedo') return mat.maps?.albedo;
  if (kind === 'normal') return mat.maps?.normal;
  if (kind === 'rough') return mat.maps?.roughness;
  return mat.maps?.metalness;
}

/** Brightness filter applied when painting a layer — how the pools' scalar knobs reach the bake. */
function layerFilter(kind: LayerKind, mat: Material): string {
  if (kind === 'rough' && mat.roughnessScale) return `brightness(${Math.round(mat.roughnessScale * 100)}%)`;
  if (kind === 'metal' && mat.maps?.metalness) return 'brightness(85%)'; // the pools' 0.85 metalness
  return 'none';
}

const pow2ceil = (x: number) => 2 ** Math.ceil(Math.log2(Math.max(1, x)));
const clampW = (w: number) => Math.min(MAX_W, Math.max(MIN_W, pow2ceil(w)));

/**
 * A planet's persistent painted surface: four equirect canvases (albedo + normal full-res,
 * roughness + metalness half-res) behind one MeshStandardMaterial. All paint operations take a
 * direction in the planet's LOCAL frame plus sizes in METRES; the skin converts to pixels at the
 * planet's current radius, wraps the longitude seam, and widens strokes toward the poles so a
 * splat stays round on the sphere.
 */
export class PlanetSkin {
  readonly material: THREE.MeshStandardMaterial;
  private layers: Layer[] = [];
  private W = 0;
  // Paint is cheap; the GPU UPLOAD of four big canvases is not — so painting only marks the skin
  // dirty, and flushIfDue() re-uploads at most every FLUSH_MS. During a heavy accretion burst a
  // planet eating 8 bodies per check uploads once, not 8 times.
  private dirty = false;
  private lastFlush = 0;
  private patterns = new Map<string, string | CanvasPattern>(); // per-(layer×material) fill cache

  constructor(radius: number, base: CompEntry) {
    this.W = clampW(2 * Math.PI * radius * TARGET_PXM);
    for (const kind of ['albedo', 'normal', 'rough', 'metal'] as LayerKind[]) {
      const w = kind === 'albedo' || kind === 'normal' ? this.W : this.W / 2;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = w / 2;
      const ctx = canvas.getContext('2d')!;
      const tex = new THREE.CanvasTexture(canvas);
      if (kind === 'albedo') tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      this.layers.push({ kind, canvas, ctx, tex });
    }
    const [a, n, r, m] = this.layers;
    // scalar factors sit at 1 — the painted maps carry every material's own values
    this.material = new THREE.MeshStandardMaterial({
      map: a.tex, normalMap: n.tex, roughnessMap: r.tex, metalnessMap: m.tex,
      roughness: 1, metalness: 1,
    });
    this.material.userData.ownedTex = true; // deleteEntity/clear dispose all four canvases
    this.fill(base, radius);
  }

  /** A layer's fill for one ingredient: its tiled source map at ~TILE_M m/tile, or the flat fallback. */
  private styleFor(layer: Layer, c: CompEntry, pxPerM: number): string | CanvasPattern {
    // cached per (layer × material × color) — createPattern from a 1K image is not free, and a
    // busy planet asks for the same fills over and over. Plain's blended color is part of the key.
    const key = `${layer.kind}:${c.mat.id}:${c.mat.maps ? '' : c.color.getHexString()}`;
    const hit = this.patterns.get(key);
    if (hit) return hit;
    const url = mapUrl(layer.kind, c.mat);
    let style: string | CanvasPattern | null = null;
    if (url) {
      const img = srcImage(url);
      if (img.complete && img.naturalWidth > 0) {
        const pat = layer.ctx.createPattern(img, 'repeat')!;
        // snap to a whole number of tiles across the canvas so the longitude seam (u=0/1) tiles
        // cleanly — a fractional tile count leaves a visible cut down one meridian
        const tiles = Math.max(1, Math.round(layer.canvas.width / (TILE_M * pxPerM)));
        pat.setTransform(new DOMMatrix().scale(layer.canvas.width / (tiles * img.naturalWidth)));
        style = pat;
      } // image still downloading — fall through WITHOUT caching, so a later call can upgrade
    } else {
      style = flatStyle(layer.kind, c);
    }
    if (style) { this.patterns.set(key, style); return style; }
    return flatStyle(layer.kind, c);
  }

  private pxPerM(layer: Layer, radius: number) { return layer.canvas.width / (2 * Math.PI * radius); }

  /** Flood every layer with one ingredient (the base coat at skin birth). */
  fill(c: CompEntry, radius: number) {
    for (const L of this.layers) {
      L.ctx.filter = layerFilter(L.kind, c.mat);
      L.ctx.fillStyle = this.styleFor(L, c, this.pxPerM(L, radius));
      L.ctx.fillRect(0, 0, L.canvas.width, L.canvas.height);
      L.ctx.filter = 'none';
    }
    this.dirty = true;
  }

  /** Upload pending paint to the GPU, at most every FLUSH_MS. Call once per frame per planet. */
  flushIfDue(now: number) {
    if (!this.dirty || now - this.lastFlush < FLUSH_MS) return;
    this.dirty = false;
    this.lastFlush = now;
    for (const L of this.layers) L.tex.needsUpdate = true;
  }

  /**
   * Paint one absorbed body where it landed. `dirLocal` = unit vector from planet centre to the
   * impact, in the planet's LOCAL frame; `radiusM` = the painted patch radius in surface metres;
   * `rim` draws the faint darkened crater ring (albedo only). The patch is a true SPHERICAL CAP
   * painted row-by-row — for every latitude row the exact longitude span the cap covers is filled
   * (an equirect ellipse is a pie-wedge near a pole; the cap formula is right at every latitude).
   * Edge jitter is seeded per-splat so all four layers stay pixel-aligned.
   */
  splat(c: CompEntry, dirLocal: THREE.Vector3, radiusM: number, planetR: number, rim = true) {
    // local direction → colatitude/longitude, matching THREE.SphereGeometry's mapping:
    // x = −cosφ·sinθ, y = cosθ, z = sinφ·sinθ with φ = 2πu, θ = πv (v=0 at +Y). SphereGeometry
    // stores uv.y = 1−v and flipY re-inverts on upload — the two cancel, so the north pole is the
    // canvas TOP row (verified live with a pole drop).
    const th0 = Math.acos(THREE.MathUtils.clamp(dirLocal.y, -1, 1));
    const u = (Math.atan2(dirLocal.z, -dirLocal.x) / (2 * Math.PI) + 1) % 1;
    const alpha = Math.max(radiusM / planetR, 0.02); // the cap's angular radius
    const seed = Math.random() * 100; // one seed → identical organic edge on every layer
    for (const L of this.layers) {
      const W = L.canvas.width, H = L.canvas.height;
      const ppm = this.pxPerM(L, planetR);
      L.ctx.filter = layerFilter(L.kind, c.mat);
      L.ctx.fillStyle = this.styleFor(L, c, ppm);
      const py0 = Math.max(0, Math.floor(((th0 - alpha) / Math.PI) * H));
      const py1 = Math.min(H - 1, Math.ceil(((th0 + alpha) / Math.PI) * H));
      const xc = u * W;
      // Sample the cap edge per row, then fill ONCE as a polygon. Filling row-by-row with a
      // pattern fillStyle re-tiles the pattern PER CALL — a big cap was ~12k pattern fills and
      // froze the step for seconds (measured 1.2 s in one mergePair); as one Path2D it's ~4.
      let bandTop = -1, bandBot = -1; // contiguous rows the cap wraps completely (around a pole)
      const edge: Array<[number, number]> = []; // [row, half-width px] of partial rows
      for (let py = py0; py <= py1; py++) {
        const th = ((py + 0.5) / H) * Math.PI;
        // spherical cap ↔ latitude row intersection: the half-span of longitude covered
        const denom = Math.sin(th) * Math.sin(th0);
        let halfPhi: number;
        if (denom < 1e-6) halfPhi = th0 < alpha || Math.PI - th0 < alpha ? Math.PI : 0; // at a pole: all or nothing
        else {
          const cosd = (Math.cos(alpha) - Math.cos(th) * Math.cos(th0)) / denom;
          if (cosd <= -1) halfPhi = Math.PI;
          else if (cosd >= 1) continue;
          else halfPhi = Math.acos(cosd);
        }
        if (halfPhi <= 0) continue;
        if (halfPhi >= Math.PI) { if (bandTop < 0) bandTop = py; bandBot = py; continue; }
        // organic edge: wobble the LONGITUDE span only — jittering the cap radius per row slices
        // the patch into streaks (and rings a polar cap); a full-circle row has no edge to wobble.
        // Long wavelength (~50 rows) and small amplitude, or the edge reads as row-comb fringing.
        halfPhi *= 1 + 0.08 * Math.sin(py * 0.12 + seed) + 0.04 * Math.sin(py * 0.33 + seed * 2.3);
        edge.push([py, (Math.min(halfPhi, Math.PI) / (2 * Math.PI)) * W]);
      }
      if (bandTop >= 0) L.ctx.fillRect(0, bandTop, W, bandBot - bandTop + 1); // full-width band: no seam to wrap
      if (edge.length > 1) {
        const path = new Path2D();
        path.moveTo(xc + edge[0][1], edge[0][0]);
        for (const [py, hw] of edge) path.lineTo(xc + hw, py + 1); // down the right edge
        for (let i = edge.length - 1; i >= 0; i--) path.lineTo(xc - edge[i][1], edge[i][0]); // up the left
        path.closePath();
        // wrap copies across the longitude seam: translating by ±W keeps the pattern phase — the
        // fill snaps to a whole number of tiles per width, so W is a multiple of the tile period
        for (const wrap of [0, -W, W]) {
          L.ctx.save();
          L.ctx.translate(wrap, 0);
          L.ctx.fill(path);
          L.ctx.restore();
        }
      }
      L.ctx.filter = 'none';
      if (rim && L.kind === 'albedo' && th0 > alpha + 0.3 && Math.PI - th0 > alpha + 0.3) {
        // a faint darkened ring sells the impact site (mid-latitude only — near a pole the
        // ellipse approximation degenerates and the cap edge already reads clearly)
        const r = radiusM * ppm;
        const widen = 1 / Math.max(Math.sin(th0), 0.18);
        const px = u * W, py = (th0 / Math.PI) * H;
        L.ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        L.ctx.lineWidth = Math.max(1.5, r * 0.14);
        for (const wrap of [0, -W, W]) {
          L.ctx.beginPath();
          L.ctx.ellipse(px + wrap, py, r * 1.02 * widen, r * 1.02, 0, 0, Math.PI * 2);
          L.ctx.stroke();
        }
      }
    }
    this.dirty = true; // uploaded by flushIfDue — never per-splat
  }

  /**
   * If the planet has outgrown its texel density (radius grew past what the canvas covers at
   * TARGET_PXM), upscale every layer in place — old paint blurs slightly, new splats land crisp.
   * A no-op once the MAX_W cap is reached, so it fires at most a couple of times per planet.
   */
  ensureCapacity(radius: number) {
    const want = clampW(2 * Math.PI * radius * TARGET_PXM);
    if (want <= this.W) return;
    this.W = want;
    for (const L of this.layers) {
      const w = L.kind === 'albedo' || L.kind === 'normal' ? want : want / 2;
      const next = document.createElement('canvas');
      next.width = w; next.height = w / 2;
      const ctx = next.getContext('2d')!;
      ctx.drawImage(L.canvas, 0, 0, w, w / 2);
      L.canvas = next; L.ctx = ctx;
      const old = L.tex;
      L.tex = new THREE.CanvasTexture(next);
      if (L.kind === 'albedo') L.tex.colorSpace = THREE.SRGBColorSpace;
      L.tex.anisotropy = 8;
      old.dispose();
    }
    const [a, n, r, m] = this.layers;
    this.material.map = a.tex; this.material.normalMap = n.tex;
    this.material.roughnessMap = r.tex; this.material.metalnessMap = m.tex;
    this.material.needsUpdate = true;
    this.patterns.clear(); // pattern transforms are canvas-width-relative — stale after a resize
    this.dirty = true;
  }

  /** Volume-weighted env reflection boost — the one look knob the maps can't carry. */
  refreshScalars(comp: CompEntry[]) {
    const total = comp.reduce((s, c) => s + c.vol, 0) || 1;
    let env = 0;
    for (const c of comp) env += (c.vol / total) * (c.mat.envBoost ?? 1);
    this.material.envMapIntensity = env;
  }

  dispose() {
    for (const L of this.layers) L.tex.dispose();
    this.material.dispose();
  }
}
