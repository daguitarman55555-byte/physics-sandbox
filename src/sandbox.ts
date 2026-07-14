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
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  buildRevolution, buildParamCurve, buildParamSurface,
  type RevolutionSpec, type ParamCurveSpec, type ParamSurfaceSpec,
} from './systems/shapes';
import { buildImplicit, type ImplicitSpec } from './systems/implicit';
import { PLAIN, type Material } from './systems/materials';

export type Kind = 'box' | 'sphere' | 'custom';

export interface Entity {
  id: number;
  kind: Kind;
  body: RAPIER.RigidBody;
  size: number; // box half-extent, or sphere radius, or bounding radius for custom
  mat: Material; // physics + appearance preset (PLAIN = the palette-colored default)
  color: THREE.Color;
  prevPos: THREE.Vector3;
  prevQuat: THREE.Quaternion;
  currPos: THREE.Vector3;
  currQuat: THREE.Quaternion;
  lastVel: THREE.Vector3; // velocity after the previous physics step (for acceleration readout)
  accel: THREE.Vector3; // measured acceleration over the last step — drives the forces window
  bbCenter: THREE.Vector3; // local-space bounding box (center/half-extents) — for the floor clamp
  bbHalf: THREE.Vector3;
  // exact floor-clamp support data for custom shapes: the local points that define the collider
  // (hull cloud / slab corners / capsule segment ends), plus a radius to pad below them (the tube
  // radius for capsule chains, 0 for hulls). Lowest world-Y over these = the body's true bottom.
  support?: { points: Float32Array; pad: number };
  mesh?: THREE.Mesh; // present for kind === 'custom' (unique geometry → its own draw call)
  volume?: number; // m³, for custom shapes (shown in the inspector)
  label?: string; // e.g. "revolution: 1.1 + 0.55*sin(x*0.9)"
}

const FIXED = 1 / 60; // physics timestep — never varies
const MAX_INSTANCES = 4000;
const MAX_CATCHUP = 3; // cap steps per frame → smooth slight-slow-motion under load, never a freeze
const MAX_SPEED = 60; // m/s hard cap — guards against solver-injected energy from deep-overlap spawns
const VOID_Y = -20; // below this, an entity fell off the world edge — it gets removed (no respawn)
const PICK_PIXEL_TOLERANCE = 18; // px — fallback nearest-entity radius when the exact ray misses

const PALETTE = ['#5b8def', '#4fb89a', '#c9bb3a', '#e89948', '#dc4a4a', '#a978e0'];

/** Whole texture tiles per `len` world units (~2 m per tile, matching a 1 m box at one tile). */
const tiles = (len: number) => Math.max(1, Math.round(len / 2));

export class Sandbox {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  readonly world: RAPIER.World;

  entities: Entity[] = [];
  private nextId = 0;
  // one InstancedMesh per (shape kind × material) — created lazily, so plain boxes stay one draw
  // call and 100 steel spheres are still just one more. slots[i] = entity at instance i (picking).
  private pools = new Map<string, { mesh: THREE.InstancedMesh; slots: Entity[] }>();
  private unitBox = new THREE.BoxGeometry(1, 1, 1);
  private unitSphere = new THREE.SphereGeometry(1, 24, 16);
  private texCache = new Map<string, THREE.Texture>(); // loaded PBR maps, keyed by url|repeat
  private customMeshes: THREE.Mesh[] = []; // unique-geometry meshes (Phase 2 shapes), one draw call each

  // interaction. Grabbing is physical: a collider-less kinematic body follows the cursor, tied to
  // the grabbed body by a spherical joint at the exact grab point — so gravity and inertia keep
  // acting while held (lift a rod by one end and the other end swings down).
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private grab: {
    entity: Entity;
    plane: THREE.Plane;
    target: THREE.Vector3;
    kin: RAPIER.RigidBody; // cursor-driven kinematic anchor
    joint: RAPIER.ImpulseJoint;
    prevLinDamp: number; // body damping to restore on release
    prevAngDamp: number;
  } | null = null;
  selected: Entity | null = null;
  private pointerDownAt = { x: 0, y: 0 };
  private lastPointerPx = { x: 0, y: 0 };

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
    this.scene.fog = new THREE.Fog('#0a0a0f', 80, 400); // light haze only — the whole floor stays visible

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

