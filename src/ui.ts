/**
 * UI — the control panel, the live HUD, and the object inspector.
 *
 * Pure DOM (no framework yet — kept lean for Phase 1; swap in React when panels grow). Everything
 * here only reads/commands the Sandbox; it never touches physics directly.
 */
import * as THREE from 'three';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { MathfieldElement } from 'mathlive';
import 'mathlive/fonts.css';
import type { Entity, Sandbox, FieldRec } from './sandbox';
import { DrawPad } from './drawpad';
import { buildRevolution, buildParamCurve, buildParamSurface, REV_PRESETS, CURVE_PRESETS, SURFACE_PRESETS } from './systems/shapes';
import { buildImplicit, IMPLICIT_PRESETS } from './systems/implicit';
import {
  REV_CATALOG, CURVE_CATALOG, SURFACE_CATALOG, IMPLICIT_CATALOG,
  type RevEntry, type CurveEntry, type SurfEntry, type ImpEntry,
} from './systems/catalog';
import { exprToLatex } from './systems/expr';
import { PLAIN, PRESETS as MATERIALS, type Material } from './systems/materials';
import { FIELD_INFO, FIELD_SHAPES, PATH_PRESETS, PATH_PRESET_KEYS, type FieldKind, type FieldShape } from './systems/fields';
import { JOINT_INFO, type JointKind } from './systems/joints';
import { downloadScene, pickSceneFile, isSceneData, QUICKSAVE_KEY } from './systems/persistence';
import type { Tool, BrushMode } from './sandbox';

// fonts come from the CSS import above; no sounds, no popup keyboard — it's a typed input
MathfieldElement.fontsDirectory = null;
MathfieldElement.soundsDirectory = null;

export function buildUI(sandbox: Sandbox) {
  buildPanel(sandbox);
  buildHud(sandbox);
  buildInspector(sandbox);
  buildForcesView(sandbox);
}

/**
 * A Desmos-style math input: you type INTO rendered math (MathLive) — `1/2` becomes a live
 * fraction under the caret, `sin` becomes upright, `pi` becomes π, all in place. The engine still
 * speaks calculator syntax, so `value()` converts the field's ascii-math back to it (the parser's
 * implicit multiplication covers juxtaposition like `2pi` or `0.18t`).
 */
function mathField(initial: string) {
  const mf = new MathfieldElement();
  mf.mathVirtualKeyboardPolicy = 'manual';
  // Programmatic sets (presets, the shape library) keep the ORIGINAL engine string authoritative:
  // the LaTeX→ascii-math read-back has no inverse for some notations (|x| for abs, sgn, quoted
  // operator names), so round-tripping a set value could break formulas that are known-good.
  // The moment the user edits the field, the read-back becomes the source of truth again.
  let raw: string | null = null;
  const set = (engine: string) => {
    raw = engine;
    mf.setValue(exprToLatex(engine) ?? engine, { silenceNotifications: true });
  };
  mf.addEventListener('input', () => { raw = null; }); // registered first — runs before any refresh
  set(initial);
  return {
    el: mf,
    set,
    value: () => raw ?? asciiToEngine(mf.getValue('ascii-math')),
    latex: () => mf.getValue(),
  };
}
type MathField = ReturnType<typeof mathField>;

/** MathLive's ascii-math output → engine syntax (normalize its multiplication/minus variants).
 * Spaces are stripped entirely: it lets fast-typed `s i n(x)` (chars not yet fused to \sin) become
 * `sin(x)`, and juxtaposition like `0.18 t` still multiplies via the parser's implicit `*`. */
function asciiToEngine(src: string): string {
  let out = src
    .replace(/\bxx\b/g, '*') // ascii-math spelling of \times
    .replace(/[·×⋅]/g, '*')
    .replace(/−/g, '-')
    .replace(/"/g, '') // MathLive quotes some \operatorname names
    .replace(/\s+/g, ''); // MathLive spells operator names "s g n" — strip BEFORE renaming
  out = out.replace(/\bsgn\b/g, 'sign'); // our sign() renders as \operatorname{sgn}
  // |…| → abs(…): handles sequential (and, via repetition, once-nested) absolute values
  for (let i = 0; i < 4 && out.includes('|'); i++) out = out.replace(/\|([^|]+)\|/g, 'abs($1)');
  return out;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, html = '', cls = ''): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (html) n.innerHTML = html;
  if (cls) n.className = cls;
  return n;
}

/**
 * A collapsible panel section: header (click toggles, chevron shows state) + body. Keeps the main
 * panel tidy — the three shape creators sit collapsed until needed.
 */
function section(panel: HTMLElement, title: string, open: boolean): HTMLElement {
  const sec = el('div', '', 'sec' + (open ? '' : ' collapsed'));
  const head = el('h3', `<span>${title}</span><span class="chev">▾</span>`, 'sec-head');
  head.onclick = () => sec.classList.toggle('collapsed');
  const body = el('div', '', 'sec-body');
  sec.append(head, body);
  panel.append(sec);
  return body;
}

/** The panel-wide active material: every spawn/create call reads it; creators sync their density. */
interface MaterialsHook {
  get(): Material;
  onChange(cb: (m: Material) => void): void;
}

// ============================================================ floating windows
//
// Every panel is a window: drag it anywhere by its header, resize it by the native bottom-right
// grip (contents reflow — canvases re-render at the new size via ResizeObserver), and pressing
// anywhere on it brings it to the front.

let topZ = 40;

/**
 * Make `root` a movable window. `handleSel` picks the drag handle(s) by delegated selector, so
 * handles inside live-rewritten innerHTML keep working. On first drag the element is pinned as a
 * free-floating fixed window at its current screen position (detaching it from any dock/anchor).
 */
function makeFloating(root: HTMLElement, handleSel: string) {
  root.addEventListener('pointerdown', (e) => {
    root.style.zIndex = String(++topZ); // any press raises the window
    const t = e.target as HTMLElement;
    if (t.closest('button, input, math-field, canvas, a')) return; // interactive bits aren't handles
    if (!t.closest(handleSel)) return;
    const rect = root.getBoundingClientRect();
    root.style.position = 'fixed';
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    root.style.width = `${rect.width}px`;
    root.style.height = `${rect.height}px`;
    root.style.maxHeight = 'none';
    root.style.margin = '0';
    if (root.parentElement !== document.body) document.body.append(root);
    const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
    const move = (ev: PointerEvent) => {
      root.style.left = `${ev.clientX - dx}px`;
      root.style.top = `${ev.clientY - dy}px`;
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    e.preventDefault();
  });
}

/**
 * Frame the camera so a sphere of `radius` around the origin fits entirely in view — whichever of
 * the vertical/horizontal FOV is tighter decides the distance, so nothing hangs off any edge.
 */
const fitDir = new THREE.Vector3();
function fitCamera(camera: THREE.PerspectiveCamera, radius: number, dx: number, dy: number, dz: number) {
  const vHalf = THREE.MathUtils.degToRad(camera.fov) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * camera.aspect);
  const d = Math.max(radius, 0.05) / Math.sin(Math.min(vHalf, hHalf));
  camera.position.copy(fitDir.set(dx, dy, dz)).normalize().multiplyScalar(d);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

// ============================================================ shape preview popup
//
// A small floating window with its own Three.js renderer that shows the shape currently being
// designed (any custom-shape creator), slowly spinning, live-updating as the inputs change.
// Draggable by its header; × hides it; the next edit in a creator brings it back.

class ShapePreview {
  private root: HTMLDivElement;
  private caption: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 256 / 200, 0.1, 200);
  private spin = new THREE.Group(); // holds the current mesh; rotation persists across updates
  private mesh: THREE.Mesh | null = null;
  private pending: { geometry: THREE.BufferGeometry; caption: string } | null = null;
  private raf = 0;

  private frameR = 1; // bounding radius of the current shape, for camera framing
  private captionSrc = ''; // latest caption LaTeX, so we can re-render it on font-load / resize

  constructor() {
    this.root = el('div', '', 'hidden');
    this.root.id = 'shape-preview';
    const header = el('header', '<span>Shape preview</span>');
    const close = el('button', '×');
    close.onclick = () => this.hide();
    header.append(close);
    this.canvas = document.createElement('canvas');
    this.caption = el('div', '', 'cap');
    this.root.append(header, this.canvas, this.caption);
    document.body.append(this.root);
    makeFloating(this.root, 'header');

    // re-render at the new size whenever the window is resized
    new ResizeObserver(() => {
      if (!this.renderer) return;
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (!w || !h) return;
      this.renderer.setSize(w, h, false);
      this.fit();
    }).observe(this.canvas);

    // KaTeX measures from font metrics, so an equation rendered before its web fonts finish
    // loading collapses to zero height (invisible until a later reflow). Re-render the caption
    // once fonts are ready — this is the automatic version of the "stretch the tab" workaround.
    document.fonts?.ready.then(() => this.renderCaption());

    this.scene.add(new THREE.HemisphereLight('#aab6cc', '#20242e', 0.9));
    const sun = new THREE.DirectionalLight('#ffffff', 1.9);
    sun.position.set(4, 6, 5);
    this.scene.add(sun);
    this.scene.add(this.spin);
  }

  /** Aim the camera so the whole shape fits, at the current canvas aspect. */
  private fit() {
    this.camera.aspect = (this.canvas.clientWidth || 256) / (this.canvas.clientHeight || 200);
    fitCamera(this.camera, this.frameR * 1.12, 0.35, 0.4, 1);
  }

  /** Swap in a new geometry (called on every valid rebuild). Does not open the popup. */
  update(geometry: THREE.BufferGeometry, caption: string) {
    if (this.isOpen()) {
      this.apply(geometry, caption);
    } else {
      this.pending?.geometry.dispose(); // replaced before ever shown
      this.pending = { geometry, caption };
    }
  }

  /** Open the popup (creates the GL context on first use) and show the latest shape. */
  show() {
    this.root.classList.remove('hidden');
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      this.renderer.setSize(this.canvas.clientWidth || 256, this.canvas.clientHeight || 200, false);
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping; // match the main view's look
      this.renderer.toneMappingExposure = 1.2;
    }
    if (this.pending) {
      this.apply(this.pending.geometry, this.pending.caption);
      this.pending = null;
    }
    if (!this.raf) {
      const loop = () => {
        this.raf = requestAnimationFrame(loop);
        this.spin.rotation.y += 0.01;
        this.renderer!.render(this.scene, this.camera);
      };
      loop();
    }
  }

  hide() {
    this.root.classList.add('hidden');
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private isOpen(): boolean {
    return !this.root.classList.contains('hidden');
  }

  // starts as the classic preview blue; the material picker swaps in the active preset's PBR maps
  private material = new THREE.MeshStandardMaterial({ color: '#5b8def', metalness: 0.1, roughness: 0.55, side: THREE.DoubleSide });

  /** Preview shapes in this material from now on (called when the active material changes). */
  setMaterial(m: THREE.MeshStandardMaterial) {
    m.side = THREE.DoubleSide; // open surfaces (Möbius, sheets) are visible from both sides
    this.material.dispose(); // textures live in the sandbox cache — disposing the material is safe
    this.material = m;
    if (this.mesh) this.mesh.material = m;
  }

  private apply(geometry: THREE.BufferGeometry, caption: string) {
    if (this.mesh) {
      this.spin.remove(this.mesh);
      this.mesh.geometry.dispose();
    } else {
      this.mesh = new THREE.Mesh(geometry, this.material);
    }
    this.mesh.geometry = geometry;
    this.spin.add(this.mesh);
    // center the VISUAL middle (bounding-sphere center), not the center of mass — a lopsided
    // shape's c.o.m. sits off-middle and used to push part of the shape out of frame
    geometry.computeBoundingSphere();
    const bs = geometry.boundingSphere!;
    this.mesh.position.copy(bs.center).multiplyScalar(-1);
    this.frameR = bs.radius || 1;
    this.fit();
    this.captionSrc = caption;
    // defer past this frame's layout: apply() is often called straight after show() un-hides the
    // popup, so the element isn't laid out yet — rendering now would measure against a zero box
    requestAnimationFrame(() => this.renderCaption());
  }

  /** (Re)render the stored caption. Safe to call repeatedly — on font-load, resize, or update. */
  private renderCaption() {
    if (!this.captionSrc) return;
    try {
      katex.render(this.captionSrc, this.caption, { displayMode: false, throwOnError: false, strict: false });
    } catch {
      this.caption.textContent = this.captionSrc;
    }
  }
}

