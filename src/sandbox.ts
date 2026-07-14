/**
 * Sandbox — the Phase 1 core: a Rapier physics world + a Three.js renderer, tied together by a
 * fixed-timestep loop with render interpolation.
 *
 * Design rules (they carry the whole roadmap):
 *  - Physics is the single source of truth; the renderer only READS body transforms.
 *  - Fixed dt for stability/determinism; a variable frame rate is bridged by an accumulator, and
 *    the render interpolates between the two most recent physics states so motion stays glassy.
 *  - Many objects are drawn with InstancedMesh (one draw call per shape) — this is what makes
 *    "hundreds of objects at 60fps" the default rather than a fight.
 *
 * Rapier and Three are both right-handed, Y-up, so body position/rotation copy straight into the
 * renderer with no coordinate conversion.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import RAPIER from '@dimforge/rapier3d-compat';
import { buildRevolution, type RevolutionSpec } from './systems/shapes';

export type Kind = 'box' | 'sphere' | 'custom';

export interface Entity {
  id: number;
  kind: Kind;
  body: RAPIER.RigidBody;
  size: number; // box half-extent, or sphere radius, or bounding radius for custom
  color: THREE.Color;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  currPos: THREE.Vector3;
  currQuat: THREE.Quaternion;
  mesh?: THREE.Mesh; // present for kind === 'custom' (unique geometry → its own draw call)
  volume?: number; // m³, for custom shapes (shown in the inspector)
  label?: string; // e.g. "revolution: 1.1 + 0.55*sin(x*0.9)"
}

const FIXED = 1 / 60; // physics timestep — never varies
const MAX_INSTANCES = 4000;
const MAX_CATCHUP = 3; // cap steps per frame → smooth slight-slow-motion under load, never a freeze

const PALETTE = ['#5b8def', '#4fb89a', '#c9bb3a', '#e89948', '#dc4a4a', '#a978e0'];

export class Sandbox {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly world: RAPIER.World;

  entities: Entity[] = [];
  private nextId = 0;
  private boxMesh: THREE.InstancedMesh;
  private sphereMesh: THREE.InstancedMesh;
  private boxSlots: Entity[] = []; // instance slot -> entity, from the last render (for picking)
  private sphereSlots: Entity[] = [];
  private customMeshes: THREE.Mesh[] = []; // unique-geometry meshes (Phase 2 shapes), one draw call each

  // interaction
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private grab: { entity: Entity; plane: THREE.Plane; offset: THREE.Vector3; target: THREE.Vector3 } | null = null;
  selected: Entity | null = null;
  private pointerDownAt = { x: 0, y: 0 };

  // stats
  private acc = 0;
  private last = performance.now();
  fps = 0;
  private fpsT = 0;
  private fpsN = 0;
  gravityY = -9.81;

  // scratch
  private _m = new THREE.Matrix4();
  private _p = new THREE.Vector3();
  private _q = new THREE.Quaternion();
  private _s = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    // --- renderer / scene / camera ---
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#0a0a0f');
    this.scene.fog = new THREE.Fog('#0a0a0f', 40, 110);

    this.camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);
    this.camera.position.set(14, 11, 18);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.target.set(0, 2, 0);
    this.controls.maxPolarAngle = Math.PI * 0.495; // don't go under the floor

    this.addLights();
    this.addGround();

    // --- physics world ---
    this.world = new RAPIER.World({ x: 0, y: this.gravityY, z: 0 });
    this.world.timestep = FIXED;
    this.addGroundCollider();

    // --- instanced render pools ---
    const stdMat = new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.65 });
    this.boxMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), stdMat, MAX_INSTANCES);
    this.sphereMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 24, 16), stdMat.clone(), MAX_INSTANCES);
    for (const m of [this.boxMesh, this.sphereMesh]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = true;
      m.receiveShadow = true;
      m.count = 0;
      m.frustumCulled = false;
      this.scene.add(m);
    }

    this.buildDefaultScene();

    // --- events ---
    addEventListener('resize', this.onResize);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    addEventListener('pointermove', this.onPointerMove);
    addEventListener('pointerup', this.onPointerUp);
  }

  // ---------------------------------------------------------------- scene setup
  private addLights() {
    this.scene.add(new THREE.HemisphereLight('#aab6cc', '#20242e', 0.7));
    const sun = new THREE.DirectionalLight('#ffffff', 2.1);
    sun.position.set(18, 30, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 45; // shadow frustum half-width — covers the whole active play area, not just the origin
    sun.shadow.camera.left = -d; sun.shadow.camera.right = d;
    sun.shadow.camera.top = d; sun.shadow.camera.bottom = -d;
    sun.shadow.camera.far = 120;
    this.scene.add(sun);
  }

  private addGround() {
    // A huge floor so nothing rolls off. Distance fog hides the far edge, so it reads as endless.
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(520, 520),
      new THREE.MeshStandardMaterial({ color: '#141826', roughness: 0.95, metalness: 0 }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    this.scene.add(plane);
    // Grid extends past the fog (which ends at 110) so its edge is never visible.
    const grid = new THREE.GridHelper(240, 240, 0x2b3550, 0x1c2233);
    (grid.material as THREE.Material).opacity = 0.5;
    (grid.material as THREE.Material).transparent = true;
    this.scene.add(grid);
  }

  private addGroundCollider() {
    // 500×500 physics floor (half-extents 250) — objects can't realistically be thrown off it.
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(250, 0.5, 250).setFriction(0.7).setRestitution(0.1), ground);
  }

  // ---------------------------------------------------------------- entities
  spawn(kind: Kind, pos?: THREE.Vector3, size?: number): Entity {
    if (this.entities.length >= MAX_INSTANCES) return this.entities[this.entities.length - 1];
    const s = size ?? (kind === 'box' ? 0.5 : 0.5);
    const p = pos ?? new THREE.Vector3((Math.random() - 0.5) * 8, 8 + Math.random() * 6, (Math.random() - 0.5) * 8);

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setLinvel((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2)
        .setAngvel({ x: Math.random(), y: Math.random(), z: Math.random() }),
    );
    const col =
      kind === 'box'
        ? RAPIER.ColliderDesc.cuboid(s, s, s)
        : RAPIER.ColliderDesc.ball(s);
    this.world.createCollider(col.setFriction(0.6).setRestitution(0.35).setDensity(1), body);

    const color = new THREE.Color(PALETTE[this.nextId % PALETTE.length]);
    const e: Entity = {
      id: this.nextId++, kind, body, size: s, color,
      prevPos: new THREE.Vector3(p.x, p.y, p.z), prevQuat: new THREE.Quaternion(),
      currPos: new THREE.Vector3(p.x, p.y, p.z), currQuat: new THREE.Quaternion(),
    };
    this.entities.push(e);
    return e;
  }

  spawnMany(n: number) {
    for (let i = 0; i < n; i++) this.spawn(Math.random() < 0.5 ? 'box' : 'sphere');
  }

  /**
   * Create an f(x) solid of revolution and drop it in. Its mass, center of mass, and full inertia
   * tensor are computed analytically (see systems/shapes.ts) and handed to Rapier, so it tumbles
   * with correct dynamics. The collider is a convex hull of the profile; the body origin is the
   * center of mass, so the render mesh transform is the body transform with no offset.
   */
  createRevolution(spec: RevolutionSpec): { ok: true; entity: Entity } | { ok: false; error: string } {
    if (this.entities.length >= MAX_INSTANCES) return { ok: false, error: 'Object limit reached.' };
    const built = buildRevolution(spec);
    if (!built.ok) return { ok: false, error: built.error };
    const s = built.shape;

    const p = new THREE.Vector3((Math.random() - 0.5) * 3, 8 + s.height / 2, (Math.random() - 0.5) * 3);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setAngvel({ x: (Math.random() - 0.5) * 1.5, y: (Math.random() - 0.5) * 1.5, z: (Math.random() - 0.5) * 1.5 })
        // exact analytic mass properties (collider density is 0 below, so these are the body's total)
        .setAdditionalMassProperties(
          s.mass,
          { x: 0, y: 0, z: 0 },
          { x: s.inertia.x, y: s.inertia.y, z: s.inertia.z },
          { x: 0, y: 0, z: 0, w: 1 },
        ),
    );
    // convex hull collider with zero density (mass comes from the exact tensor above)
    const hullDesc = RAPIER.ColliderDesc.convexHull(s.hull);
    const colDesc = (hullDesc ?? RAPIER.ColliderDesc.ball(s.maxRadius)).setFriction(0.6).setRestitution(0.3).setDensity(0);
    this.world.createCollider(colDesc, body);

    const color = new THREE.Color(PALETTE[this.nextId % PALETTE.length]);
    const mat = new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.6 });
    const mesh = new THREE.Mesh(s.geometry, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.copy(p);
    this.scene.add(mesh);
    this.customMeshes.push(mesh);

    const e: Entity = {
      id: this.nextId++, kind: 'custom', body, size: s.maxRadius, color,
      prevPos: p.clone(), prevQuat: new THREE.Quaternion(),
      currPos: p.clone(), currQuat: new THREE.Quaternion(),
      mesh, volume: s.volume, label: `revolution: ${spec.expr}`,
    };
    mesh.userData.entity = e;
    this.entities.push(e);
    return { ok: true, entity: e };
  }

  clear() {
    for (const e of this.entities) {
      this.world.removeRigidBody(e.body);
      if (e.mesh) {
        this.scene.remove(e.mesh);
        e.mesh.geometry.dispose();
        (e.mesh.material as THREE.Material).dispose();
      }
    }
    this.entities.length = 0;
    this.customMeshes.length = 0;
    this.selected = null;
    this.grab = null;
  }

  reset() {
    this.clear();
    this.buildDefaultScene();
  }

  private buildDefaultScene() {
    // a small stack + a scatter, so there's something alive on load
    for (let i = 0; i < 4; i++) this.spawn('box', new THREE.Vector3(0, 0.5 + i * 1.02, 0));
    for (let i = 0; i < 20; i++) this.spawn(Math.random() < 0.5 ? 'box' : 'sphere');
  }

  setGravityY(v: number) {
    this.gravityY = v;
    this.world.gravity = { x: 0, y: v, z: 0 };
    for (const e of this.entities) e.body.wakeUp();
  }

  // ---------------------------------------------------------------- the loop
  start() {
    this.last = performance.now();
    const frame = (now: number) => {
      requestAnimationFrame(frame);
      const dt = Math.min((now - this.last) / 1000, MAX_CATCHUP * FIXED);
      this.last = now;
      this.acc += dt;

      let steps = 0;
      while (this.acc >= FIXED && steps < MAX_CATCHUP) {
        this.stepPhysics();
        this.acc -= FIXED;
        steps++;
      }
      const alpha = this.acc / FIXED;
      this.syncRender(alpha);
      this.controls.update();
      this.renderer.render(this.scene, this.camera);

      // fps
      this.fpsN++; this.fpsT += dt;
      if (this.fpsT >= 0.5) { this.fps = this.fpsN / this.fpsT; this.fpsN = 0; this.fpsT = 0; }
    };
    requestAnimationFrame(frame);
  }

  private stepPhysics() {
    // save previous transforms for interpolation
    for (const e of this.entities) { e.prevPos.copy(e.currPos); e.prevQuat.copy(e.currQuat); }

    // drive a grabbed body toward the cursor target with a clamped velocity (no teleport, no fling)
    if (this.grab) {
      const b = this.grab.entity.body;
      const t = b.translation();
      const want = this._p.set(this.grab.target.x, this.grab.target.y, this.grab.target.z)
        .add(this.grab.offset)
        .sub(this._s.set(t.x, t.y, t.z))
        .multiplyScalar(1 / FIXED);
      const max = 40;
      if (want.length() > max) want.setLength(max);
      b.setLinvel({ x: want.x, y: want.y, z: want.z }, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }

    this.world.step();

    for (const e of this.entities) {
      const t = e.body.translation();
      const r = e.body.rotation();
      e.currPos.set(t.x, t.y, t.z);
      e.currQuat.set(r.x, r.y, r.z, r.w);
    }
  }

  private syncRender(alpha: number) {
    let bi = 0, si = 0;
    this.boxSlots.length = 0;
    this.sphereSlots.length = 0;
    for (const e of this.entities) {
      this._p.copy(e.prevPos).lerp(e.currPos, alpha);
      this._q.copy(e.prevQuat).slerp(e.currQuat, alpha);
      if (e.kind === 'custom') {
        // unique geometry → its own mesh; write the interpolated transform directly (no scale)
        const mesh = e.mesh!;
        mesh.position.copy(this._p);
        mesh.quaternion.copy(this._q);
        const selMat = mesh.material as THREE.MeshStandardMaterial;
        selMat.emissive.setHex(e === this.selected ? 0x3a4152 : 0x000000);
        continue;
      }
      const scale = e.kind === 'box' ? e.size * 2 : e.size; // box geo is unit cube; sphere geo is unit radius
      this._s.setScalar(scale);
      this._m.compose(this._p, this._q, this._s);
      const col = e === this.selected ? SELECT_COLOR : e.color;
      if (e.kind === 'box') {
        this.boxMesh.setMatrixAt(bi, this._m);
        this.boxMesh.setColorAt(bi, col);
        this.boxSlots[bi] = e;
        bi++;
      } else {
        this.sphereMesh.setMatrixAt(si, this._m);
        this.sphereMesh.setColorAt(si, col);
        this.sphereSlots[si] = e;
        si++;
      }
    }
    this.boxMesh.count = bi;
    this.sphereMesh.count = si;
    this.boxMesh.instanceMatrix.needsUpdate = true;
    this.sphereMesh.instanceMatrix.needsUpdate = true;
    if (this.boxMesh.instanceColor) this.boxMesh.instanceColor.needsUpdate = true;
    if (this.sphereMesh.instanceColor) this.sphereMesh.instanceColor.needsUpdate = true;
  }

  // ---------------------------------------------------------------- interaction
  private setPointer(e: PointerEvent) {
    this.pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pickTargets(): THREE.Object3D[] {
    return [this.boxMesh, this.sphereMesh, ...this.customMeshes];
  }

  private pick(): Entity | null {
    const hits = this.raycaster.intersectObjects(this.pickTargets(), false);
    for (const h of hits) {
      if (h.object === this.boxMesh || h.object === this.sphereMesh) {
        const id = h.instanceId;
        if (id == null) continue;
        const e = h.object === this.boxMesh ? this.boxSlots[id] : this.sphereSlots[id];
        if (e) return e;
      } else {
        const e = h.object.userData.entity as Entity | undefined;
        if (e) return e;
      }
    }
    return null;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // left button = pick/drag; right/middle handled by OrbitControls
    this.pointerDownAt = { x: e.clientX, y: e.clientY };
    this.setPointer(e);
    const hit = this.pick();
    if (hit) {
      this.selected = hit;
      // start a drag on a camera-facing plane through the grab point
      const t = hit.body.translation();
      const bodyPos = new THREE.Vector3(t.x, t.y, t.z);
      const hitPoint = this.raycaster.intersectObjects(this.pickTargets(), false)[0]?.point ?? bodyPos;
      const normal = this.camera.getWorldDirection(new THREE.Vector3()).negate();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hitPoint);
      this.grab = { entity: hit, plane, offset: bodyPos.clone().sub(hitPoint), target: hitPoint.clone() };
      hit.body.wakeUp();
      this.controls.enabled = false; // let the drag own the mouse
    } else {
      this.selected = null; // clicked empty space → OrbitControls will orbit
    }
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.grab) return;
    this.setPointer(e);
    const hit = this.raycaster.ray.intersectPlane(this.grab.plane, this._p.clone());
    if (hit) this.grab.target.copy(hit);
  };

  private onPointerUp = (_e: PointerEvent) => {
    if (this.grab) {
      this.grab = null;
      this.controls.enabled = true;
    }
  };

  private onResize = () => {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  };
}

const SELECT_COLOR = new THREE.Color('#ffffff');
