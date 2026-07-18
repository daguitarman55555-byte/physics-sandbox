/**
 * DRAW PAD — a floating, resizable window with its own little 3D editor for sketching a flow curve.
 *
 * Opened from the Fields panel. Inside the window you draw with the mouse onto the plane that faces
 * you; the stroke shows as a live line. A colored X/Y/Z gnomon is always visible for orientation, and
 * the X / Y / Z buttons snap the view to look straight down each axis — so you can draw the curve from
 * the front, the side, and the top and build it up in true 3D (drawn points stay put in world space,
 * so turning the view and drawing more just adds depth). Erase rubs points out. Place turns the whole
 * sketch into a live flow (path) field in the main scene via `Sandbox.createDrawnPath`.
 *
 * It renders into its OWN WebGL canvas (like the shape-preview popup) and is completely independent of
 * the main sandbox scene — nothing here touches the physics until you press Place.
 */
import * as THREE from 'three';
import type { Sandbox } from './sandbox';
import { softDot } from './systems/fieldviz';

const UP = new THREE.Vector3(0, 1, 0);
const ORIGIN = new THREE.Vector3(0, 0, 0);
const LINE_COLOR = 0xe0a04f; // the flow-field orange, so the sketch reads as "a path"

/** A tiny colored letter sprite that floats at the tip of an axis (so you can read which is which). */
function axisLabel(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = color;
  ctx.font = 'bold 46px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  sprite.scale.set(1.6, 1.6, 1.6);
  return sprite;
}