let shapePreview: ShapePreview | null = null;
function getShapePreview(): ShapePreview {
  return (shapePreview ??= new ShapePreview());
}

// ============================================================ shape library
//
// A floating, tabbed window over the ~200-formula catalog (systems/catalog.ts). Clicking an entry
// fills the matching creator's fields, pops its section open, and live-updates the 3D preview —
// so you can flip through shapes like a picture book. Draggable by its header; × hides it.

type LibTab = 'rev' | 'curve' | 'surface' | 'implicit';
interface LibAppliers {
  rev: (e: RevEntry) => void;
  curve: (e: CurveEntry) => void;
  surface: (e: SurfEntry) => void;
  implicit: (e: ImpEntry) => void;
}

class ShapeLibrary {
  private root = el('div', '', 'hidden');
  private bodyEl = el('div', '', 'libbody');
  private tabs = new Map<LibTab, HTMLButtonElement>();
  private pages = new Map<LibTab, HTMLElement>();

  constructor(private appliers: LibAppliers) {
    this.root.id = 'shape-library';
    const header = el('header', '<span>Shape library</span>');
    const close = el('button', '×');
    close.onclick = () => this.root.classList.add('hidden');
    header.append(close);
    const tabRow = el('div', '', 'row libtabs');
    const defs: Array<[LibTab, string]> = [['rev', 'f(x)'], ['curve', 'Curves'], ['surface', 'Surfaces'], ['implicit', 'Implicit']];
    for (const [tab, label] of defs) {
      const b = el('button', label, 'mini');
      b.onclick = () => this.select(tab);
      this.tabs.set(tab, b);
      tabRow.append(b);
    }
    this.root.append(header, tabRow, this.bodyEl);
    document.body.append(this.root);
    makeFloating(this.root, 'header');
  }

  open(tab: LibTab) {
    this.root.classList.remove('hidden');
    this.select(tab);
  }

  private select(tab: LibTab) {
    for (const [t, b] of this.tabs) b.classList.toggle('primary', t === tab);
    for (const [t, p] of this.pages) p.classList.toggle('hidden', t !== tab);
    if (!this.pages.has(tab)) {
      const page = this.buildPage(tab); // built on first visit
      this.pages.set(tab, page);
      this.bodyEl.append(page);
    }
  }

  private buildPage(tab: LibTab): HTMLElement {
    const page = el('div', '', 'libpage');
    const add = <T extends { name: string; group: string }>(entries: T[], apply: (e: T) => void) => {
      const groups = new Map<string, T[]>();
      for (const e of entries) {
        let g = groups.get(e.group);
        if (!g) { g = []; groups.set(e.group, g); }
        g.push(e);
      }
      for (const [group, list] of groups) {
        page.append(el('h4', group));
        const row = el('div', '', 'row wrap');
        for (const e of list) {
          const b = el('button', e.name, 'mini');
          b.onclick = () => apply(e);
          row.append(b);
        }
        page.append(row);
      }
    };
    if (tab === 'rev') add(REV_CATALOG, this.appliers.rev);
    else if (tab === 'curve') add(CURVE_CATALOG, this.appliers.curve);
    else if (tab === 'surface') add(SURFACE_CATALOG, this.appliers.surface);
    else add(IMPLICIT_CATALOG, this.appliers.implicit);
    return page;
  }
}

function buildPanel(sandbox: Sandbox) {
  const panel = document.getElementById('panel')!;
  panel.append(el('h3', 'Physics Sandbox', 'ptitle'));
  makeFloating(panel, '.ptitle'); // drag by the title; section headers toggle collapse instead

  // --- material picker: ONE active material, applied to everything spawned or created ---
  let active: Material = PLAIN;
  const listeners: Array<(m: Material) => void> = [];
  const materials: MaterialsHook = {
    get: () => active,
    onChange: (cb) => listeners.push(cb),
  };
  const matBody = section(panel, 'Material', true);
  const chipRow = el('div', '', 'row wrap');
  const matInfo = el('div', '', 'preview');
  const describe = (m: Material) =>
    `ρ <b>${m.density}</b> kg/m³ · μ <b>${m.friction.toFixed(2)}</b> · e <b>${m.restitution.toFixed(2)}</b>`;
  const chips: HTMLButtonElement[] = [];
  const paletteDot = 'linear-gradient(90deg,#5b8def,#4fb89a,#c9bb3a,#e89948)'; // "plain" = palette colors
  for (const m of [PLAIN, ...MATERIALS]) {
    const b = el('button', `<i class="dot" style="background:${m.color || paletteDot}"></i>${m.name}`, 'mini chip');
    b.onclick = () => {
      active = m;
      for (const c of chips) c.classList.toggle('on', c === b);
      matInfo.innerHTML = describe(m);
      for (const cb of listeners) cb(m);
    };
    chips.push(b);
    chipRow.append(b);
  }
  chips[0].classList.add('on');
  matInfo.innerHTML = describe(PLAIN);
  matBody.append(chipRow, matInfo);
  // the design-time shape preview renders in the active material too
  materials.onChange((m) => getShapePreview().setMaterial(sandbox.previewMaterial(m)));

  // --- spawn primitives ---
  const spawnBody = section(panel, 'Spawn', true);
  const spawn = el('div', '', 'row');
  const bBox = el('button', 'Box');
  const bSphere = el('button', 'Sphere');
  const b100 = el('button', '+100', 'primary');
  b100.title = 'Spawn 100 objects of the active material';
  bBox.onclick = () => sandbox.spawn('box', undefined, undefined, materials.get());
  bSphere.onclick = () => sandbox.spawn('sphere', undefined, undefined, materials.get());
  b100.onclick = () => sandbox.spawnMany(100, materials.get());
  spawn.append(bBox, bSphere, b100);
  spawnBody.append(spawn);

  // --- Phase 2 shape creators (collapsed until needed) ---
  // each creator returns its "apply a catalog entry" function; the shape library dispatches to them
  let library: ShapeLibrary | null = null;
  const openLib = (tab: LibTab) => { (library ??= new ShapeLibrary(appliers)).open(tab); };
  const appliers: LibAppliers = {
    rev: buildShapeCreator(section(panel, 'Create · f(x) revolution', false), sandbox, materials, () => openLib('rev')),
    curve: buildCurveCreator(section(panel, 'Create · parametric curve', false), sandbox, materials, () => openLib('curve')),
    surface: buildSurfaceCreator(section(panel, 'Create · parametric surface', false), sandbox, materials, () => openLib('surface')),
    implicit: buildImplicitCreator(section(panel, 'Create · implicit f(x,y,z)', false), sandbox, materials, () => openLib('implicit')),
  };

  // --- Phase 4: interaction tools ---
  buildToolsSection(section(panel, 'Tools', false), sandbox);

  // --- Phase 4: force fields ---
  buildFieldsSection(section(panel, 'Fields & Forces', false), sandbox);

  // --- world ---
  const worldBody = section(panel, 'World', true);
  const field = el('div', '', 'field');
  const label = el('label', 'Gravity <b>-9.81</b>');
  const range = el('input');
  range.type = 'range';
  range.min = '-20'; range.max = '20'; range.step = '0.1'; range.value = String(sandbox.gravityY);
  range.oninput = () => {
    const v = parseFloat(range.value);
    sandbox.setGravityY(v);
    label.querySelector('b')!.textContent = v.toFixed(2);
  };
  field.append(label, range);
  worldBody.append(field);

  const presets = el('div', '', 'row wrap');
  const set = (v: number) => () => {
    sandbox.setGravityY(v);
    range.value = String(v);
    label.querySelector('b')!.textContent = v.toFixed(2);
  };
  const gEarth = el('button', 'Earth'); gEarth.onclick = set(-9.81);
  const gMoon = el('button', 'Moon'); gMoon.onclick = set(-1.62);
  const gZero = el('button', 'Zero-G'); gZero.onclick = set(0);
  presets.append(gEarth, gMoon, gZero);
  worldBody.append(presets);

  // mutual gravity: every object pulls every other (Barnes-Hut N-body) — the solar-system maker.
  // Pairs naturally with Zero-G + a gravity well: the well is the star, this makes the rubble clump.
  const sgRow = el('div', '', 'row');
  const bSelf = el('button', '☄ Mutual gravity', 'mini');
  bSelf.onclick = () => {
    const on = !sandbox.selfGravity;
    sandbox.setSelfGravity(on);
    bSelf.classList.toggle('primary', on);
  };
  // accretion is independent of mutual gravity: pair them for solar systems, or fuse a plain
  // pile on the floor with accretion alone
  const bAccrete = el('button', '🪐 Accretion', 'mini');
  bAccrete.title = 'Slow-touching objects fuse into one growing sphere — planets form from rubble';
  bAccrete.onclick = () => {
    const on = !sandbox.accretion;
    sandbox.setAccretion(on);
    bAccrete.classList.toggle('primary', on);
  };
  // impact breakage: the destructive half of the accretion lifecycle
  const bBreak = el('button', '💥 Breakage', 'mini');
  bBreak.title = 'Violent impacts shatter bodies into debris that inherits their materials';
  bBreak.onclick = () => {
    const on = !sandbox.breakage;
    sandbox.setBreakage(on);
    bBreak.classList.toggle('primary', on);
  };
  // planet texture detail: HD = full-grain 2048px skins (~25 MB GPU each); off = 4× smaller
  const bHD = el('button', '✨ HD skins', 'mini primary');
  bHD.title = 'Maximum texture detail on accreted planets — turn off on weaker machines';
  bHD.onclick = () => {
    const hi = !sandbox.skinDetail;
    sandbox.setSkinDetail(hi);
    bHD.classList.toggle('primary', hi);
  };
  sgRow.append(bSelf, bAccrete, bBreak, bHD);
  worldBody.append(sgRow);

  // time controls: pause, and a wall-time multiplier. Physics always steps its fixed 1/60 s —
  // the scale only changes how many steps run per second, so forces/impulses stay identical.
  const timeRow = el('div', '', 'row');
  const bPause = el('button', '⏸ Pause', 'mini');
  bPause.onclick = () => {
    const p = !sandbox.isPaused;
    sandbox.setPaused(p);
    bPause.textContent = p ? '▶ Resume' : '⏸ Pause';
    bPause.classList.toggle('primary', p);
  };
  timeRow.append(bPause);
  worldBody.append(timeRow);

  const tField = el('div', '', 'field');
  const tLabel = el('label', 'Time scale <b>×1.0</b>');
  const tRange = el('input');
  tRange.type = 'range';
  tRange.min = '0.1'; tRange.max = '3'; tRange.step = '0.1'; tRange.value = '1';
  tRange.oninput = () => {
    const v = parseFloat(tRange.value);
    sandbox.setTimeScale(v);
    tLabel.querySelector('b')!.textContent = `×${v.toFixed(1)}`;
  };
  tField.append(tLabel, tRange);
  worldBody.append(tField);

  const sgField = el('div', '', 'field');
  const sgLabel = el('label', `Pull strength G <b>${sandbox.selfGravityG.toFixed(1)}</b>`);
  const sgRange = el('input');
  sgRange.type = 'range';
  sgRange.min = '0'; sgRange.max = '10'; sgRange.step = '0.1'; sgRange.value = String(sandbox.selfGravityG);
  sgRange.oninput = () => {
    const v = parseFloat(sgRange.value);
    sandbox.setSelfGravityG(v);
    sgLabel.querySelector('b')!.textContent = v.toFixed(1);
  };
  sgField.append(sgLabel, sgRange);
  worldBody.append(sgField);

  const actionsRow = el('div', '', 'row');
  const bReset = el('button', 'Reset scene');
  bReset.onclick = () => sandbox.reset();
  const bDelAll = el('button', 'Delete all', 'danger');
  bDelAll.onclick = () => sandbox.clear();
  actionsRow.append(bReset, bDelAll);
  worldBody.append(actionsRow);

  // --- Phase 7: save / load ---
  buildSceneSection(section(panel, 'Scene', true), sandbox);

  // After a scene loads, the sim holds the loaded values but these DOM controls still show the old
  // ones — re-sync them so the panel matches what's now running.
  sandbox.onSceneLoad = () => {
    range.value = String(sandbox.gravityY);
    label.querySelector('b')!.textContent = sandbox.gravityY.toFixed(2);
    tRange.value = String(sandbox.getTimeScale());
    tLabel.querySelector('b')!.textContent = `×${sandbox.getTimeScale().toFixed(1)}`;
    sgRange.value = String(sandbox.selfGravityG);
    sgLabel.querySelector('b')!.textContent = sandbox.selfGravityG.toFixed(1);
    bSelf.classList.toggle('primary', sandbox.selfGravity);
    bAccrete.classList.toggle('primary', sandbox.accretion);
    bBreak.classList.toggle('primary', sandbox.breakage);
    const paused = sandbox.isPaused;
    bPause.textContent = paused ? '▶ Resume' : '⏸ Pause';
    bPause.classList.toggle('primary', paused);
  };
}