    this.buildDefaultScene();

    // --- events ---
    addEventListener('resize', this.onResize);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    addEventListener('pointermove', this.onPointerMove);
    addEventListener('pointerup', this.onPointerUp);
  }

  // ---------------------------------------------------------------- scene setup
  private addLights() {
    // a dim room environment so PBR materials (especially metal) have something to reflect —
    // punctual lights alone leave metalness-1 surfaces near-black. Intensity kept low to
    // preserve the dark blueprint look.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.3;
    pmrem.dispose();

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
    // A huge floor matching the 500×500 physics floor; its edge is visible far off, honestly.
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(520, 520),
      new THREE.MeshStandardMaterial({ color: '#141826', roughness: 0.95, metalness: 0 }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    this.scene.add(plane);
    // Grid covers the full physics floor (500×500); with the light fog its far edge reads as the
    // actual world edge — which it is (objects thrown past ±250 fall off).
    const grid = new THREE.GridHelper(500, 500, 0x2b3550, 0x1c2233);
    (grid.material as THREE.Material).opacity = 0.5;
    (grid.material as THREE.Material).transparent = true;
    this.scene.add(grid);
  }

  private addGroundCollider() {
    // 500×500 physics floor (half-extents 250) — objects can't realistically be thrown off it.
    const ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(250, 0.5, 250).setFriction(0.7).setRestitution(0.1), ground);
  }

  /**
   * Pick a random drop point that isn't deeply overlapping an existing entity. A dense cluster of
   * coincident spawns makes Rapier's contact solver inject a large separating impulse on the first
   * step, which (combined with no CCD) is how objects used to rocket off at thousands of m/s and
   * tunnel through the floor. Rejection-sampling a few times is enough to avoid that in practice.
   */
  private findSpawnSpot(size: number): THREE.Vector3 {
    const candidate = () => new THREE.Vector3((Math.random() - 0.5) * 8, 8 + Math.random() * 6, (Math.random() - 0.5) * 8);
    let best = candidate();
    for (let attempt = 0; attempt < 20; attempt++) {
      const p = candidate();
      const clear = this.entities.every((e) => {
        const t = e.body.translation();
        const minDist = size + e.size + 0.15;
        return (p.x - t.x) ** 2 + (p.y - t.y) ** 2 + (p.z - t.z) ** 2 >= minDist * minDist;
      });
      if (clear) return p;
      best = p;
    }
    return best;
  }

  // ---------------------------------------------------------------- materials & render pools
  /** Load (and cache) a texture map. Repeat counts are part of the key — repeats differ per shape. */
  private texture(url: string, srgb: boolean, repeat: [number, number]): THREE.Texture {
    const key = `${url}|${repeat[0]}x${repeat[1]}`;
    let t = this.texCache.get(key);
    if (t) return t;
    t = new THREE.TextureLoader().load(url);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
    t.anisotropy = 4;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace; // albedo is color data; the rest stay linear
    this.texCache.set(key, t);
    return t;
  }

  /** A PBR material from a preset's maps, tiled `repeat` times across the UVs. */
  private pbrMaterial(mat: Material, repeat: [number, number]): THREE.MeshStandardMaterial {
    const m = mat.maps!;
    return new THREE.MeshStandardMaterial({
      map: m.albedo ? this.texture(m.albedo, true, repeat) : undefined,
      normalMap: m.normal ? this.texture(m.normal, false, repeat) : undefined,
      roughnessMap: m.roughness ? this.texture(m.roughness, false, repeat) : undefined,
      metalnessMap: m.metalness ? this.texture(m.metalness, false, repeat) : undefined,
      roughness: 1, // factors multiply the maps — 1 lets the maps speak
      metalness: m.metalness ? 1 : 0,
    });
  }

  /** The InstancedMesh pool for a (shape kind, material) pair — created on first use. */
  private getPool(kind: 'box' | 'sphere', mat: Material) {
    const key = `${kind}:${mat.id}`;
    let pool = this.pools.get(key);
    if (pool) return pool;
    const material = mat.maps
      ? this.pbrMaterial(mat, [1, 1]) // unit box/sphere ≈ one tile — human-scale grain
      : new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.65 });
    const mesh = new THREE.InstancedMesh(kind === 'box' ? this.unitBox : this.unitSphere, material, MAX_INSTANCES);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.count = 0;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    pool = { mesh, slots: [] };
    mesh.userData.pool = pool; // raycast hit → pool → slots[instanceId] → entity
    this.pools.set(key, pool);
    return pool;
  }

  // ---------------------------------------------------------------- entities
  spawn(kind: Kind, pos?: THREE.Vector3, size?: number, mat: Material = PLAIN): Entity {
    if (this.entities.length >= MAX_INSTANCES) return this.entities[this.entities.length - 1];
    const s = size ?? (kind === 'box' ? 0.5 : 0.5);
    const p = pos ?? this.findSpawnSpot(s);

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setLinvel((Math.random() - 0.5) * 2, 0, (Math.random() - 0.5) * 2)
        .setAngvel({ x: Math.random(), y: Math.random(), z: Math.random() })
        .setCcdEnabled(true), // prevents tunneling through the thin ground collider at high speed
    );
    const col =
      kind === 'box'
        ? RAPIER.ColliderDesc.cuboid(s, s, s)
        : RAPIER.ColliderDesc.ball(s);
    // material physics: density is in water-units (kg/m³ ÷ 1000), so a steel 1 m³ box is 7.8 kg
    this.world.createCollider(
      col.setFriction(mat.friction).setRestitution(mat.restitution).setDensity(mat.density / 1000), body);

    this.getPool(kind as 'box' | 'sphere', mat); // ensure the render pool exists
    const color = new THREE.Color(PALETTE[this.nextId % PALETTE.length]);
    const e: Entity = {
      id: this.nextId++, kind, body, size: s, mat, color,
      prevPos: new THREE.Vector3(p.x, p.y, p.z), prevQuat: new THREE.Quaternion(),
      currPos: new THREE.Vector3(p.x, p.y, p.z), currQuat: new THREE.Quaternion(),
      lastVel: new THREE.Vector3(), accel: new THREE.Vector3(),
      bbCenter: new THREE.Vector3(), bbHalf: new THREE.Vector3(s, s, s),
    };
    this.entities.push(e);
    return e;
  }

  spawnMany(n: number, mat: Material = PLAIN) {
    for (let i = 0; i < n; i++) this.spawn(Math.random() < 0.5 ? 'box' : 'sphere', undefined, undefined, mat);
  }

  /**
   * Create an f(x) solid of revolution and drop it in. Its mass, center of mass, and full inertia
   * tensor are computed analytically (see systems/shapes.ts) and handed to Rapier, so it tumbles
   * with correct dynamics. The collider is a convex hull of the profile; the body origin is the
   * center of mass, so the render mesh transform is the body transform with no offset.
   */
  createRevolution(spec: RevolutionSpec, mat: Material = PLAIN): { ok: true; entity: Entity } | { ok: false; error: string } {
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
        )
        .setCcdEnabled(true),
    );
    // convex hull collider with zero density (mass comes from the exact tensor above)
    const hullDesc = RAPIER.ColliderDesc.convexHull(s.hull);
    const colDesc = (hullDesc ?? RAPIER.ColliderDesc.ball(s.maxRadius))
      .setFriction(mat.friction).setRestitution(mat.restitution).setDensity(0);
    this.world.createCollider(colDesc, body);

    // LatheGeometry UV: u wraps around, v runs along the profile
    const e = this.finishCustomEntity(
      body, s.geometry, p, s.maxRadius, s.volume, `revolution: ${spec.expr}`,
      mat, [tiles(2 * Math.PI * s.maxRadius), tiles(s.height)],
    );
    e.support = { points: s.hull, pad: 0 }; // collider = hull of exactly these points
    return { ok: true, entity: e };
  }

  /**
   * Create a parametric-curve tube — x(t),y(t),z(t) swept with radius r (springs, knots, rings).
   * Mass/c.o.m./inertia are integrated along the centerline (see systems/shapes.ts); the tensor is
   * generally non-diagonal, so Rapier gets the principal moments plus the principal-frame rotation.
   * Collision is a chain of capsules, so coils stay hollow (a convex hull would fill them in).
   */
  createParamCurve(spec: ParamCurveSpec, mat: Material = PLAIN): { ok: true; entity: Entity } | { ok: false; error: string } {
    if (this.entities.length >= MAX_INSTANCES) return { ok: false, error: 'Object limit reached.' };
    const built = buildParamCurve(spec);
    if (!built.ok) return { ok: false, error: built.error };
    const s = built.shape;

    const p = new THREE.Vector3((Math.random() - 0.5) * 3, 8 + s.maxRadius, (Math.random() - 0.5) * 3);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setAngvel({ x: (Math.random() - 0.5) * 1.5, y: (Math.random() - 0.5) * 1.5, z: (Math.random() - 0.5) * 1.5 })
        .setAdditionalMassProperties(s.mass, { x: 0, y: 0, z: 0 }, s.inertia, s.inertiaFrame)
        .setCcdEnabled(true),
    );
    for (const cap of s.capsules) {
      this.world.createCollider(
        RAPIER.ColliderDesc.capsule(cap.halfHeight, s.tube)
          .setTranslation(cap.center[0], cap.center[1], cap.center[2])
          .setRotation({ x: cap.quat[0], y: cap.quat[1], z: cap.quat[2], w: cap.quat[3] })
          .setFriction(mat.friction).setRestitution(mat.restitution).setDensity(0),
        body,
      );
    }

    // TubeGeometry UV: u runs along the tube, v wraps the circumference (≈ 2πr world units) —
    // tile along the length so grain doesn't stretch over a 28 m spring
    const e = this.finishCustomEntity(
      body, s.geometry, p, s.maxRadius, s.volume, `curve: ${spec.xt}, ${spec.yt}, ${spec.zt}`,
      mat, [Math.max(1, Math.round(s.length / Math.max(2 * Math.PI * s.tube, 0.5))), 1],
    );
    // support points = capsule segment ends; the tube radius pads below them (a segment's lowest
    // world-Y is at an endpoint, so this is the exact capsule-chain bottom)
    const ends = new Float32Array(s.capsules.length * 6);
    const axis = new THREE.Vector3();
    const q = new THREE.Quaternion();
    s.capsules.forEach((cap, i) => {
      q.set(cap.quat[0], cap.quat[1], cap.quat[2], cap.quat[3]);
      axis.set(0, cap.halfHeight, 0).applyQuaternion(q);
      ends[i * 6] = cap.center[0] + axis.x; ends[i * 6 + 1] = cap.center[1] + axis.y; ends[i * 6 + 2] = cap.center[2] + axis.z;
      ends[i * 6 + 3] = cap.center[0] - axis.x; ends[i * 6 + 4] = cap.center[1] - axis.y; ends[i * 6 + 5] = cap.center[2] - axis.z;
    });
    e.support = { points: ends, pad: s.tube };
    return { ok: true, entity: e };
  }

  /**
   * Create a parametric surface x(u,v),y(u,v),z(u,v) — as a thin shell (any surface) or a filled
   * solid (closed surfaces). Mass/c.o.m./inertia are exact for the triangulated surface (see
   * systems/shapes.ts); Rapier gets principal moments + frame like the curves. Collision is a
   * slab tiling — one small convex hull per coarse grid cell — so concavity is real: a ball
   * threads a torus's hole and a bowl cups a marble.
   */
  createParamSurface(spec: ParamSurfaceSpec, mat: Material = PLAIN): { ok: true; entity: Entity } | { ok: false; error: string } {
    if (this.entities.length >= MAX_INSTANCES) return { ok: false, error: 'Object limit reached.' };
    const built = buildParamSurface(spec);
    if (!built.ok) return { ok: false, error: built.error };
    const s = built.shape;

    const p = new THREE.Vector3((Math.random() - 0.5) * 3, 8 + s.maxRadius, (Math.random() - 0.5) * 3);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setAngvel({ x: (Math.random() - 0.5) * 1.5, y: (Math.random() - 0.5) * 1.5, z: (Math.random() - 0.5) * 1.5 })
        .setAdditionalMassProperties(s.mass, { x: 0, y: 0, z: 0 }, s.inertia, s.inertiaFrame)
        .setCcdEnabled(true),
    );
    let attached = 0;
    for (const slab of s.slabs) {
      const colDesc = RAPIER.ColliderDesc.convexHull(slab);
      if (!colDesc) continue; // degenerate cell (pole wedge) — its neighbors cover the gap
      this.world.createCollider(colDesc.setFriction(mat.friction).setRestitution(mat.restitution).setDensity(0), body);
      attached++;
    }
    if (!attached) {
      // pathological surface (every cell degenerate) — keep it interactable with a bounding ball
      this.world.createCollider(
        RAPIER.ColliderDesc.ball(s.maxRadius).setFriction(mat.friction).setRestitution(mat.restitution).setDensity(0), body);
    }

    const e = this.finishCustomEntity(
      body, s.geometry, p, s.maxRadius, s.volume,
      `surface (${s.mode}): ${spec.xuv}, ${spec.yuv}, ${spec.zuv}`,
      mat, [tiles(s.uvSpan[0]), tiles(s.uvSpan[1])], // UVs follow the parameter grid
    );
    e.support = { points: s.supportPoints, pad: 0 }; // slab corners = the collider's extremes
    // open surfaces are visible from both sides (a Möbius strip has no inside)
    (e.mesh!.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;
    return { ok: true, entity: e };
  }

  /**
   * Create an implicit solid f(x,y,z) < 0 (gyroids, metaballs, blobs). Mass/c.o.m./inertia come
   * from the Module-M voxel path (see systems/implicit.ts); collision is the occupancy voxels
   * greedy-merged into a compound of boxes — concave-true, so marbles roll through gyroid tunnels.
   */
  createImplicit(spec: ImplicitSpec, mat: Material = PLAIN): { ok: true; entity: Entity } | { ok: false; error: string } {
    if (this.entities.length >= MAX_INSTANCES) return { ok: false, error: 'Object limit reached.' };
    const built = buildImplicit(spec);
    if (!built.ok) return { ok: false, error: built.error };
    const s = built.shape;

    const p = new THREE.Vector3((Math.random() - 0.5) * 3, 8 + s.maxRadius, (Math.random() - 0.5) * 3);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(p.x, p.y, p.z)
        .setAngvel({ x: (Math.random() - 0.5) * 1.5, y: (Math.random() - 0.5) * 1.5, z: (Math.random() - 0.5) * 1.5 })
        .setAdditionalMassProperties(s.mass, { x: 0, y: 0, z: 0 }, s.inertia, s.inertiaFrame)
        .setCcdEnabled(true),
    );
    for (const b of s.boxes) {
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(b.half[0], b.half[1], b.half[2])
          .setTranslation(b.center[0], b.center[1], b.center[2])
          .setFriction(mat.friction).setRestitution(mat.restitution).setDensity(0),
        body,
      );
    }
    if (!s.boxes.length) {
      this.world.createCollider(
        RAPIER.ColliderDesc.ball(s.maxRadius).setFriction(mat.friction).setRestitution(mat.restitution).setDensity(0), body);
    }

    // box-projected UVs are already in ~2-world-unit tiles, so repeat [1,1]
    const e = this.finishCustomEntity(body, s.geometry, p, s.maxRadius, s.volume, `implicit: ${spec.fxyz}`, mat, [1, 1]);
    e.support = { points: s.supportPoints, pad: 0 }; // box corners = the collider's extremes
    return { ok: true, entity: e };
  }

  /** Shared tail for custom-geometry entities: mesh, registry entry, scene wiring. */
  private finishCustomEntity(
    body: RAPIER.RigidBody, geometry: THREE.BufferGeometry, p: THREE.Vector3,
    boundingRadius: number, volume: number, label: string,
    mat: Material = PLAIN, repeat: [number, number] = [1, 1],
  ): Entity {
    const color = new THREE.Color(PALETTE[this.nextId % PALETTE.length]);
    const meshMat = mat.maps
      ? this.pbrMaterial(mat, repeat)
      : new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.6 });
    const mesh = new THREE.Mesh(geometry, meshMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.copy(p);
    this.scene.add(mesh);
    this.customMeshes.push(mesh);

    geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    const e: Entity = {
      id: this.nextId++, kind: 'custom', body, size: boundingRadius, mat, color,
      prevPos: p.clone(), prevQuat: new THREE.Quaternion(),
      currPos: p.clone(), currQuat: new THREE.Quaternion(),
      lastVel: new THREE.Vector3(), accel: new THREE.Vector3(),
      bbCenter: bb.getCenter(new THREE.Vector3()), bbHalf: bb.getSize(new THREE.Vector3()).multiplyScalar(0.5),
      mesh, volume, label,
    };
    mesh.userData.entity = e;
    this.entities.push(e);
    return e;
  }

  /** Remove a single entity: physics body (+ colliders), render mesh, registry, selection/grab. */
  deleteEntity(e: Entity) {
    const i = this.entities.indexOf(e);
    if (i < 0) return;
    if (this.grab?.entity === e) this.releaseGrab(); // before the body goes — the joint refs it
    this.world.removeRigidBody(e.body);
    if (e.mesh) {
      this.scene.remove(e.mesh);
      e.mesh.geometry.dispose();
      (e.mesh.material as THREE.Material).dispose();
      const mi = this.customMeshes.indexOf(e.mesh);
      if (mi >= 0) this.customMeshes.splice(mi, 1);
    }
    this.entities.splice(i, 1);
    if (this.selected === e) this.selected = null;
    if (this.grab?.entity === e) this.releaseGrab();
  }

  clear() {
    this.releaseGrab(); // before bodies go — the joint refs one of them
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
    const lost: Entity[] = []; // entities that fell off the world this step — removed after the loop

    // walk the kinematic anchor toward the cursor target (clamped step — no teleporting the joint);
    // the spherical joint transmits the pull while gravity and inertia keep acting on the body
    if (this.grab) {
      // the anchor never leaves the floor area, and its height is clamped so the OBJECT can't be
      // pushed under the map: the object hangs some distance below the grab anchor (a ball grabbed
      // by its front hangs half a diameter below; a dangling rod hangs its whole length), so the
      // anchor's floor is that distance — recomputed live as the body swings and tilts
      const k = this.grab.kin.translation();
      const hangBelow = Math.max(0, k.y - this.bodyBottomY(this.grab.entity));
      const tgt = this.grab.target;
      tgt.x = THREE.MathUtils.clamp(tgt.x, -245, 245);
      tgt.y = Math.max(tgt.y, hangBelow + 0.02);
      tgt.z = THREE.MathUtils.clamp(tgt.z, -245, 245);
      const want = this._p.set(tgt.x, tgt.y, tgt.z)
        .sub(this._s.set(k.x, k.y, k.z));
      const maxStep = 40 * FIXED; // ≤ 40 m/s anchor speed
      if (want.length() > maxStep) want.setLength(maxStep);
      this.grab.kin.setNextKinematicTranslation({ x: k.x + want.x, y: k.y + want.y, z: k.z + want.z });
      this.grab.entity.body.wakeUp();
    }

    this.world.step();

    for (const e of this.entities) {
      // hard speed cap: a stray deep-overlap contact can otherwise inject unbounded energy into a
      // body, sending it off to infinity (and making it impossible to ever click again)
      const v = e.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      if (speed > MAX_SPEED) {
        const k = MAX_SPEED / speed;
        e.body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
      }

      const t = e.body.translation();
      // fell past the world edge (thrown beyond the 500×500 floor) → it's gone; deleting it beats
      // teleporting it back, which read as objects "randomly spawning in"
      if (t.y < VOID_Y) {
        lost.push(e);
        continue;
      }

      const r = e.body.rotation();
      e.currPos.set(t.x, t.y, t.z);
      e.currQuat.set(r.x, r.y, r.z, r.w);

      // acceleration over this step (post-cap velocity), for the forces readout
      const vNow = e.body.linvel();
      e.accel.set((vNow.x - e.lastVel.x) / FIXED, (vNow.y - e.lastVel.y) / FIXED, (vNow.z - e.lastVel.z) / FIXED);
      e.lastVel.set(vNow.x, vNow.y, vNow.z);
    }
    for (const e of lost) this.deleteEntity(e);
  }

  private syncRender(alpha: number) {
    for (const pool of this.pools.values()) pool.slots.length = 0;
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
      // plain pool: palette color per instance (white when selected). Textured pool: instanceColor
      // multiplies the map — white normally, a >1 blue-ish tint to highlight the selection.
      const col = e.mat.maps
        ? (e === this.selected ? SELECT_TINT : WHITE)
        : (e === this.selected ? SELECT_COLOR : e.color);
      const pool = this.getPool(e.kind as 'box' | 'sphere', e.mat);
      const i = pool.slots.length;
      pool.mesh.setMatrixAt(i, this._m);
      pool.mesh.setColorAt(i, col);
      pool.slots.push(e);
    }
    for (const pool of this.pools.values()) {
      pool.mesh.count = pool.slots.length;
      pool.mesh.instanceMatrix.needsUpdate = true;
      if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- interaction
  private setPointer(e: PointerEvent) {
    this.lastPointerPx.x = e.clientX;
    this.lastPointerPx.y = e.clientY;
    this.pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  private pickTargets(): THREE.Object3D[] {
    return [...[...this.pools.values()].map((p) => p.mesh), ...this.customMeshes];
  }

  private entityFromHit(h: THREE.Intersection): Entity | null {
    const pool = h.object.userData.pool as { slots: Entity[] } | undefined;
    if (pool) {
      const id = h.instanceId;
      if (id == null) return null;
      return pool.slots[id] ?? null;
    }
    return (h.object.userData.entity as Entity | undefined) ?? null;
  }

  /** Returns the picked entity and the world-space point to grab it at (its collider surface, or
   * its body origin when the pick came from the nearby-target fallback rather than a real hit). */
  private pick(): { entity: Entity; point: THREE.Vector3 } | null {
    const hits = this.raycaster.intersectObjects(this.pickTargets(), false);
    for (const h of hits) {
      const e = this.entityFromHit(h);
      if (e) return { entity: e, point: h.point };
    }
    const fallback = this.pickNearbyFallback();
    if (!fallback) return null;
    const t = fallback.body.translation();
    return { entity: fallback, point: new THREE.Vector3(t.x, t.y, t.z) };
  }

  /**
   * A small, fast-moving target (a rolling/bouncing ball) can slip between the exact ray and its
   * mesh from one frame to the next, so an exact-intersection-only pick makes moving objects feel
   * much harder to grab than resting ones. Fall back to the nearest entity within a small
   * screen-space radius of the cursor.
   */
  private pickNearbyFallback(): Entity | null {
    let best: Entity | null = null;
    let bestDist = PICK_PIXEL_TOLERANCE;
    const proj = this._p;
    for (const e of this.entities) {
      proj.copy(e.currPos).project(this.camera);
      if (proj.z < -1 || proj.z > 1) continue; // behind the camera or beyond the far plane
      const px = (proj.x * 0.5 + 0.5) * innerWidth;
      const py = (1 - (proj.y * 0.5 + 0.5)) * innerHeight;
      const dist = Math.hypot(px - this.lastPointerPx.x, py - this.lastPointerPx.y);
      if (dist < bestDist) { bestDist = dist; best = e; }
    }
    return best;
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return; // left button = pick/drag; right/middle handled by OrbitControls
    this.pointerDownAt = { x: e.clientX, y: e.clientY };
    this.setPointer(e);
    const hit = this.pick();
    if (hit) {
      this.releaseGrab(); // a second press mid-grab (multi-touch, missed pointerup) must not leak the joint
      this.selected = hit.entity;
      // start a drag on a camera-facing plane through the grab point
      const body = hit.entity.body;
      const t = body.translation();
      const bodyPos = new THREE.Vector3(t.x, t.y, t.z);
      const hitPoint = hit.point;
      const normal = this.camera.getWorldDirection(new THREE.Vector3()).negate();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hitPoint);

      // pin a kinematic anchor to the grab point with a ball joint (anchor is body-local),
      // so the body hangs/swings physically from where it was grabbed
      const rq = body.rotation();
      const local = hitPoint.clone().sub(bodyPos)
        .applyQuaternion(new THREE.Quaternion(rq.x, rq.y, rq.z, rq.w).invert());
      const kin = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(hitPoint.x, hitPoint.y, hitPoint.z),
      );
      const joint = this.world.createImpulseJoint(
        RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: local.x, y: local.y, z: local.z }),
        kin, body, true,
      );
      // hand-like damping while held: steadies the drag but leaves the swing visible
      const prevLinDamp = body.linearDamping();
      const prevAngDamp = body.angularDamping();
      body.setLinearDamping(4);
      body.setAngularDamping(0.9);

      this.grab = { entity: hit.entity, plane, target: hitPoint.clone(), kin, joint, prevLinDamp, prevAngDamp };
      body.wakeUp();
      this.controls.enabled = false; // let the drag own the mouse
    } else {
      this.selected = null; // clicked empty space → OrbitControls will orbit
    }
  };

  /**
   * World-space Y of the body's lowest point — exact for spheres (radius), boxes (OBB), and custom
   * shapes (true support point over the collider's defining points, minus its pad radius).
   * Drives the drag clamp that keeps held objects above the floor.
   */
  private bodyBottomY(e: Entity): number {
    const t = e.body.translation();
    if (e.kind === 'sphere') return t.y - e.size;
    const q = e.body.rotation();
    // y-components of the world-rotated local basis vectors (middle row of the rotation matrix)
    const yx = 2 * (q.x * q.y + q.w * q.z);
    const yy = 1 - 2 * (q.x * q.x + q.z * q.z);
    const yz = 2 * (q.y * q.z - q.w * q.x);
    if (e.support) {
      const pts = e.support.points;
      let min = Infinity;
      for (let k = 0; k < pts.length; k += 3) {
        const y = pts[k] * yx + pts[k + 1] * yy + pts[k + 2] * yz;
        if (y < min) min = y;
      }
      return t.y + min - e.support.pad;
    }
    const c = e.bbCenter, h = e.bbHalf;
    const centerY = t.y + c.x * yx + c.y * yy + c.z * yz;
    return centerY - (h.x * Math.abs(yx) + h.y * Math.abs(yy) + h.z * Math.abs(yz));
  }

  /** Undo everything a grab set up: joint, kinematic anchor, damping, camera control. */
  private releaseGrab() {
    if (!this.grab) return;
    this.world.removeImpulseJoint(this.grab.joint, true);
    this.world.removeRigidBody(this.grab.kin);
    this.grab.entity.body.setLinearDamping(this.grab.prevLinDamp);
    this.grab.entity.body.setAngularDamping(this.grab.prevAngDamp);
    this.grab = null;
    this.controls.enabled = true;
  }

  private onPointerMove = (e: PointerEvent) => {
    if (!this.grab) return;
    this.setPointer(e);
    const hit = this.raycaster.ray.intersectPlane(this.grab.plane, this._p.clone());
    if (hit) this.grab.target.copy(hit);
  };

  private onPointerUp = (_e: PointerEvent) => {
    this.releaseGrab();
  };

  private onResize = () => {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  };
}

const SELECT_COLOR = new THREE.Color('#ffffff');
const WHITE = new THREE.Color(1, 1, 1);
const SELECT_TINT = new THREE.Color(1.5, 1.6, 1.9); // >1 brightens the texture under the tint