export class DrawPad {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 500);
  private grid: THREE.GridHelper;
  private line: THREE.Line;
  private lineGeom = new THREE.BufferGeometry();
  private raycaster = new THREE.Raycaster();
  private plane = new THREE.Plane();
  private pts: THREE.Vector3[] = [];

  private mode: 'draw' | 'erase' = 'draw';
  private az = Math.PI * 0.25; // camera azimuth / polar around the origin (right-drag orbits these)
  private pol = Math.PI * 0.34;
  private radius = 20;
  private drawing = false; // left button held (sketching / erasing)
  private orbiting = false; // right button held (turning the view)
  private lastPtr = { x: 0, y: 0 };
  private raf = 0;

  private modeBtns: Record<'draw' | 'erase', HTMLButtonElement> = {} as never;

  constructor(private sandbox: Sandbox) {
    this.root = document.createElement('div');
    this.root.id = 'drawpad';
    this.root.className = 'hidden';

    const header = document.createElement('header');
    header.innerHTML = '<span>Draw a flow</span>';
    const close = this.btn('×', 'x');
    close.onclick = () => this.close();
    header.append(close);

    // top toolbar: axis-view snaps + the always-on gnomon note, then the draw/erase mode
    const viewRow = document.createElement('div');
    viewRow.className = 'dp-row';
    viewRow.append(this.label('view:'));
    for (const ax of ['x', 'y', 'z'] as const) {
      const b = this.btn(ax.toUpperCase(), `ax ax-${ax}`);
      b.onclick = () => this.snapView(ax);
      viewRow.append(b);
    }
    const spin = this.btn('⟳', 'ax');
    spin.title = 'Reset to a 3/4 view';
    spin.onclick = () => { this.az = Math.PI * 0.25; this.pol = Math.PI * 0.34; this.updateCamera(); };
    viewRow.append(spin);

    const modeRow = document.createElement('div');
    modeRow.className = 'dp-row';
    modeRow.append(this.label('tool:'));
    for (const m of ['draw', 'erase'] as const) {
      const b = this.btn(m[0].toUpperCase() + m.slice(1), 'chip');
      b.onclick = () => this.setMode(m);
      this.modeBtns[m] = b;
      modeRow.append(b);
    }

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'dp-canvas';

    const hint = document.createElement('div');
    hint.className = 'dp-hint';
    hint.innerHTML = 'Left-drag to draw · <b>right-drag</b> to turn the view · <b>X/Y/Z</b> snap to an axis.';

    const btnRow = document.createElement('div');
    btnRow.className = 'dp-row';
    const place = this.btn('Place', 'primary');
    const clear = this.btn('Clear', '');
    const cancel = this.btn('Cancel', '');
    place.onclick = () => this.place();
    clear.onclick = () => this.clear();
    cancel.onclick = () => this.close();
    btnRow.append(place, clear, cancel);

    this.root.append(header, viewRow, modeRow, this.canvas, hint, btnRow);
    document.body.append(this.root);
    makeDrag(this.root, 'header');

    // --- the little editor scene: grid (the "paper"), gnomon, and the live sketch line ---
    this.grid = new THREE.GridHelper(16, 16, 0xffffff, 0x5a6a86);
    const gm = this.grid.material as THREE.Material;
    gm.transparent = true; gm.opacity = 0.5; gm.depthWrite = false;
    this.scene.add(this.grid);

    const axes = new THREE.AxesHelper(7); // X red · Y green · Z blue
    (axes.material as THREE.Material).depthTest = false;
    this.scene.add(axes);
    const lx = axisLabel('X', '#ff6b6b'); lx.position.set(7.6, 0, 0);
    const ly = axisLabel('Y', '#63e58a'); ly.position.set(0, 7.6, 0);
    const lz = axisLabel('Z', '#6b9bff'); lz.position.set(0, 0, 7.6);
    this.scene.add(lx, ly, lz);

    this.line = new THREE.Line(this.lineGeom, new THREE.LineBasicMaterial({ color: LINE_COLOR }));
    this.line.frustumCulled = false;
    this.scene.add(this.line);
    // a glowing dot at every (smoothed) vertex, sharing the line's geometry — makes the stroke read
    // as a thick luminous ribbon instead of a 1-px hairline (GPU line width is unreliable on Windows)
    const glow = new THREE.Points(this.lineGeom, new THREE.PointsMaterial({
      size: 0.5, map: softDot(), color: LINE_COLOR, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true,
    }));
    glow.frustumCulled = false;
    this.scene.add(glow);

    // pointer wiring — the canvas owns both buttons; move/up on window so a drag can leave the canvas
    this.canvas.addEventListener('pointerdown', this.onDown);
    addEventListener('pointermove', this.onMove);
    addEventListener('pointerup', this.onUp);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault()); // right-drag turns the view

    new ResizeObserver(() => this.resize()).observe(this.canvas);
    this.setMode('draw');
    this.updateCamera();
  }

  private smoothed: THREE.Vector3[] = []; // the display (and Place) curve — Chaikin-smoothed raw pts

  /** Rebuild the preview line's vertex buffer from `pts`. We set a fresh attribute every time (rather
   *  than BufferGeometry.setFromPoints) because that method reuses an existing zero-length buffer and
   *  silently drops the points — so the drawn line would never appear. The displayed curve is the
   *  SMOOTHED stroke (two rounds of Chaikin corner-cutting), so a wobbly mouse line turns silky — and
   *  since Place uses the same smoothed points, what you see is exactly the flow you get. */
  private updateLine() {
    this.smoothed = chaikin(this.pts, 2);
    const s = this.smoothed;
    const a = new Float32Array(s.length * 3);
    for (let i = 0; i < s.length; i++) { a[i * 3] = s[i].x; a[i * 3 + 1] = s[i].y; a[i * 3 + 2] = s[i].z; }
    this.lineGeom.setAttribute('position', new THREE.BufferAttribute(a, 3));
    this.lineGeom.setDrawRange(0, s.length);
    this.lineGeom.computeBoundingSphere();
  }

  // ---- window lifecycle -------------------------------------------------------------------------
  open() {
    this.root.classList.remove('hidden');
    this.root.style.zIndex = '60';
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
      this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    }
    this.clear();
    this.resize();
    if (!this.raf) {
      const loop = () => {
        this.raf = requestAnimationFrame(loop);
        // the grid is the sheet you draw on — keep it square to the view (it lies in the draw plane)
        this.grid.quaternion.setFromUnitVectors(UP, this.plane.normal);
        this.renderer!.render(this.scene, this.camera);
      };
      loop();
    }
  }

  close() {
    this.root.classList.add('hidden');
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  get isOpen(): boolean { return !this.root.classList.contains('hidden'); }

  private resize() {
    if (!this.renderer) return;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---- camera / view ----------------------------------------------------------------------------
  private updateCamera() {
    const sp = Math.sin(this.pol), cp = Math.cos(this.pol);
    this.camera.position.set(this.radius * sp * Math.sin(this.az), this.radius * cp, this.radius * sp * Math.cos(this.az));
    // near the poles the default up (world Y) lines up with the view → flip up to keep it stable
    this.camera.up.copy(this.pol < 0.2 || this.pol > Math.PI - 0.2 ? new THREE.Vector3(0, 0, -1) : UP);
    this.camera.lookAt(ORIGIN);
    this.camera.updateMatrixWorld();
    // draw onto the plane through the origin that faces the camera (⊥ to the view)
    this.plane.setFromNormalAndCoplanarPoint(this.camera.position.clone().normalize(), ORIGIN);
  }

  /** Snap to look straight down an axis — the classic front / top / side ortho-style views. */
  private snapView(axis: 'x' | 'y' | 'z') {
    if (axis === 'x') { this.az = Math.PI / 2; this.pol = Math.PI / 2; }
    else if (axis === 'z') { this.az = 0; this.pol = Math.PI / 2; }
    else { this.az = 0; this.pol = 0.02; } // top-down (a hair off the pole so up stays defined)
    this.updateCamera();
  }

  // ---- drawing ----------------------------------------------------------------------------------
  setMode(m: 'draw' | 'erase') {
    this.mode = m;
    this.modeBtns.draw.classList.toggle('on', m === 'draw');
    this.modeBtns.erase.classList.toggle('on', m === 'erase');
  }

  clear() {
    this.pts = [];
    this.updateLine();
  }

  private onDown = (e: PointerEvent) => {
    this.root.style.zIndex = '60';
    this.lastPtr = { x: e.clientX, y: e.clientY };
    if (e.button === 2) { this.orbiting = true; return; }
    if (e.button !== 0) return;
    this.drawing = true;
    if (this.mode === 'draw') this.addPoint(e); else this.eraseAt(e);
  };

  private onMove = (e: PointerEvent) => {
    if (this.orbiting) {
      const dx = e.clientX - this.lastPtr.x, dy = e.clientY - this.lastPtr.y;
      this.lastPtr = { x: e.clientX, y: e.clientY };
      this.az -= dx * 0.01;
      this.pol = THREE.MathUtils.clamp(this.pol - dy * 0.01, 0.05, Math.PI - 0.05);
      this.updateCamera();
      return;
    }
    if (!this.drawing) return;
    if (this.mode === 'draw') this.addPoint(e); else this.eraseAt(e);
  };

  private onUp = (e: PointerEvent) => {
    if (e.button === 2) this.orbiting = false;
    else this.drawing = false;
  };

  /** Cast the cursor onto the current draw plane and append the point (spaced so it isn't bunched). */
  private addPoint(e: PointerEvent) {
    const hit = this.rayToPlane(e);
    if (!hit) return;
    if (this.pts.length && hit.distanceTo(this.pts[this.pts.length - 1]) < 0.15) return;
    this.pts.push(hit);
    this.updateLine();
  }

  /** Remove drawn points near the cursor in SCREEN space — works from any view angle. */
  private eraseAt(e: PointerEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const proj = new THREE.Vector3();
    const keep = this.pts.filter((p) => {
      proj.copy(p).project(this.camera);
      const sx = (proj.x * 0.5 + 0.5) * rect.width + rect.left;
      const sy = (1 - (proj.y * 0.5 + 0.5)) * rect.height + rect.top;
      return Math.hypot(sx - e.clientX, sy - e.clientY) > 14;
    });
    if (keep.length !== this.pts.length) { this.pts = keep; this.updateLine(); }
  }

  private rayToPlane(e: PointerEvent): THREE.Vector3 | null {
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    return this.raycaster.ray.intersectPlane(this.plane, new THREE.Vector3());
  }

  // ---- commit -----------------------------------------------------------------------------------
  /** Turn the sketch into a live flow field, centred on the main view's focus. Uses the SMOOTHED
   *  curve — the exact line on screen — so the placed flow matches what was drawn. */
  private place() {
    if (this.smoothed.length < 3) return;
    const c = new THREE.Vector3();
    for (const p of this.smoothed) c.add(p);
    c.divideScalar(this.smoothed.length);
    const offset = this.sandbox.controls.target.clone().sub(c); // drop it where the camera is looking
    const world = this.smoothed.map((p) => p.clone().add(offset));
    this.sandbox.createDrawnPath(world);
    this.close();
  }

  // ---- tiny DOM helpers -------------------------------------------------------------------------
  private btn(text: string, cls: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = text;
    b.className = cls;
    return b;
  }
  private label(text: string): HTMLSpanElement {
    const s = document.createElement('span');
    s.className = 'dp-label';
    s.textContent = text;
    return s;
  }
}

/**
 * Chaikin corner-cutting: each pass replaces every segment with two points at its 1/4 and 3/4 marks
 * (endpoints kept), converging on a smooth quadratic B-spline of the stroke. Two passes are enough to
 * turn mouse wobble into a silky curve while staying faithful to the drawn shape.
 */
function chaikin(pts: THREE.Vector3[], passes: number): THREE.Vector3[] {
  let cur = pts;
  for (let p = 0; p < passes && cur.length >= 3; p++) {
    const next: THREE.Vector3[] = [cur[0].clone()];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i], b = cur[i + 1];
      next.push(a.clone().lerp(b, 0.25), a.clone().lerp(b, 0.75));
    }
    next.push(cur[cur.length - 1].clone());
    cur = next;
  }
  return cur === pts ? pts.map((p) => p.clone()) : cur;
}

/** Drag the window by its header (a stripped-down clone of ui.ts's makeFloating). */
function makeDrag(root: HTMLElement, handleSel: string) {
  root.addEventListener('pointerdown', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('button, canvas, input')) return;
    if (!t.closest(handleSel)) return;
    const rect = root.getBoundingClientRect();
    const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
    root.style.left = `${rect.left}px`;
    root.style.top = `${rect.top}px`;
    const move = (ev: PointerEvent) => { root.style.left = `${ev.clientX - dx}px`; root.style.top = `${ev.clientY - dy}px`; };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
    e.preventDefault();
  });
}