/** Scene section: save/load the whole sandbox to a JSON file, plus a one-slot browser quick-save. */
function buildSceneSection(panel: HTMLElement, sandbox: Sandbox) {
  const status = el('div', '', 'preview');
  const say = (msg: string, err = false) => {
    status.className = err ? 'preview err' : 'preview';
    status.textContent = msg;
  };

  const fileRow = el('div', '', 'row');
  const bSave = el('button', '💾 Save file', 'mini');
  const bLoad = el('button', '📂 Load file', 'mini');
  bSave.onclick = () => {
    const data = sandbox.serializeScene();
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    downloadScene(`scene-${stamp}.json`, data);
    say(`Saved ${data.entities.length} objects · ${data.fields.length} fields${data.skipped ? ` (${data.skipped} procedural skipped)` : ''}.`);
  };
  bLoad.onclick = async () => {
    const parsed = await pickSceneFile();
    if (parsed == null) return; // cancelled or unreadable
    if (!isSceneData(parsed)) { say('Not a valid scene file.', true); return; }
    const skipped = sandbox.loadScene(parsed);
    if (skipped < 0) { say('Unsupported scene version.', true); return; }
    say(`Loaded ${parsed.entities.length} objects · ${parsed.fields.length} fields${skipped ? ` (${skipped} weren’t saved)` : ''}.`);
  };
  fileRow.append(bSave, bLoad);

  const quickRow = el('div', '', 'row');
  const bQSave = el('button', '⚡ Quick-save', 'mini');
  const bQLoad = el('button', '↺ Quick-load', 'mini');
  bQSave.onclick = () => {
    try {
      localStorage.setItem(QUICKSAVE_KEY, JSON.stringify(sandbox.serializeScene()));
      say('Quick-saved to this browser (survives refresh).');
    } catch { say('Quick-save failed (storage full?).', true); }
  };
  bQLoad.onclick = () => {
    const raw = localStorage.getItem(QUICKSAVE_KEY);
    if (!raw) { say('No quick-save found.', true); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { say('Quick-save is corrupt.', true); return; }
    if (!isSceneData(parsed)) { say('Quick-save is invalid.', true); return; }
    sandbox.loadScene(parsed);
    say(`Quick-loaded ${parsed.entities.length} objects.`);
  };
  quickRow.append(bQSave, bQLoad);

  const hint = el('div', 'Saves objects, custom shapes, fields, joints & world settings. Accreted planets & debris aren’t saved yet.', 'preview');
  panel.append(fileRow, quickRow, status, hint);
}

function buildShapeCreator(
  panel: HTMLElement, sandbox: Sandbox, materials: MaterialsHook, onLibrary: () => void,
): (e: RevEntry) => void {
  // profile expression: radius as a function of x (the axis), revolved into a solid.
  // A MathLive field — math renders in place as you type, Desmos-style.
  const exprField = el('div', '', 'field');
  const exprLabel = el('label', 'radius <b>r(x)</b>');
  const rev = mathField(REV_PRESETS[0].expr);
  exprField.append(exprLabel, rev.el);
  panel.append(exprField);

  // domain [a, b] + density
  const nums = el('div', '', 'row nums');
  const aInput = numInput(REV_PRESETS[0].a, 'from x');
  const bInput = numInput(REV_PRESETS[0].b, 'to x');
  const dInput = numInput(1, 'density');
  dInput.min = '0.01';
  nums.append(labeled('from', aInput), labeled('to', bInput), labeled('density', dInput));
  panel.append(nums);

  // preset buttons + the full catalog behind "More…"
  const presets = el('div', '', 'row wrap');
  for (const p of REV_PRESETS) {
    const b = el('button', p.name, 'mini');
    b.onclick = () => { rev.set(p.expr); aInput.value = String(p.a); bInput.value = String(p.b); refresh(true); };
    presets.append(b);
  }
  const bMore = el('button', 'More…', 'mini more');
  bMore.onclick = onLibrary;
  presets.append(bMore);
  panel.append(presets);

  // live mass/volume preview (this is the differentiator — exact analytic mass before you drop it)
  const preview = el('div', '', 'preview');
  panel.append(preview);

  const createRow = el('div', '', 'row');
  const bCreate = el('button', 'Create & drop', 'primary');
  createRow.append(bCreate);
  panel.append(createRow);

  const readSpec = () => ({
    expr: rev.value(), a: parseFloat(aInput.value), b: parseFloat(bInput.value),
    density: parseFloat(dInput.value),
  });

  const refresh = (fromUser = false) => {
    const built = buildRevolution(readSpec());
    if (built.ok) {
      const s = built.shape;
      preview.className = 'preview';
      preview.innerHTML = `V ≈ <b>${s.volume.toFixed(2)}</b> m³ · m ≈ <b>${s.mass.toFixed(2)}</b> kg`;
      bCreate.disabled = false;
      getShapePreview().update(s.geometry, `r(x) = ${rev.latex()}`);
      if (fromUser) getShapePreview().show(); // popup opens while designing, not on page load
    } else {
      preview.className = 'preview err';
      preview.textContent = built.error;
      bCreate.disabled = true;
    }
  };
  rev.el.addEventListener('input', () => refresh(true));
  for (const i of [aInput, bInput, dInput]) i.oninput = () => refresh(true);
  materials.onChange((m) => { dInput.value = String(m.density / 1000); refresh(); }); // density follows the material

  bCreate.onclick = () => {
    const res = sandbox.createRevolution(readSpec(), materials.get());
    if (!res.ok) { preview.className = 'preview err'; preview.textContent = res.error; }
  };

  refresh();

  return (e) => {
    panel.parentElement?.classList.remove('collapsed'); // pop the section open so the fields show
    rev.set(e.expr);
    aInput.value = String(e.a);
    bInput.value = String(e.b);
    refresh(true);
  };
}

function buildCurveCreator(
  panel: HTMLElement, sandbox: Sandbox, materials: MaterialsHook, onLibrary: () => void,
): (e: CurveEntry) => void {
  // x(t), y(t), z(t) — a tube swept along the curve (springs, knots, rings).
  // MathLive fields: math renders in place as you type, Desmos-style.
  const fields: Record<'xt' | 'yt' | 'zt', MathField> = {} as never;
  for (const [key, label] of [['xt', 'x(t)'], ['yt', 'y(t)'], ['zt', 'z(t)']] as const) {
    const field = el('div', '', 'field');
    const lab = el('label', `<b>${label}</b>`);
    const mf = mathField('0');
    field.append(lab, mf.el);
    panel.append(field);
    fields[key] = mf;
  }

  const nums = el('div', '', 'row nums');
  const t0Input = numInput(CURVE_PRESETS[0].t0, 'from t');
  const t1Input = numInput(CURVE_PRESETS[0].t1, 'to t');
  const tubeInput = numInput(CURVE_PRESETS[0].tube, 'tube radius');
  tubeInput.min = '0.02';
  const dInput = numInput(1, 'density');
  dInput.min = '0.01';
  nums.append(labeled('from', t0Input), labeled('to', t1Input), labeled('tube', tubeInput), labeled('density', dInput));
  panel.append(nums);

  const applyPreset = (p: (typeof CURVE_PRESETS)[number]) => {
    fields.xt.set(p.xt);
    fields.yt.set(p.yt);
    fields.zt.set(p.zt);
    t0Input.value = String(p.t0);
    t1Input.value = String(p.t1);
    tubeInput.value = String(p.tube);
  };
  applyPreset(CURVE_PRESETS[0]);

  const presets = el('div', '', 'row wrap');
  for (const p of CURVE_PRESETS) {
    const b = el('button', p.name, 'mini');
    b.onclick = () => { applyPreset(p); refresh(true); };
    presets.append(b);
  }
  const bMore = el('button', 'More…', 'mini more');
  bMore.onclick = onLibrary;
  presets.append(bMore);
  panel.append(presets);

  const preview = el('div', '', 'preview');
  panel.append(preview);

  const createRow = el('div', '', 'row');
  const bCreate = el('button', 'Create & drop', 'primary');
  createRow.append(bCreate);
  panel.append(createRow);

  const readSpec = () => ({
    xt: fields.xt.value(), yt: fields.yt.value(), zt: fields.zt.value(),
    t0: parseFloat(t0Input.value), t1: parseFloat(t1Input.value),
    tube: parseFloat(tubeInput.value), density: parseFloat(dInput.value),
  });

  const refresh = (fromUser = false) => {
    const built = buildParamCurve(readSpec());
    if (built.ok) {
      const s = built.shape;
      preview.className = 'preview';
      preview.innerHTML =
        `V ≈ <b>${s.volume.toFixed(2)}</b> m³ · m ≈ <b>${s.mass.toFixed(2)}</b> kg · L ≈ <b>${s.length.toFixed(1)}</b> m`;
      bCreate.disabled = false;
      getShapePreview().update(
        s.geometry,
        `\\left(${fields.xt.latex()},\\; ${fields.yt.latex()},\\; ${fields.zt.latex()}\\right)`,
      );
      if (fromUser) getShapePreview().show();
    } else {
      preview.className = 'preview err';
      preview.textContent = built.error;
      bCreate.disabled = true;
    }
  };
  for (const f of [fields.xt, fields.yt, fields.zt]) f.el.addEventListener('input', () => refresh(true));
  for (const i of [t0Input, t1Input, tubeInput, dInput]) i.oninput = () => refresh(true);
  materials.onChange((m) => { dInput.value = String(m.density / 1000); refresh(); }); // density follows the material

  bCreate.onclick = () => {
    const res = sandbox.createParamCurve(readSpec(), materials.get());
    if (!res.ok) { preview.className = 'preview err'; preview.textContent = res.error; }
  };

  refresh();

  return (e) => {
    panel.parentElement?.classList.remove('collapsed');
    applyPreset(e);
    refresh(true);
  };
}

function buildSurfaceCreator(
  panel: HTMLElement, sandbox: Sandbox, materials: MaterialsHook, onLibrary: () => void,
): (e: SurfEntry) => void {
  // x(u,v), y(u,v), z(u,v) — a sheet in space, dropped in as a thin shell (any surface) or a
  // filled solid (closed surfaces only — auto-detected). MathLive fields, Desmos-style.
  const fields: Record<'xuv' | 'yuv' | 'zuv', MathField> = {} as never;
  for (const [key, label] of [['xuv', 'x(u,v)'], ['yuv', 'y(u,v)'], ['zuv', 'z(u,v)']] as const) {
    const field = el('div', '', 'field');
    const lab = el('label', `<b>${label}</b>`);
    const mf = mathField('0');
    field.append(lab, mf.el);
    panel.append(field);
    fields[key] = mf;
  }

  const domains = el('div', '', 'row nums');
  const u0Input = numInput(0, 'u domain start');
  const u1Input = numInput(6.2832, 'u domain end');
  const v0Input = numInput(0, 'v domain start');
  const v1Input = numInput(6.2832, 'v domain end');
  domains.append(labeled('u from', u0Input), labeled('u to', u1Input), labeled('v from', v0Input), labeled('v to', v1Input));
  panel.append(domains);

  const nums = el('div', '', 'row nums');
  const thickInput = numInput(0.1, 'shell wall thickness');
  thickInput.min = '0.01';
  const dInput = numInput(1, 'density');
  dInput.min = '0.01';
  nums.append(labeled('wall', thickInput), labeled('density', dInput));
  panel.append(nums);

  // shell/solid segmented toggle — hollow vs filled is real physics (2/3·mR² vs 2/5·mR²),
  // so it's a user decision, not an implementation detail
  let mode: 'shell' | 'solid' = 'solid';
  const modeRow = el('div', '', 'row');
  const bShell = el('button', 'Shell (hollow)', 'mini');
  bShell.title = 'A thin wall — works for any surface, open or closed';
  const bSolid = el('button', 'Solid (filled)', 'mini');
  bSolid.title = 'Filled to the brim — needs a closed surface';
  const setMode = (m: 'shell' | 'solid') => {
    mode = m;
    bShell.classList.toggle('primary', m === 'shell');
    bSolid.classList.toggle('primary', m === 'solid');
    thickInput.disabled = m === 'solid'; // wall thickness only means something for a shell
  };
  bShell.onclick = () => { setMode('shell'); refresh(true); };
  bSolid.onclick = () => { setMode('solid'); refresh(true); };
  modeRow.append(bShell, bSolid);
  panel.append(modeRow);

  const applyPreset = (p: (typeof SURFACE_PRESETS)[number]) => {
    fields.xuv.set(p.xuv);
    fields.yuv.set(p.yuv);
    fields.zuv.set(p.zuv);
    u0Input.value = String(p.u0);
    u1Input.value = String(p.u1);
    v0Input.value = String(p.v0);
    v1Input.value = String(p.v1);
    thickInput.value = String(p.thickness);
    setMode(p.mode);
  };
  applyPreset(SURFACE_PRESETS[0]);

  const presets = el('div', '', 'row wrap');
  for (const p of SURFACE_PRESETS) {
    const b = el('button', p.name, 'mini');
    b.onclick = () => { applyPreset(p); refresh(true); };
    presets.append(b);
  }
  const bMore = el('button', 'More…', 'mini more');
  bMore.onclick = onLibrary;
  presets.append(bMore);
  panel.append(presets);

  const preview = el('div', '', 'preview');
  panel.append(preview);

  const createRow = el('div', '', 'row');
  const bCreate = el('button', 'Create & drop', 'primary');
  createRow.append(bCreate);
  panel.append(createRow);

  const readSpec = () => ({
    xuv: fields.xuv.value(), yuv: fields.yuv.value(), zuv: fields.zuv.value(),
    u0: parseFloat(u0Input.value), u1: parseFloat(u1Input.value),
    v0: parseFloat(v0Input.value), v1: parseFloat(v1Input.value),
    mode, thickness: parseFloat(thickInput.value), density: parseFloat(dInput.value),
  });

  const refresh = (fromUser = false) => {
    const built = buildParamSurface(readSpec());
    if (built.ok) {
      const s = built.shape;
      preview.className = 'preview';
      preview.innerHTML =
        `A ≈ <b>${s.area.toFixed(2)}</b> m² · V ≈ <b>${s.volume.toFixed(2)}</b> m³ · ` +
        `m ≈ <b>${s.mass.toFixed(2)}</b> kg · ${s.closed ? 'closed' : 'open'}`;
      bCreate.disabled = false;
      getShapePreview().update(
        s.geometry,
        `\\left(${fields.xuv.latex()},\\; ${fields.yuv.latex()},\\; ${fields.zuv.latex()}\\right)`,
      );
      if (fromUser) getShapePreview().show();
    } else {
      preview.className = 'preview err';
      preview.textContent = built.error;
      bCreate.disabled = true;
    }
  };
  for (const f of [fields.xuv, fields.yuv, fields.zuv]) f.el.addEventListener('input', () => refresh(true));
  for (const i of [u0Input, u1Input, v0Input, v1Input, thickInput, dInput]) i.oninput = () => refresh(true);
  materials.onChange((m) => { dInput.value = String(m.density / 1000); refresh(); }); // density follows the material

  bCreate.onclick = () => {
    const res = sandbox.createParamSurface(readSpec(), materials.get());
    if (!res.ok) { preview.className = 'preview err'; preview.textContent = res.error; }
  };

  refresh();

  return (e) => {
    panel.parentElement?.classList.remove('collapsed');
    applyPreset(e);
    refresh(true);
  };
}

function buildImplicitCreator(
  panel: HTMLElement, sandbox: Sandbox, materials: MaterialsHook, onLibrary: () => void,
): (e: ImpEntry) => void {
  // f(x,y,z) — the object is everywhere f < 0, trimmed to a cube of half-extent `size`.
  // The heaviest creator (a 64³ field per rebuild), so edits are debounced.
  const field = el('div', '', 'field');
  const lab = el('label', '<b>f(x,y,z)</b> <span>&lt; 0 inside</span>');
  const mf = mathField(IMPLICIT_PRESETS[0].fxyz);
  field.append(lab, mf.el);
  panel.append(field);

  const nums = el('div', '', 'row nums');
  const sizeInput = numInput(IMPLICIT_PRESETS[0].size, 'domain half-size (cube)');
  sizeInput.min = '0.2';
  const dInput = numInput(1, 'density');
  dInput.min = '0.01';
  nums.append(labeled('size', sizeInput), labeled('density', dInput));
  panel.append(nums);

  const presets = el('div', '', 'row wrap');
  for (const p of IMPLICIT_PRESETS) {
    const b = el('button', p.name, 'mini');
    b.onclick = () => { mf.set(p.fxyz); sizeInput.value = String(p.size); refresh(true); };
    presets.append(b);
  }
  const bMore = el('button', 'More…', 'mini more');
  bMore.onclick = onLibrary;
  presets.append(bMore);
  panel.append(presets);

  const preview = el('div', '', 'preview');
  panel.append(preview);

  const createRow = el('div', '', 'row');
  const bCreate = el('button', 'Create & drop', 'primary');
  createRow.append(bCreate);
  panel.append(createRow);

  const readSpec = () => ({
    fxyz: mf.value(), iso: 0,
    size: parseFloat(sizeInput.value), density: parseFloat(dInput.value),
  });

  const refresh = (fromUser = false) => {
    const built = buildImplicit(readSpec());
    if (built.ok) {
      const s = built.shape;
      preview.className = 'preview';
      preview.innerHTML = `V ≈ <b>${s.volume.toFixed(2)}</b> m³ · m ≈ <b>${s.mass.toFixed(2)}</b> kg`;
      bCreate.disabled = false;
      getShapePreview().update(s.geometry, `${mf.latex()} < 0`);
      if (fromUser) getShapePreview().show();
    } else {
      preview.className = 'preview err';
      preview.textContent = built.error;
      bCreate.disabled = true;
    }
  };
  let timer = 0;
  const refreshSoon = () => { clearTimeout(timer); timer = window.setTimeout(() => refresh(true), 140); };
  mf.el.addEventListener('input', refreshSoon);
  for (const i of [sizeInput, dInput]) i.oninput = refreshSoon;
  materials.onChange((m) => { dInput.value = String(m.density / 1000); refresh(); }); // density follows the material

  bCreate.onclick = () => {
    const res = sandbox.createImplicit(readSpec(), materials.get());
    if (!res.ok) { preview.className = 'preview err'; preview.textContent = res.error; }
  };

  refresh();

  return (e) => {
    panel.parentElement?.classList.remove('collapsed');
    mf.set(e.fxyz);
    sizeInput.value = String(e.size);
    refresh(true);
  };
}

/** Tools section: the left-click mode (Grab / Connect / Freeze / Push) + the joint-type picker. */
function buildToolsSection(panel: HTMLElement, sandbox: Sandbox) {
  const toolDefs: Array<[Tool, string]> = [['grab', 'Grab'], ['connect', 'Connect'], ['freeze', 'Freeze'], ['push', 'Push'], ['blow', 'Blow'], ['duplicate', 'Duplicate'], ['brush', 'Brush']];
  const toolHints: Record<Tool, string> = {
    grab: 'Left-drag an object to move & throw it.',
    connect: 'Click two objects to link them, using the joint below.',
    freeze: 'Click an object to pin it in place; click again to release.',
    push: 'Click an object to shove it away from the camera.',
    blow: 'Click anywhere for a one-shot gust that scatters nearby objects.',
    duplicate: 'Click an object to drop an independent copy beside it.',
    brush: 'Hold & drag to push / pull / swirl nearby objects, using the mode below.',
  };
  const hint = el('div', '', 'preview');
  const jointRow = el('div', '', 'row wrap');
  const brushRow = el('div', '', 'row wrap');
  const toolBtns = {} as Record<Tool, HTMLButtonElement>;

  // hinge motor: a live spin speed applied to every hinge (existing + new) — motorized doors/wheels.
  // Only relevant while the Connect tool is set to Hinge, so the row hides otherwise.
  const motorRow = el('div', '', 'field');
  const motorLabel = el('label', 'Hinge motor <b>0.0</b> rad/s');
  const motorRange = el('input');
  motorRange.type = 'range'; motorRange.min = '-6'; motorRange.max = '6'; motorRange.step = '0.2'; motorRange.value = '0';
  motorRange.oninput = () => {
    const v = parseFloat(motorRange.value);
    sandbox.setHingeMotorSpeed(v);
    motorLabel.querySelector('b')!.textContent = v.toFixed(1);
  };
  motorRow.append(motorLabel, motorRange);
  const syncMotorRow = () => {
    motorRow.style.display = sandbox.tool === 'connect' && sandbox.jointKind === 'edge' ? '' : 'none';
  };

  const setTool = (t: Tool) => {
    sandbox.setTool(t);
    for (const k of Object.keys(toolBtns) as Tool[]) toolBtns[k].classList.toggle('primary', k === t);
    hint.textContent = toolHints[t];
    jointRow.style.display = t === 'connect' ? '' : 'none'; // joint picker only matters for Connect
    brushRow.style.display = t === 'brush' ? '' : 'none'; // brush-mode chips only matter for Brush
    syncMotorRow();
  };

  const toolRow = el('div', '', 'row wrap');
  for (const [t, label] of toolDefs) {
    const b = el('button', label, 'mini');
    b.onclick = () => setTool(t);
    toolBtns[t] = b;
    toolRow.append(b);
  }
  panel.append(toolRow);

  const jointBtns = {} as Record<JointKind, HTMLButtonElement>;
  const setJoint = (k: JointKind) => {
    sandbox.setJointKind(k);
    for (const kk of Object.keys(jointBtns) as JointKind[]) jointBtns[kk].classList.toggle('on', kk === k);
    syncMotorRow(); // the motor slider only applies to hinges
  };
  for (const k of Object.keys(JOINT_INFO) as JointKind[]) {
    const b = el('button', JOINT_INFO[k].label, 'mini chip');
    b.onclick = () => setJoint(k);
    jointBtns[k] = b;
    jointRow.append(b);
  }

  const brushDefs: Array<[BrushMode, string]> = [['push', 'Push'], ['pull', 'Pull'], ['swirl', 'Swirl']];
  const brushBtns = {} as Record<BrushMode, HTMLButtonElement>;
  const setBrush = (m: BrushMode) => {
    sandbox.setBrushMode(m);
    for (const mm of Object.keys(brushBtns) as BrushMode[]) brushBtns[mm].classList.toggle('on', mm === m);
  };
  for (const [m, label] of brushDefs) {
    const b = el('button', label, 'mini chip');
    b.onclick = () => setBrush(m);
    brushBtns[m] = b;
    brushRow.append(b);
  }

  panel.append(jointRow, motorRow, brushRow, hint);
  setJoint(sandbox.jointKind);
  setBrush(sandbox.brush);
  setTool('grab');
}

/** Fields section: add attractor/repeller/wind/vortex at the camera focus, a strength slider, clear. */
/**
 * Fields panel. Picking a kind spawns a translucent HOLOGRAM at the view centre that exerts no force
 * until you confirm it — position it with the gizmo or the keyboard, then Enter to place, Esc to bail.
 * Every field is confined to a region you can SHAPE (sphere/box/cylinder), size, orient, and HIDE
 * (invisible but still acting). The field list lets you re-select any field — even a hidden one.
 */
function buildFieldsSection(panel: HTMLElement, sandbox: Sandbox) {
  const addRow = el('div', '', 'row wrap');
  for (const k of Object.keys(FIELD_INFO) as FieldKind[]) {
    const b = el('button', FIELD_INFO[k].label, 'mini');
    b.onclick = () => sandbox.beginPlace(k);
    addRow.append(b);
  }
  panel.append(addRow);

  // --- quick scenes: one-click, pre-tuned fun setups (a preset beats hand-configuring every time) ---
  const quickRow = el('div', '', 'row wrap');
  type Quick = { label: string; kind: FieldKind; shape?: FieldShape; size: [number, number, number]; y: number; strength: number };
  // NB region centres are LOW so each region is sunk well into the floor: the influence smoothstep
  // fades over the outer 45% of a region, so a region that merely touches the floor exerts ~2% of its
  // force on floor bodies (measured — the tornado looked dead until it was sunk).
  // (no 🌪 here — Tornado is a full field kind now, so its own button already places one; a quick
  // entry too made TWO tornado buttons, which read as a duplicate. Wind tunnel & Black hole stay as
  // quick tunings of wind/gravitywell until they graduate to custom kinds of their own.)
  const quicks: Quick[] = [
    { label: '🌬 Wind tunnel', kind: 'wind', shape: 'box', size: [14, 4, 8], y: 2, strength: 10 },
    { label: '🕳 Black hole', kind: 'gravitywell', size: [14, 14, 14], y: 8, strength: 25 },
  ];
  for (const q of quicks) {
    const b = el('button', q.label, 'mini');
    b.onclick = () => {
      // opens a pre-configured GHOST — same commit-or-cancel flow as every field, so nothing goes
      // live until you position it and press Place/Enter (a quick scene must still be editable first)
      sandbox.beginPlace(q.kind);
      const rec = sandbox.activeField!;
      if (q.shape) sandbox.setFieldShape(rec, q.shape);
      sandbox.setFieldSize(rec, new THREE.Vector3(...q.size));
      sandbox.setFieldStrengthOf(rec, q.strength);
      rec.field.pos.y = q.y;
      rec.marker.position.copy(rec.field.pos); // marker follows (setting pos alone doesn't move it)
    };
    quickRow.append(b);
  }
  panel.append(quickRow);

  // --- draw a flow: opens a movable, resizable mini 3D editor window to sketch a flow curve ---
  const drawStartRow = el('div', '', 'row');
  const bDrawStart = el('button', '✎ Draw a flow', 'mini');
  let pad: DrawPad | null = null;
  bDrawStart.onclick = () => { (pad ??= new DrawPad(sandbox)).open(); };
  drawStartRow.append(bDrawStart);
  panel.append(drawStartRow);

  // --- list of live fields (click to select; eye toggles visibility, works on hidden ones too) ---
  const list = el('div', '', 'fieldlist');
  panel.append(list);

  // --- editor for the active field (the ghost being placed, or a live one you clicked) ---
  const editor = el('div', '', 'hidden');
  const title = el('div', '', 'preview');

  const shapeRow = el('div', '', 'row wrap');
  const shapeBtns = {} as Record<FieldShape, HTMLButtonElement>;
  for (const sh of FIELD_SHAPES) {
    const b = el('button', sh[0].toUpperCase() + sh.slice(1), 'mini');
    b.onclick = () => { const r = sandbox.activeField; if (r) sandbox.setFieldShape(r, sh); };
    shapeBtns[sh] = b;
    shapeRow.append(b);
  }

  const sizeRow = el('div', '', 'row nums');
  const szA = numInput(1, 'size'), szB = numInput(1, 'size'), szC = numInput(1, 'size');
  const wrapA = labeled('r', szA), wrapB = labeled('y', szB), wrapC = labeled('z', szC);
  sizeRow.append(wrapA, wrapB, wrapC);

  // path-field controls (shown only for a Path field): which flow curve, its scale + tube, its swirl.
  // These edit the DRAFT (a preview that exerts no force) — the live field only changes when you Apply.
  type Spec = { xt: string; yt: string; zt: string; t0: number; t1: number };
  const applySpec = (spec: Spec, label: string) => {
    const r = sandbox.activeField; if (r) sandbox.setPathSpec(r, spec, label);
  };
  // mirror a curve's equations into the f(t) inputs (so the editor always reflects the real field)
  const setCurveFields = (spec: Spec) => {
    mf.xt.set(spec.xt); mf.yt.set(spec.yt); mf.zt.set(spec.zt);
    ct0.value = String(spec.t0); ct1.value = String(spec.t1);
    customErr.textContent = '';
  };
  const pickCurve = (spec: Spec, label: string) => { setCurveFields(spec); applySpec(spec, label); };
  const pathRow = el('div', '', 'row wrap');
  const pathBtns: Record<string, HTMLButtonElement> = {};
  for (const key of PATH_PRESET_KEYS) {
    const p = PATH_PRESETS[key];
    const b = el('button', p.label, 'mini');
    b.onclick = () => pickCurve({ xt: p.xt, yt: p.yt, zt: p.zt, t0: p.t0, t1: p.t1 }, p.label);
    pathBtns[key] = b;
    pathRow.append(b);
  }
  // "More…" opens a library of ~100 curves; "f(t)" reveals the custom-equation editor
  const bMore = el('button', 'More…', 'mini more');
  const bCustom = el('button', 'f(t)', 'mini');
  pathRow.append(bMore, bCustom);

  const pathNums = el('div', '', 'row nums');
  const scaleIn = numInput(3, 'Overall size of the flow curve');
  const tubeIn = numInput(2.5, 'Capture radius — bodies inside this tube ride the flow');
  const swirlIn = numInput(0, 'Swirl around the path (0 = flow along it, ~1 = corkscrew)');
  pathNums.append(labeled('curve size', scaleIn), labeled('tube', tubeIn), labeled('swirl', swirlIn));

  // Lift: suspend gravity inside the tube so bodies can ride a 3D curve up into the air (Lissajous,
  // rising spirals) instead of dropping out the bottom. Off by default — flat flows don't need it.
  const pathLift = el('div', '', 'row wrap');
  const liftBtn = el('button', 'Lift', 'mini');
  liftBtn.title = 'Suspend gravity inside the tube so bodies follow a 3D curve up (not just flat flows).';
  liftBtn.onclick = () => { const r = sandbox.activeField; if (r) sandbox.setPathLift(r, !r.field.lift); };
  pathLift.append(liftBtn);

  // custom-equation editor: type your own x(t), y(t), z(t) (Desmos-style MathLive, only "t" allowed).
  // It PREVIEWS live as you type — the draft curve redraws on every valid edit (no Apply-to-see step).
  const customBox = el('div', '', 'hidden');
  const mf = { xt: mathField('cos(t)'), yt: mathField('0'), zt: mathField('sin(t)') };
  for (const [key, label] of [['xt', 'x(t)'], ['yt', 'y(t)'], ['zt', 'z(t)']] as const) {
    const f = el('div', '', 'field');
    f.append(el('label', `<b>${label}</b>`), mf[key].el);
    customBox.append(f);
  }
  const customT = el('div', '', 'row nums');
  const ct0 = numInput(0, 'from t'), ct1 = numInput(6.283, 'to t');
  customT.append(labeled('from t', ct0), labeled('to t', ct1));
  const customErr = el('div', '', 'preview');
  customBox.append(customT, customErr);
  bCustom.onclick = () => customBox.classList.toggle('hidden');

  // live preview: re-sample the draft curve as the equations are typed (debounced so fast typing is
  // cheap). A partial/invalid expression just leaves the last good curve up and flags the status line.
  let customTimer = 0;
  const applyCustom = () => {
    const r = sandbox.activeField; if (!r) return;
    const spec: Spec = { xt: mf.xt.value(), yt: mf.yt.value(), zt: mf.zt.value(), t0: parseFloat(ct0.value) || 0, t1: parseFloat(ct1.value) || 6.283 };
    const ok = sandbox.setPathSpec(r, spec, 'custom');
    customErr.className = ok ? 'preview' : 'preview err';
    customErr.textContent = ok ? 'curve updated' : 'Could not parse — check the equations (only “t” is allowed).';
  };
  const applyCustomSoon = () => { clearTimeout(customTimer); customTimer = window.setTimeout(applyCustom, 200); };
  for (const k of ['xt', 'yt', 'zt'] as const) mf[k].el.addEventListener('input', applyCustomSoon);
  ct0.oninput = applyCustomSoon; ct1.oninput = applyCustomSoon;

  // the curve library popup (the "More…" 100-curve picker), grouped like the shape library
  const lib = el('div', '', 'hidden'); lib.id = 'curve-library';
  const libClose = el('button', '×'); libClose.onclick = () => lib.classList.add('hidden');
  const libHead = el('header', '<span>Flow curves</span>'); libHead.append(libClose);
  const libBody = el('div', '', 'libbody');
  const libPage = el('div', '', 'libpage');
  { // populate grouped, clicking applies the curve to the active path field and closes
    const groups = new Map<string, typeof CURVE_CATALOG>();
    for (const e of CURVE_CATALOG) { const g = groups.get(e.group) ?? []; g.push(e); groups.set(e.group, g); }
    for (const [group, list] of groups) {
      libPage.append(el('h4', group));
      const row = el('div', '', 'row wrap');
      for (const e of list) {
        const b = el('button', e.name, 'mini');
        b.onclick = () => { pickCurve({ xt: e.xt, yt: e.yt, zt: e.zt, t0: e.t0, t1: e.t1 }, e.name); lib.classList.add('hidden'); };
        row.append(b);
      }
      libPage.append(row);
    }
  }
  libBody.append(libPage);
  lib.append(libHead, libBody);
  document.body.append(lib);
  makeFloating(lib, 'header');
  bMore.onclick = () => lib.classList.remove('hidden');

  const strRow = el('div', '', 'row');
  const sIn = numInput(1, 'This field’s own strength');
  const strWrap = labeled('strength', sIn);
  strRow.append(strWrap);

  const hint = el('div', '', 'preview');
  const btns = el('div', '', 'row wrap');
  const bHide = el('button', 'Hide', 'mini');
  const bFit = el('button', 'Fit to objects', 'mini');
  bFit.title = 'Centre and size this field to reach the whole crowd of objects.';
  bFit.onclick = () => { const r = sandbox.activeField; if (r) sandbox.fitFieldToObjects(r); };
  const bReverse = el('button', '⇄ Reverse flow', 'mini');
  bReverse.title = 'Mirror this field’s flow direction (clockwise ↔ counter-clockwise / forwards ↔ backwards).';
  bReverse.onclick = () => { const r = sandbox.activeField; if (r) sandbox.setFieldDir(r, (r.field.dir ?? 1) === 1 ? -1 : 1); };
  const bSole = el('button', '☉ Sole gravity', 'mini');
  bSole.title = 'Make this well’s centre the only gravity inside its region — world gravity is fully off there, so “down” is toward the well. Other wells and attractors still add their own pull.';
  bSole.onclick = () => { const r = sandbox.activeField; if (r) sandbox.setFieldSole(r, !r.field.sole); };
  const bPlace = el('button', 'Place', 'mini');
  const bCancel = el('button', 'Cancel', 'mini');
  const bDelete = el('button', 'Delete field', 'danger');
  btns.append(bHide, bFit, bReverse, bSole, bPlace, bCancel, bDelete);
  editor.append(title, shapeRow, sizeRow, pathRow, pathNums, pathLift, customBox, strRow, hint, btns);
  panel.append(editor);

  const info = el('div', '', 'preview');
  const updateInfo = () => {
    info.textContent = sandbox.fieldCount
      ? `${sandbox.fieldCount} field(s) live — click one in the list or its core dot to edit it.`
      : 'No fields yet. Pick one above, position the hologram, then press Enter.';
  };

  const applyStrength = () => {
    const rec = sandbox.activeField;
    if (rec) sandbox.setFieldStrengthOf(rec, parseFloat(sIn.value) || 0);
  };
  const applySize = () => {
    const rec = sandbox.activeField;
    if (!rec) return;
    const s = rec.field.size;
    const a = parseFloat(szA.value) || s.x, b = parseFloat(szB.value) || s.y, c = parseFloat(szC.value) || s.z;
    const v = rec.field.shape === 'box' ? new THREE.Vector3(a, b, c)
      : rec.field.shape === 'cylinder' ? new THREE.Vector3(a, b, a) // radius, ½height, radius
        : new THREE.Vector3(a, a, a); // sphere: uniform radius
    sandbox.setFieldSize(rec, v);
  };
  sIn.oninput = applyStrength;
  for (const i of [szA, szB, szC]) i.oninput = applySize;
  scaleIn.oninput = () => { const r = sandbox.activeField; if (r) sandbox.setPathScale(r, parseFloat(scaleIn.value) || 1); };
  tubeIn.oninput = () => { const r = sandbox.activeField; if (r) sandbox.setFieldSize(r, new THREE.Vector3().setScalar(parseFloat(tubeIn.value) || r.field.size.x)); };
  swirlIn.oninput = () => { const r = sandbox.activeField; if (r) sandbox.setPathSwirl(r, parseFloat(swirlIn.value) || 0); };
  bHide.onclick = () => { const r = sandbox.activeField; if (r) sandbox.setFieldHidden(r, !r.field.hidden); };
  bPlace.onclick = () => sandbox.commitPlace();
  bCancel.onclick = () => sandbox.cancelPlace();
  bDelete.onclick = () => sandbox.removeActiveField();

  const renderList = () => {
    list.innerHTML = '';
    for (const rec of sandbox.fieldList) {
      const row = el('div', '', 'fieldrow');
      if (rec === sandbox.editingField) row.classList.add('on');
      const dot = `<i class="dot" style="background:#${FIELD_INFO[rec.field.kind].color.toString(16).padStart(6, '0')}"></i>`;
      const sub = rec.field.kind === 'path' ? rec.field.path!.label : rec.field.shape;
      const name = el('button', `${dot}${FIELD_INFO[rec.field.kind].label} · ${sub}`, 'flabel');
      name.onclick = () => sandbox.beginEdit(rec);
      const eye = el('button', rec.field.hidden ? 'show' : 'hide', 'mini eye');
      eye.onclick = (e) => { e.stopPropagation(); sandbox.setFieldHidden(rec, !rec.field.hidden); };
      row.append(name, eye);
      list.append(row);
    }
  };

  const sizeLabels = (shape: FieldShape) => {
    // relabel + show only the inputs this shape needs
    const set = (wrap: HTMLElement, input: HTMLInputElement, label: string, val: number, show: boolean) => {
      wrap.classList.toggle('hidden', !show);
      (wrap.firstChild as Text).textContent = label;
      if (document.activeElement !== input) input.value = String(+val.toFixed(2));
    };
    const rec = sandbox.activeField!;
    const s = rec.field.size;
    if (shape === 'sphere') { set(wrapA, szA, 'radius', s.x, true); set(wrapB, szB, 'y', s.y, false); set(wrapC, szC, 'z', s.z, false); }
    else if (shape === 'cylinder') { set(wrapA, szA, 'radius', s.x, true); set(wrapB, szB, '½ height', s.y, true); set(wrapC, szC, 'z', s.z, false); }
    else { set(wrapA, szA, 'x', s.x, true); set(wrapB, szB, 'y', s.y, true); set(wrapC, szC, 'z', s.z, true); }
  };

  let shownField: FieldRec | null = null; // which field the equation/number inputs were last filled for
  const refresh = () => {
    const rec = sandbox.activeField;
    updateInfo();
    renderList();
    editor.classList.toggle('hidden', !rec);
    if (!rec) { shownField = null; return; }
    // A different field just became active (a new draft/ghost) → mirror ITS settings into the inputs,
    // so the editor always reflects the real field (never leaves a stale equation from the last one).
    // We do this only on identity change so live typing isn't clobbered by the refresh it triggers.
    if (rec !== shownField) {
      shownField = rec;
      if (rec.field.path) setCurveFields(rec.field.path.spec);
    }
    const editing = sandbox.isEditing; // editing a live field via a draft (vs placing a brand-new one)
    const placing = sandbox.isPlacing; // true for both — the editor always drives a draft/ghost
    const bad = !sandbox.placementValid;
    const isPath = rec.field.kind === 'path';
    title.innerHTML = `${editing ? 'Editing' : 'Placing'} <b>${FIELD_INFO[rec.field.kind].label}</b>`
      + (rec.field.hidden ? ' · <b>hidden</b>' : '')
      + (bad ? ' · <b style="color:#dc4a4a">off-world / below floor</b>' : '');
    // path fields swap the shape/size controls for the flow-curve controls
    shapeRow.classList.toggle('hidden', isPath);
    sizeRow.classList.toggle('hidden', isPath);
    pathRow.classList.toggle('hidden', !isPath);
    pathNums.classList.toggle('hidden', !isPath);
    pathLift.classList.toggle('hidden', !isPath);
    liftBtn.classList.toggle('primary', !!rec.field.lift);
    if (!isPath) customBox.classList.add('hidden'); // never leave the equation editor up on a non-path
    (strWrap.firstChild as Text).textContent = isPath ? 'flow m/s'
      : rec.field.kind === 'gravitywell' ? 'mass'
        : rec.field.kind === 'magnetic' ? 'turn rate'
          : rec.field.kind === 'drag' ? 'damping'
            : rec.field.kind === 'fluid' ? 'density'
              : 'speed m/s';
    if (isPath) {
      const pf = rec.field.path!;
      for (const key of PATH_PRESET_KEYS) pathBtns[key].classList.toggle('on', pf.label === PATH_PRESETS[key].label);
      if (document.activeElement !== scaleIn) scaleIn.value = String(+pf.scale.toFixed(2));
      if (document.activeElement !== tubeIn) tubeIn.value = String(+rec.field.size.x.toFixed(2));
      if (document.activeElement !== swirlIn) swirlIn.value = String(+pf.swirl.toFixed(2));
    } else {
      for (const sh of FIELD_SHAPES) shapeBtns[sh].classList.toggle('on', rec.field.shape === sh);
      sizeLabels(rec.field.shape);
    }
    if (document.activeElement !== sIn) sIn.value = String(+rec.field.strength.toFixed(2));
    bHide.textContent = rec.field.hidden ? 'Show' : 'Hide';
    // reverse-flow only exists for kinds with a flow direction to mirror
    const hasFlow = ['vortex', 'tornado', 'gravitywell', 'path'].includes(rec.field.kind);
    bReverse.classList.toggle('hidden', !hasFlow);
    bReverse.classList.toggle('on', (rec.field.dir ?? 1) === -1);
    // sole-gravity is a gravity-well concept only
    bSole.classList.toggle('hidden', rec.field.kind !== 'gravitywell');
    bSole.classList.toggle('on', !!rec.field.sole);
    const p = rec.field.pos;
    const lock = sandbox.lockedAxis;
    const canRotate = rec.field.kind === 'wind' || rec.field.kind === 'magnetic' || isPath || rec.field.shape !== 'sphere';
    const aimKind = rec.field.kind === 'wind' || rec.field.kind === 'magnetic';
    hint.innerHTML =
      `x ${p.x.toFixed(1)} · y ${p.y.toFixed(1)} · z ${p.z.toFixed(1)}`
      + (lock ? ` · <b>${lock.toUpperCase()} locked</b>` : '')
      + (sandbox.gizmoMode === 'rotate' ? ' · <b>turning</b>' : '')
      + '<br><b>X/Y/Z</b> lock · <b>arrows</b>/<b>PgUp</b>/<b>PgDn</b> nudge · <b>Shift</b> fine'
      + (canRotate ? ` · <b>R</b> ${aimKind ? 'aim' : 'turn'}` : '')
      + (editing ? '<br><b>Enter</b> apply · <b>Esc</b> cancel · <b>Del</b> delete' : '<br><b>Enter</b> place · <b>Esc</b> cancel');
    // one Apply/Place gate: edits only reach the live field here (nothing mutates the sim mid-edit)
    bPlace.textContent = editing ? 'Apply' : rec.field.kind === 'explosion' ? '💥 Detonate' : 'Place';
    bPlace.classList.toggle('hidden', !placing);
    bCancel.classList.toggle('hidden', !placing);
    bDelete.classList.toggle('hidden', !editing); // only a live field can be deleted
    bPlace.disabled = bad;
  };
  sandbox.onFieldChange = refresh;

  const sField = el('div', '', 'field');
  const sLabel = el('label', 'Global strength <b>1.0</b>'); // multiplies every field at once
  const sRange = el('input');
  sRange.type = 'range'; sRange.min = '0'; sRange.max = '3'; sRange.step = '0.1'; sRange.value = '1';
  sRange.oninput = () => {
    const v = parseFloat(sRange.value);
    sandbox.setFieldStrength(v);
    sLabel.querySelector('b')!.textContent = v.toFixed(1);
  };
  sField.append(sLabel, sRange);
  panel.append(sField);

  // toggle the glowing flow tracers that make each field's force visible (on by default)
  const flowRow = el('div', '', 'row');
  const bFlow = el('button', '✦ Flow tracers', 'mini primary');
  bFlow.onclick = () => {
    const on = !sandbox.flowViz;
    sandbox.setFlowViz(on);
    bFlow.classList.toggle('primary', on);
  };
  flowRow.append(bFlow);
  panel.append(flowRow);

  const clearRow = el('div', '', 'row');
  const bClear = el('button', 'Clear fields', 'danger');
  bClear.onclick = () => sandbox.clearFields();
  clearRow.append(bClear);
  panel.append(info, clearRow);
  refresh();
}

function numInput(value: number, title: string): HTMLInputElement {
  const i = document.createElement('input');
  i.type = 'number';
  i.step = '0.1';
  i.value = String(value);
  i.title = title;
  i.autocomplete = 'off';
  return i;
}

function labeled(label: string, input: HTMLInputElement): HTMLElement {
  const wrap = el('label', '', 'numcol');
  wrap.append(document.createTextNode(label), input);
  return wrap;
}

function buildHud(sandbox: Sandbox) {
  const hud = document.getElementById('hud')!;
  hud.append(el('div', 'Physics Sandbox', 'title'));
  const stats = el('div', '');
  hud.append(stats);
  const awake = (): number => sandbox.entities.reduce((n, e) => n + (e.body.isSleeping() ? 0 : 1), 0);
  setInterval(() => {
    stats.innerHTML =
      `<b>${Math.round(sandbox.fps)}</b> fps · <b>${sandbox.entities.length}</b> objects · <b>${awake()}</b> awake`;
  }, 120);
}

function buildInspector(sandbox: Sandbox) {
  const box = document.getElementById('inspector')!;
  // static skeleton: live-rewritten content + a persistent action row (so the button keeps its handler)
  const content = el('div');
  // persistent per-object gravity control (survives the innerHTML refresh, so it keeps its handler)
  const gravRow = el('div', '', 'field');
  const gravLabel = el('label', 'Gravity × <b>1.0</b>');
  const gravRange = el('input');
  gravRange.type = 'range'; gravRange.min = '-2'; gravRange.max = '2'; gravRange.step = '0.1'; gravRange.value = '1';
  gravRange.title = '1 = normal · 0 = weightless · negative = floats up (a balloon)';
  gravRange.oninput = () => {
    if (!sandbox.selected) return;
    const v = parseFloat(gravRange.value);
    sandbox.setEntityGravityScale(sandbox.selected, v);
    gravLabel.querySelector('b')!.textContent = v.toFixed(1);
  };
  gravRow.append(gravLabel, gravRange);
  const actions = el('div', '', 'row');
  const bDelete = el('button', 'Delete object', 'danger');
  bDelete.onclick = () => {
    if (sandbox.selected) sandbox.deleteEntity(sandbox.selected);
  };
  actions.append(bDelete);
  box.append(content, gravRow, actions);

  const render = () => {
    const e = sandbox.selected;
    if (!e) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    const v = e.body.linvel();
    const w = e.body.angvel();
    const speed = Math.hypot(v.x, v.y, v.z);
    const spin = Math.hypot(w.x, w.y, w.z);
    const t = e.body.translation();
    const mass = e.body.mass();
    const ke = 0.5 * mass * speed * speed;
    const sizeOrShape = e.kind === 'custom'
      ? prop('volume', `${(e.volume ?? 0).toFixed(2)} m³`)
      : prop('size', `${(e.size * 2).toFixed(2)} m`);
    // swatch shows the material itself: an accreted planet's ACTUAL painted surface (cached
    // thumbnail of its skin), an albedo thumbnail for textured presets, or the color for plain
    const sw = e.skin
      ? `background-image:url('${e.skin.thumbURL()}');background-size:cover`
      : e.mat.maps?.albedo
        ? `background-image:url('${e.mat.maps.albedo}');background-size:cover`
        : `background:#${e.color.getHexString()}`;
    content.innerHTML =
      `<h3><span>Inspector</span><span class="swatch" style="${sw}"></span></h3>` +
      prop('id', `#${e.id} · ${e.kind}`) +
      (e.label ? prop('shape', e.label) : '') +
      prop('position', `${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)}`) +
      prop('speed', `${speed.toFixed(2)} m/s`) +
      prop('angular vel', `${spin.toFixed(2)} rad/s`) +
      prop('mass', `${mass.toFixed(2)} kg`) +
      prop('material', e.mat.name) +
      sizeOrShape +
      prop('kinetic E', `${ke.toFixed(1)} J`) +
      prop('state', e.body.isSleeping() ? 'asleep' : 'awake');
    // sync the gravity slider to this object (unless the user is mid-drag on it)
    if (document.activeElement !== gravRange) {
      const gs = e.gravityScale ?? 1;
      gravRange.value = String(gs);
      gravLabel.querySelector('b')!.textContent = gs.toFixed(1);
    }
  };
  setInterval(render, 100);
}

/**
 * Free-body diagram view, docked directly above the inspector. Shows the selected object in its own
 * mini 3D scene, with the forces acting on it drawn as arrows from its center: weight (red), measured
 * net ΣF = m·a (blue), contact/friction/drag = net − weight (green), and velocity (yellow) for
 * context. Arrow lengths scale with magnitude relative to the strongest current force. When the
 * object is joined to others, the WHOLE connected assembly is rendered — each body in its own
 * material/texture, in its live relative pose — so you see the system it belongs to (the selected
 * body sits at the origin where its force arrows are drawn).
 */
function buildForcesView(sandbox: Sandbox) {
  // dock: a fixed bottom-left column — forces view on top, inspector (moved in) below
  const inspector = document.getElementById('inspector')!;
  const dock = el('div');
  dock.id = 'dock';
  const win = el('div', '', 'hidden');
  win.id = 'forces';
  const head = el('div', 'forces', 'fhead');
  const canvas = document.createElement('canvas');
  const legend = el('div', '', 'flegend');
  win.append(head, canvas, legend);
  dock.append(win, inspector);
  document.body.append(dock);
  makeFloating(win, '.fhead');
  makeFloating(inspector, 'h3'); // delegated — survives the inspector's innerHTML refresh

  // --- mini scene ---
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 214 / 170, 0.1, 500);
  scene.add(new THREE.HemisphereLight('#aab6cc', '#20242e', 0.9));
  const sun = new THREE.DirectionalLight('#ffffff', 1.9);
  sun.position.set(4, 6, 5);
  scene.add(sun);
  // every body in the selected object's connected assembly is rendered under here, each placed in
  // its live pose relative to the selected body (which sits at the group's origin)
  const assembly = new THREE.Group();
  scene.add(assembly);

  let frameR = 1; // radius the camera must fit (assembly + arrow reach)
  const fit = () => {
    camera.aspect = (canvas.clientWidth || 214) / (canvas.clientHeight || 170);
    fitCamera(camera, frameR, 0.55, 0.42, 0.9);
  };
  new ResizeObserver(() => {
    if (!renderer) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    fit();
  }).observe(canvas);

  const ARROW_DEFS = [
    { key: 'weight', color: 0xdc4a4a, label: 'weight m·g' },
    { key: 'net', color: 0x5b8def, label: 'net ΣF = m·a' },
    { key: 'contact', color: 0x4fb89a, label: 'contact/drag' },
    { key: 'velocity', color: 0xc9bb3a, label: 'velocity' },
  ] as const;
  const arrows: Record<string, THREE.ArrowHelper> = {};
  for (const d of ARROW_DEFS) {
    const a = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, d.color);
    a.visible = false;
    scene.add(a); // arrows live at the origin, where the selected body is placed
    arrows[d.key] = a;
  }

  // one rendered body per assembly member; rebuilt only when the membership set changes
  interface Part { e: Entity; mesh: THREE.Mesh; own: boolean; radius: number }
  let parts: Part[] = [];
  let assemblyKey = ''; // sorted entity ids currently built

  const geometryFor = (e: Entity): { geo: THREE.BufferGeometry; own: boolean } => {
    if (e.kind === 'custom') return { geo: e.mesh!.geometry, own: false }; // shared — never dispose
    if (e.kind === 'box') return { geo: new THREE.BoxGeometry(e.size * 2, e.size * 2, e.size * 2), own: true };
    return { geo: new THREE.SphereGeometry(e.size, 48, 32), own: true };
  };

  const rebuild = (list: Entity[]) => {
    for (const p of parts) {
      assembly.remove(p.mesh);
      if (p.own) p.mesh.geometry.dispose();
      (p.mesh.material as THREE.Material).dispose();
    }
    parts = list.map((e) => {
      const { geo, own } = geometryFor(e);
      const mat = sandbox.materialFor(e); // each body wears its own maps + tiling
      mat.side = e.kind === 'custom' && !e.skin ? THREE.DoubleSide : THREE.FrontSide; // open surfaces have two faces
      const mesh = new THREE.Mesh(geo, mat);
      if (e.skin) mesh.scale.setScalar(e.size); // skinned planets are unit geometry × scale
      geo.computeBoundingSphere();
      assembly.add(mesh);
      const r = geo.boundingSphere?.radius ?? Math.max(e.size, 0.2);
      return { e, mesh, own, radius: e.skin ? r * e.size : r };
    });
  };

  const dir = new THREE.Vector3();
  const setArrow = (a: THREE.ArrowHelper, x: number, y: number, z: number, mag: number, maxMag: number, R: number) => {
    if (mag < 1e-3 || maxMag < 1e-3) { a.visible = false; return; }
    a.visible = true;
    a.setDirection(dir.set(x / mag, y / mag, z / mag));
    const len = R * (0.45 + 0.75 * Math.min(mag / maxMag, 1)); // ≤ 1.2·R — arrows read well without dwarfing the shape
    a.setLength(len, len * 0.22, len * 0.12);
  };

  const countContacts = (e: Entity): number => {
    // contactPairsWith yields broad-phase pairs (AABBs overlap), which counts near-misses — an
    // airborne body could show dozens. Only count pairs whose manifold has real contact points.
    let n = 0;
    for (let i = 0; i < e.body.numColliders(); i++) {
      const c = e.body.collider(i);
      sandbox.world.contactPairsWith(c, (other) => {
        let touching = false;
        sandbox.world.contactPair(c, other, (manifold) => { if (manifold.numContacts() > 0) touching = true; });
        if (touching) n++;
      });
    }
    return n;
  };

  const anchor = new THREE.Vector3(); // selected body's world position (the group's origin)
  const rel = new THREE.Vector3();
  let lastText = 0;
  const frame = () => {
    requestAnimationFrame(frame);
    const e = sandbox.selected;
    if (!e) { win.classList.add('hidden'); assemblyKey = ''; return; }
    win.classList.remove('hidden');
    if (!renderer) {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      renderer.setSize(canvas.clientWidth || 214, canvas.clientHeight || 170, false);
      renderer.toneMapping = THREE.ACESFilmicToneMapping; // match the main view's look
      renderer.toneMappingExposure = 1.2;
    }

    const list = sandbox.assemblyOf(e);
    const key = list.map((x) => x.id).sort((p, q) => p - q).join(',');
    if (key !== assemblyKey) { rebuild(list); assemblyKey = key; }

    // place every body in its live pose relative to the selected one, and size the frame to fit them
    anchor.copy(e.currPos);
    let R = 1.2 * Math.max(e.size, 0.2); // room for the selected body's force arrows
    for (const p of parts) {
      rel.copy(p.e.currPos).sub(anchor);
      p.mesh.position.copy(rel);
      p.mesh.quaternion.copy(p.e.currQuat);
      R = Math.max(R, rel.length() + p.radius);
    }
    const wantR = R * 1.12;
    if (Math.abs(wantR - frameR) > frameR * 0.05) { frameR = wantR; fit(); } // refit only on real change

    const m = e.body.mass();
    const g = sandbox.gravityY;
    const Wv = { x: 0, y: m * g, z: 0 };
    const F = { x: m * e.accel.x, y: m * e.accel.y, z: m * e.accel.z };
    const C = { x: F.x - Wv.x, y: F.y - Wv.y, z: F.z - Wv.z }; // net − weight = contact + friction + drag
    const v = e.body.linvel();
    const wMag = Math.abs(Wv.y);
    const fMag = Math.hypot(F.x, F.y, F.z);
    const cMag = Math.hypot(C.x, C.y, C.z);
    const speed = Math.hypot(v.x, v.y, v.z);
    const maxF = Math.max(wMag, fMag, cMag);
    const aR = Math.max(e.size, 0.2);

    setArrow(arrows.weight, Wv.x, Wv.y, Wv.z, wMag, maxF, aR);
    setArrow(arrows.net, F.x, F.y, F.z, fMag, maxF, aR);
    setArrow(arrows.contact, C.x, C.y, C.z, cMag, maxF, aR);
    setArrow(arrows.velocity, v.x, v.y, v.z, speed, Math.max(speed, 8), aR); // own scale — different unit

    renderer.render(scene, camera);

    const now = performance.now();
    if (now - lastText < 100) return;
    lastText = now;
    head.textContent = list.length > 1
      ? `forces · #${e.id} · ${list.length}-body system`
      : `forces · #${e.id} ${e.kind}`;
    const vals = [`${wMag.toFixed(1)} N`, `${fMag.toFixed(1)} N`, `${cMag.toFixed(1)} N`, `${speed.toFixed(2)} m/s`];
    legend.innerHTML =
      ARROW_DEFS.map((d, i) => fleg(d.color, d.label, vals[i])).join('') +
      `<div class="frow"><span>contacts</span><b>${countContacts(e)}${e.body.isSleeping() ? ' · asleep' : ''}</b></div>`;
  };
  frame();
}

function fleg(color: number, label: string, value: string): string {
  const hex = `#${color.toString(16).padStart(6, '0')}`;
  return `<div class="frow"><span><i class="dot" style="background:${hex}"></i>${label}</span><b>${value}</b></div>`;
}

function prop(k: string, v: string): string {
  return `<div class="prop"><span>${k}</span><b>${v}</b></div>`;
}
