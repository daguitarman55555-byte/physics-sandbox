/**
 * DEV OVERLAYS — draw what the physics actually sees, on top of the scene (dev mode only):
 *   colliders   — Rapier's own debug wireframes (the collision truth, not the render mesh)
 *   velocities  — a line per awake body along its velocity (length ∝ speed, colour by speed)
 *   forces      — arrows on the selected body: gravity, every applied force by source, and the
 *                 residual (m·a − known forces = contacts, joints, damping)
 *   prediction  — the selected body's free-flight path under gravity alone, so any deviation you
 *                 see is some other force acting
 * Render-only: nothing here ever writes to physics.
 */
import * as THREE from 'three';
import type { Sandbox } from '../sandbox';

const MAX_VEL = 4000;
const PRED_STEPS = 150; // 2.5 s of prediction at the fixed step
const DT = 1 / 60;

export class DevViz {
  colliders = false;
  velocities = true;
  forces = true;
  prediction = true;

  private group = new THREE.Group();
  private colLines: THREE.LineSegments;
  private velLines: THREE.LineSegments;
  private velPos = new Float32Array(MAX_VEL * 6);
  private velCol = new Float32Array(MAX_VEL * 6);
  private predLine: THREE.Line;
  private predPos = new Float32Array(PRED_STEPS * 3);
  private arrows: THREE.ArrowHelper[] = [];
  private com: THREE.Mesh;
  private _p = new THREE.Vector3();
  private _d = new THREE.Vector3();
  private _c = new THREE.Color();

  constructor(private S: Sandbox) {
    this.group.renderOrder = 999;
    this.colLines = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, depthTest: false }),
    );
    this.colLines.frustumCulled = false;

    const vg = new THREE.BufferGeometry();
    vg.setAttribute('position', new THREE.BufferAttribute(this.velPos, 3).setUsage(THREE.DynamicDrawUsage));
    vg.setAttribute('color', new THREE.BufferAttribute(this.velCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.velLines = new THREE.LineSegments(vg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthTest: false }));
    this.velLines.frustumCulled = false;

    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.predPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.predLine = new THREE.Line(pg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false }));
    this.predLine.frustumCulled = false;

    this.com = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));

    this.group.add(this.colLines, this.velLines, this.predLine, this.com);
    this.group.visible = false;
    S.scene.add(this.group);
  }

  update(alpha: number) {
    const S = this.S;
    this.group.visible = S.devOn;
    if (!S.devOn) return;

    // --- collider wireframes straight from Rapier's debug pipeline (physics-step pose) ---
    this.colLines.visible = this.colliders;
    if (this.colliders) {
      const { vertices, colors } = S.world.debugRender();
      const g = this.colLines.geometry;
      g.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      g.setAttribute('color', new THREE.BufferAttribute(colors, 4));
      g.setDrawRange(0, vertices.length / 3);
    }

    // --- velocity lines for every awake body ---
    this.velLines.visible = this.velocities;
    if (this.velocities) {
      let n = 0;
      for (const e of S.entities) {
        if (n >= MAX_VEL) break;
        if (e.frozen || e.body.isSleeping()) continue;
        const v = e.body.linvel();
        const sp = Math.hypot(v.x, v.y, v.z);
        if (sp < 0.05) continue;
        this._p.copy(e.prevPos).lerp(e.currPos, alpha);
        const len = Math.min(sp * 0.25, 8) / sp;
        const j = n * 6;
        this.velPos[j] = this._p.x; this.velPos[j + 1] = this._p.y; this.velPos[j + 2] = this._p.z;
        this.velPos[j + 3] = this._p.x + v.x * len; this.velPos[j + 4] = this._p.y + v.y * len; this.velPos[j + 5] = this._p.z + v.z * len;
        this._c.setHSL(0.62 - Math.min(sp / 30, 1) * 0.62, 0.9, 0.6); // blue (slow) → red (fast)
        this.velCol[j] = this._c.r * 0.4; this.velCol[j + 1] = this._c.g * 0.4; this.velCol[j + 2] = this._c.b * 0.4;
        this.velCol[j + 3] = this._c.r; this.velCol[j + 4] = this._c.g; this.velCol[j + 5] = this._c.b;
        n++;
      }
      const g = this.velLines.geometry;
      g.setDrawRange(0, n * 2);
      (g.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    }

    const e = S.selected;
    this.com.visible = !!e;
    for (const a of this.arrows) a.visible = false;
    this.predLine.visible = false;
    if (!e) return;
    const pos = this._p.copy(e.prevPos).lerp(e.currPos, alpha);
    this.com.position.copy(pos);

    // --- force arrows on the selection: gravity, each applied source, and the contact residual ---
    if (this.forces) {
      const m = e.body.mass();
      const gs = e.gravityScale ?? 1;
      const list: Array<{ x: number; y: number; z: number; color: number }> = [];
      const gy = m * S.gravityY * gs;
      if (e.frozen) { /* a pinned body feels no net force worth drawing */ } else {
        list.push({ x: 0, y: gy, z: 0, color: 0xdc4a4a });
        let sx = 0, sy = gy, sz = 0;
        for (const f of S.devForces) { list.push({ x: f.f.x, y: f.f.y, z: f.f.z, color: f.color }); sx += f.f.x; sy += f.f.y; sz += f.f.z; }
        list.push({ x: m * e.accel.x - sx, y: m * e.accel.y - sy, z: m * e.accel.z - sz, color: 0x4fb89a });
      }
      let maxF = 1e-9;
      for (const f of list) maxF = Math.max(maxF, Math.hypot(f.x, f.y, f.z));
      const R = Math.max(e.size, 0.35);
      list.forEach((f, i) => {
        const mag = Math.hypot(f.x, f.y, f.z);
        if (mag < maxF * 0.02) return;
        let a = this.arrows[i];
        if (!a) { a = new THREE.ArrowHelper(); (a.line.material as THREE.LineBasicMaterial).depthTest = false; (a.cone.material as THREE.MeshBasicMaterial).depthTest = false; this.arrows[i] = a; this.group.add(a); }
        a.visible = true;
        a.position.copy(pos);
        a.setDirection(this._d.set(f.x / mag, f.y / mag, f.z / mag));
        const len = R * (0.8 + 2.2 * (mag / maxF));
        a.setLength(len, Math.min(len * 0.25, 0.45), Math.min(len * 0.12, 0.22));
        a.setColor(f.color);
      });
    }

    // --- free-flight prediction (gravity only, the engine's own step rule) ---
    if (this.prediction && !e.frozen) {
      const v = e.body.linvel();
      let x = e.currPos.x, y = e.currPos.y, z = e.currPos.z, vx = v.x, vy = v.y, vz = v.z;
      const g = S.gravityY * (e.gravityScale ?? 1);
      let n = 0;
      for (; n < PRED_STEPS; n++) {
        vy += g * DT; x += vx * DT; y += vy * DT; z += vz * DT;
        this.predPos[n * 3] = x; this.predPos[n * 3 + 1] = y; this.predPos[n * 3 + 2] = z;
        if (y < 0) { n++; break; }
      }
      const g2 = this.predLine.geometry;
      g2.setDrawRange(0, n);
      (g2.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.predLine.visible = n > 1;
    }
  }
}
