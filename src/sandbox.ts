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
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  buildRevolution, buildParamCurve, buildParamSurface,
  type RevolutionSpec, type ParamCurveSpec, type ParamSurfaceSpec,
} from './systems/shapes';
import { buildImplicit, type ImplicitSpec } from './systems/implicit';
import { PLAIN, type Material } from './systems/materials';
import { fieldForce, fieldInfluence, pathInfluence, FIELD_INFO, samplePath, PATH_PRESETS, type Field, type FieldKind, type FieldShape, type CurveSpec } from './systems/fields';
import { buildJoint, anchorWorld, JOINT_INFO, type JointKind } from './systems/joints';

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
  texRepeat?: [number, number]; // texture tiling of the world mesh — mini-views reuse it
  // exact floor-clamp support data for custom shapes: the local points that define the collider
  // (hull cloud / slab corners / capsule segment ends), plus a radius to pad below them (the tube
  // radius for capsule chains, 0 for hulls). Lowest world-Y over these = the body's true bottom.
  support?: { points: Float32Array; pad: number };
  mesh?: THREE.Mesh; // present for kind === 'custom' (unique geometry → its own draw call)
  volume?: number; // m³, for custom shapes (shown in the inspector)
  label?: string; // e.g. "revolution: 1.1 + 0.55*sin(x*0.9)"
  frozen?: boolean; // Phase 4 freeze tool: body switched to Fixed (held in place until unfrozen)
}

export type Tool = 'grab' | 'connect' | 'freeze' | 'push' | 'brush';
export type BrushMode = 'push' | 'pull' | 'swirl';

interface JointRec {
  id: number; kind: JointKind; a: Entity; b: Entity;
  joint: RAPIER.ImpulseJoint;
  localA: THREE.Vector3; localB: THREE.Vector3;
  line: THREE.Line;
}

/**
 * A weld/hinge in its DOCKING phase: before the rigid joint exists, the two bodies are drawn
 * together under gentle velocity control (collisions stay on, so their real colliders — not a
 * computed contact point — stop them exactly at the surface). When they touch (or a timeout hits),
 * the dock resolves into a real JointRec locked at that pose. This is why blocks never smash or end
 * up inside each other, at any orientation.
 */
interface DockRec {
  id: number; kind: JointKind; a: Entity; b: Entity;
  line: THREE.Line;
  spring: RAPIER.ImpulseJoint; // soft damped pull that draws the pair together (removed on lock)
  elapsed: number;
}
/** A force field + its scene marker. `core` is the solid dot: click handle, gizmo anchor, ghost pulse. */
export interface FieldRec { field: Field; marker: THREE.Object3D; core?: THREE.Object3D }

const FIXED = 1 / 60; // physics timestep — never varies
const MAX_INSTANCES = 4000;
const MAX_CATCHUP = 3; // cap steps per frame → smooth slight-slow-motion under load, never a freeze
const MAX_SPEED = 60; // m/s hard cap — guards against solver-injected energy from deep-overlap spawns
const VOID_Y = -20; // below this, an entity fell off the world edge — it gets removed (no respawn)
const PICK_PIXEL_TOLERANCE = 18; // px — fallback nearest-entity radius when the exact ray misses
const _UP = new THREE.Vector3(0, 1, 0); // world up — the draw tool's sketch plane normal
const BRUSH_RADIUS = 4.5; // metres — the force brush affects bodies within this of the cursor point
const BRUSH_SPEED = 12; // target speed (m/s) the brush drives bodies toward
const BRUSH_RESPONSE = 8; // how hard the brush steers toward that target velocity (1/s)

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
  private unitSphere = new THREE.SphereGeometry(1, 48, 32); // smooth silhouette; still one instanced draw
  private texCache = new Map<string, THREE.Texture>(); // loaded PBR maps, keyed by url|repeat
  private customMeshes: THREE.Mesh[] = []; // unique-geometry meshes (Phase 2 shapes), one draw call each

  // Phase 4 — force fields, joints, and interaction tools
  private fields: FieldRec[] = [];
  private fieldStrength = 1; // live global multiplier over every field's base strength
  private fieldGroup = new THREE.Group(); // holds the translucent field markers
  // field placement/editing: the gizmo, the ghost awaiting confirmation, and the live selection
  private transform!: TransformControls;
  private placing: FieldRec | null = null; // ghost being positioned — NOT in `fields`, exerts no force
  // When editing a LIVE field, `placing` holds a DRAFT copy (the editable preview) and this points at
  // the original: edits touch only the draft (no force, no sim change) until Apply writes them back.
  private editingOriginal: FieldRec | null = null;
  selectedField: FieldRec | null = null;
  private placeValid = true;
  private axisLock: 'x' | 'y' | 'z' | null = null;
  onFieldChange?: () => void; // UI re-renders the field panel off this
  private joints: JointRec[] = [];
  private docks: DockRec[] = []; // weld/hinge pairs currently being drawn together (pre-lock)
  private jointGroup = new THREE.Group(); // holds the connector lines (docks + joints)
  private nextFieldId = 0;
  private nextJointId = 0;
  tool: Tool = 'grab';
  jointKind: JointKind = 'fixed';
  private connectA: Entity | null = null; // first object picked by the connect tool

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
  // "Draw a flow" — a floating white grid you sketch on (started from the Fields panel). Left-drag draws
  // a stroke onto the grid; right-drag tumbles the grid so you can build a curve in 3D; erase mode rubs
  // points out. The accumulated polyline becomes a live flow (path) field on Place.
  private draw: {
    group: THREE.Group; // the white grid canvas (grid lines + a faint fill so it reads as a surface)
    quat: THREE.Quaternion; // grid orientation — right-drag rotates this
    center: THREE.Vector3; // grid centre; the drawing plane passes through here
    plane: THREE.Plane; // the current drawing plane (rebuilt whenever the grid turns)
    pts: THREE.Vector3[]; // accumulated world-space points (the flow curve, across any grid rotations)
    line: THREE.Line; // bright preview polyline through pts
    mode: 'draw' | 'erase';
    stroking: boolean; // left button held (adding / erasing points)
    rotating: boolean; // right button held (tumbling the grid)
    lastPtr: { x: number; y: number };
  } | null = null;
  onDrawChange?: () => void; // UI hook: the draw panel re-renders when a session starts/ends/switches mode
  private drawPlane = new THREE.Plane(); // scratch plane reused by the force brush
  // force brush: hold + drag to push / pull / swirl objects near the cursor, live (no placed field)
  private brushActive = false;
  private brushMode: BrushMode = 'push';
  private brushPoint = new THREE.Vector3();

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
  private _fieldF = new THREE.Vector3(); // one field's force, summed into _s each step
  private _fieldV = new THREE.Vector3(); // body velocity handed to fields (the vortex needs it)

  constructor(canvas: HTMLCanvasElement) {
    // --- renderer / scene / camera ---
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // filmic tone mapping: soft highlight roll-off instead of clipping — the single biggest
    // "looks like a real renderer" switch; exposure re-lifts the mids it compresses
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

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

    this.scene.add(this.fieldGroup, this.jointGroup); // Phase 4 visuals live here

    // --- field placement gizmo ---
    // Axis-constrained handles are the honest answer to "a 2D mouse can't pick a 3D point": each
    // drag commits to one axis. Snapped to 1 unit so it lands on the floor grid.
    this.transform = new TransformControls(this.camera, canvas);
    this.transform.setTranslationSnap(1);
    this.transform.setRotationSnap(THREE.MathUtils.degToRad(15));
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value; // don't orbit while dragging
    });
    this.transform.addEventListener('objectChange', () => {
      const rec = this.activeField;
      if (rec) this.syncFieldFromMarker(rec);
    });
    this.scene.add(this.transform.getHelper()); // r169+: the helper is the scene-graph object

    this.buildDefaultScene();

    // --- events ---
    addEventListener('resize', this.onResize);
    canvas.addEventListener('pointerdown', this.onPointerDown);
    addEventListener('pointermove', this.onPointerMove);
    addEventListener('pointerup', this.onPointerUp);
    addEventListener('keydown', this.onKeyDown);
    // while drawing, right-drag rotates the grid — swallow the browser context menu so it doesn't pop
    canvas.addEventListener('contextmenu', (e) => { if (this.draw) e.preventDefault(); });
  }

  // ---------------------------------------------------------------- scene setup
  private addLights() {
    // a dim room environment so PBR materials (especially metal) have something to reflect —
    // punctual lights alone leave metalness-1 surfaces near-black. Intensity kept low to
    // preserve the dark blueprint look.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.45; // tuned with ACES tone mapping — flat metal faces keep a sheen
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
    t.anisotropy = 8; // keeps grain crisp at glancing angles
    if (srgb) t.colorSpace = THREE.SRGBColorSpace; // albedo is color data; the rest stay linear
    this.texCache.set(key, t);
    return t;
  }

  /** A PBR material from a preset's maps, tiled `repeat` times across the UVs. */
  pbrMaterial(mat: Material, repeat: [number, number]): THREE.MeshStandardMaterial {
    const m = mat.maps!;
    return new THREE.MeshStandardMaterial({
      map: m.albedo ? this.texture(m.albedo, true, repeat) : undefined,
      normalMap: m.normal ? this.texture(m.normal, false, repeat) : undefined,
      roughnessMap: m.roughness ? this.texture(m.roughness, false, repeat) : undefined,
      metalnessMap: m.metalness ? this.texture(m.metalness, false, repeat) : undefined,
      roughness: mat.roughnessScale ?? 1, // factors multiply the maps — < 1 shines it up
      // 0.85, not 1: the last 15% lets diffuse light give flat metal faces a base sheen instead
      // of them being pure mirrors of a mostly-dark room
      metalness: m.metalness ? 0.85 : 0,
      envMapIntensity: mat.envBoost ?? 1, // flat metal faces need brighter reflections to read
    });
  }

  /** A fresh render material matching an entity — the same maps and tiling its world mesh uses. */
  materialFor(e: Entity): THREE.MeshStandardMaterial {
    if (e.mat.maps) return this.pbrMaterial(e.mat, e.texRepeat ?? [1, 1]);
    return new THREE.MeshStandardMaterial({ color: e.color, metalness: 0.1, roughness: 0.6 });
  }

  /** A material for design-time previews of the given preset (plain = the classic preview blue). */
  previewMaterial(mat: Material): THREE.MeshStandardMaterial {
    if (mat.maps) return this.pbrMaterial(mat, [1, 1]);
    return new THREE.MeshStandardMaterial({ color: '#5b8def', metalness: 0.1, roughness: 0.55 });
  }

  /** The InstancedMesh pool for a (shape kind, material) pair — created on first use. */
  private getPool(kind: 'box' | 'sphere', mat: Material) {
    const key = `${kind}:${mat.id}`;
    let pool = this.pools.get(key);
    if (pool) return pool;
    // sphere UV wraps the whole map around 360° — twice the tiles keeps its texel aspect square
    // and its grain scale matched to the box faces (so steel looks like the SAME steel on both)
    const material = mat.maps
      ? this.pbrMaterial(mat, kind === 'sphere' ? [2, 1] : [1, 1])
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
      texRepeat: kind === 'sphere' ? [2, 1] : [1, 1], // must match the pool's tiling above
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
      texRepeat: repeat,
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

  // ---------------------------------------------------------------- Phase 4: tools, fields, joints
  /** Switch the active left-click tool. Leaving "connect" cancels a half-made connection. */
  setTool(tool: Tool) {
    if (tool !== 'connect') this.connectA = null;
    this.releaseGrab();
    this.tool = tool;
  }

  setJointKind(kind: JointKind) { this.jointKind = kind; }

  /** Freeze pins a body in place (switches it to a fixed body); calling again thaws it. */
  toggleFreeze(e: Entity) {
    e.frozen = !e.frozen;
    e.body.setBodyType(e.frozen ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic, true);
    if (!e.frozen) e.body.wakeUp();
  }

  /** Shove a body away from the camera (a quick impulse), scaled by mass for a uniform kick speed. */
  pushEntity(e: Entity) {
    if (e.frozen) return;
    const dir = this.camera.getWorldDirection(this._p).clone();
    dir.y += 0.15; // a touch upward so things pop up rather than plow straight into the floor
    dir.normalize();
    const mass = e.body.mass() || 1;
    const speed = 9; // m/s
    e.body.applyImpulse({ x: dir.x * mass * speed, y: dir.y * mass * speed, z: dir.z * mass * speed }, true);
  }

  /** Connect-tool click handler: first pick selects A, second creates a joint; empty click cancels. */
  private connectPick(entity: Entity | null) {
    if (!entity) { this.connectA = null; return; }
    if (!this.connectA) { this.connectA = entity; this.selected = entity; return; }
    if (entity === this.connectA) { this.connectA = null; return; }
    this.createJoint(this.connectA, entity);
    this.connectA = null;
  }

  private makeConnectorLine(kind: JointKind): THREE.Line {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geom, new THREE.LineBasicMaterial({ color: JOINT_INFO[kind].color }));
    line.frustumCulled = false;
    this.jointGroup.add(line);
    return line;
  }

  /**
   * Connect two bodies with the active joint kind. Spring/rope are tethers, created immediately at
   * the current separation. Weld & edge-hinge instead begin a DOCK: a soft, damped spring draws the
   * pair gently together with collisions left ON, so their real colliders — not a computed contact
   * point — stop them exactly at the surface (the edge hinge also rotates them face-to-face on the
   * way in). The instant they've seated, the rigid joint locks. This is why blocks never smash
   * together or end up inside each other, at any shape or orientation.
   */
  createJoint(a: Entity, b: Entity) {
    a.body.wakeUp(); b.body.wakeUp();
    if (this.jointKind === 'spring' || this.jointKind === 'rope') {
      this.lockJoint(a, b, this.jointKind, this.makeConnectorLine(this.jointKind));
      return;
    }
    // Mass-scaled so the pull feels the same whether the blocks are balsa or steel: force = K·x with
    // K,C ∝ average mass gives a mass-independent acceleration and damping ratio (gentle, ~1 m/s peak,
    // no overshoot). Rest length 0 keeps pulling inward; the colliders halt it at the surface.
    const mAvg = Math.max(0.1, (a.body.mass() + b.body.mass()) / 2);
    const spring = this.world.createImpulseJoint(
      RAPIER.JointData.spring(0, 4 * mAvg, 6 * mAvg, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
      a.body, b.body, true,
    ) as RAPIER.ImpulseJoint;
    this.docks.push({ id: this.nextJointId++, kind: this.jointKind, a, b, elapsed: 0, line: this.makeConnectorLine(this.jointKind), spring });
  }

  /** Build and register the rigid joint at the pair's CURRENT pose (they've already been docked). */
  private lockJoint(a: Entity, b: Entity, kind: JointKind, line: THREE.Line) {
    const ta = a.body.translation(), tb = b.body.translation();
    // weld/spring/rope anchor at the centre midpoint; the edge hinge pivots on one edge of the
    // shared contact face (computed from the live contact manifold) with an in-face axis.
    let anchor = new THREE.Vector3((ta.x + tb.x) / 2, (ta.y + tb.y) / 2, (ta.z + tb.z) / 2);
    let edgeAxisLocalA: THREE.Vector3 | undefined;
    if (kind === 'edge') {
      const edge = this.computeEdge(a, b);
      anchor = edge.pivot;
      edgeAxisLocalA = edge.axis.clone().applyQuaternion(this.quatOf(a.body).invert()); // into A's frame
    }
    const built = buildJoint(kind, a.body, b.body, anchor, edgeAxisLocalA);
    if (!built) { this.disposeLine(line); return; }
    const joint = this.world.createImpulseJoint(built.data, a.body, b.body, true) as RAPIER.ImpulseJoint;
    // A weld makes the pair one rigid body, so it can't clip itself — turn OFF collision between the
    // two so the colliders don't fight the weld over the last millimetre of contact (that fight is
    // what spun a freshly-welded pair). An edge hinge KEEPS collision on: it must not swing inside
    // its partner, so the colliders are what stop the swing. Contact with every OTHER body is unaffected.
    if (kind === 'fixed') joint.setContactsEnabled(false);
    a.body.wakeUp(); b.body.wakeUp();
    this.joints.push({ id: this.nextJointId++, kind, a, b, joint, localA: built.localA, localB: built.localB, line });
  }

  private quatOf(body: RAPIER.RigidBody): THREE.Quaternion {
    const r = body.rotation();
    return new THREE.Quaternion(r.x, r.y, r.z, r.w);
  }

  /**
   * Where a door hinge should pivot: one EDGE of the pair's shared contact face, with an axis lying
   * IN that face (chosen closest to vertical, so it reads as a door). Contact points and normal come
   * from the live manifold; if none are available it falls back to the centre line between the bodies.
   */
  private computeEdge(a: Entity, b: Entity): { pivot: THREE.Vector3; axis: THREE.Vector3 } {
    const pts: THREE.Vector3[] = [];
    const normal = new THREE.Vector3();
    for (let i = 0; i < a.body.numColliders(); i++) {
      const ca = a.body.collider(i);
      for (let j = 0; j < b.body.numColliders(); j++) {
        this.world.contactPair(ca, b.body.collider(j), (m, flipped) => {
          const n = m.normal();
          normal.set(n.x, n.y, n.z);
          if (flipped) normal.negate();
          for (let k = 0; k < m.numSolverContacts(); k++) {
            const p = m.solverContactPoint(k);
            pts.push(new THREE.Vector3(p.x, p.y, p.z));
          }
        });
      }
    }
    if (pts.length === 0 || normal.lengthSq() < 1e-6) {
      // fallback: no usable manifold — pivot at the centre line, normal along it
      const ta = a.body.translation(), tb = b.body.translation();
      const pA = new THREE.Vector3(ta.x, ta.y, ta.z), pB = new THREE.Vector3(tb.x, tb.y, tb.z);
      normal.copy(pB).sub(pA).normalize();
      pts.push(pA.clone().lerp(pB, 0.5));
    }
    normal.normalize();
    // hinge axis = the in-face direction closest to vertical (a door hinges about a vertical edge)
    const up = new THREE.Vector3(0, 1, 0);
    let axis = up.clone().addScaledVector(normal, -up.dot(normal));
    if (axis.lengthSq() < 1e-4) axis = new THREE.Vector3(1, 0, 0).addScaledVector(normal, -normal.x); // contact face is horizontal
    axis.normalize();
    const perp = new THREE.Vector3().crossVectors(normal, axis).normalize(); // in-face, ⊥ the axis
    let pivot = pts[0], best = -Infinity; // the contact point furthest to one side = an edge of the face
    for (const p of pts) { const d = p.dot(perp); if (d > best) { best = d; pivot = p; } }
    return { pivot: pivot.clone(), axis };
  }

  /** True if the two bodies' colliders are actually touching (a contact manifold with real points). */
  private pairInContact(a: Entity, b: Entity): boolean {
    for (let i = 0; i < a.body.numColliders(); i++) {
      const ca = a.body.collider(i);
      for (let j = 0; j < b.body.numColliders(); j++) {
        const cb = b.body.collider(j);
        let touching = false;
        this.world.contactPair(ca, cb, (m) => { if (m.numContacts() > 0) touching = true; });
        if (touching) return true;
      }
    }
    return false;
  }

  /**
   * Advance every active dock: the soft spring (added in createJoint) does the pulling, so here we
   * just watch for the pair's colliders to touch — the instant they do (or a safety timeout hits),
   * swap the spring for the rigid weld/hinge at that pose. Because the spring is compliant, the
   * colliders always win the approach, so the pair meets AT the surface instead of clipping through.
   */
  private stepDocks() {
    for (let i = this.docks.length - 1; i >= 0; i--) {
      const d = this.docks[i];
      d.elapsed += FIXED;
      // An edge hinge must also be aligned face-to-face before it can lock (else the revolute would
      // snap the two into line). A weld locks as soon as the surfaces meet.
      const aligned = d.kind !== 'edge' || this.alignDock(d.a, d.b);
      if ((this.pairInContact(d.a, d.b) && aligned) || d.elapsed > 6) {
        this.world.removeImpulseJoint(d.spring, true); // drop the pull; lock them where they meet
        this.lockJoint(d.a, d.b, d.kind, d.line);
        this.docks.splice(i, 1);
        continue;
      }
      // Dock in effective zero-G: cancel gravity on the pair while they close. Otherwise, when one is
      // held (frozen) or much heavier, gravity stretches the soft spring to a hanging equilibrium and
      // they never reach contact. Suspending gravity briefly lets the gentle spring always seat them.
      for (const e of [d.a, d.b]) {
        if (e.frozen) continue;
        const m = e.body.mass();
        e.body.applyImpulse({ x: 0, y: -this.gravityY * m * FIXED, z: 0 }, true);
        e.body.wakeUp();
      }
    }
  }

  /**
   * Edge-hinge docking: gently rotate the free body toward the other's orientation so the two seat
   * face-to-face (a door needs aligned panels). Returns true once they're within a small angle. The
   * turn is velocity-capped, so it's smooth however far off the two blocks started.
   */
  private alignDock(a: Entity, b: Entity): boolean {
    // rotate whichever body is free; prefer turning b (the second-picked) toward a
    const mover = !b.frozen ? b : (!a.frozen ? a : null);
    const anchor = mover === b ? a : b;
    if (!mover) return true; // both pinned — nothing to align
    const qTarget = this.quatOf(anchor.body);
    const qNow = this.quatOf(mover.body);
    const qRel = qTarget.multiply(qNow.invert()); // world rotation carrying mover → anchor orientation
    let angle = 2 * Math.acos(Math.min(1, Math.abs(qRel.w)));
    if (angle < 0.04) { mover.body.setAngvel({ x: 0, y: 0, z: 0 }, true); return true; }
    const s = Math.sqrt(Math.max(1e-9, 1 - qRel.w * qRel.w));
    const sign = qRel.w < 0 ? -1 : 1; // shortest arc
    const w = Math.min(angle / 0.35, 5); // rad/s, capped — smooth turn-in
    mover.body.setAngvel({ x: (sign * qRel.x / s) * w, y: (sign * qRel.y / s) * w, z: (sign * qRel.z / s) * w }, true);
    return false;
  }

  /** Every entity reachable from `e` through joints (its connected assembly), including `e`. */
  assemblyOf(e: Entity): Entity[] {
    const seen = new Set<Entity>([e]);
    const stack: Entity[] = [e];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const j of this.joints) {
        const other = j.a === cur ? j.b : j.b === cur ? j.a : null;
        if (other && !seen.has(other)) { seen.add(other); stack.push(other); }
      }
    }
    return [...seen];
  }

  private disposeLine(line: THREE.Line) {
    this.jointGroup.remove(line);
    line.geometry.dispose();
    (line.material as THREE.Material).dispose();
  }

  private removeJointRec(rec: JointRec) {
    this.world.removeImpulseJoint(rec.joint, true);
    this.disposeLine(rec.line);
  }

  private removeDock(rec: DockRec) {
    this.world.removeImpulseJoint(rec.spring, true);
    this.disposeLine(rec.line);
  }

  private removeJointsFor(e: Entity) {
    for (let i = this.joints.length - 1; i >= 0; i--) {
      if (this.joints[i].a === e || this.joints[i].b === e) {
        this.removeJointRec(this.joints[i]);
        this.joints.splice(i, 1);
      }
    }
    for (let i = this.docks.length - 1; i >= 0; i--) { // drop any in-progress dock touching it
      if (this.docks[i].a === e || this.docks[i].b === e) {
        this.removeDock(this.docks[i]);
        this.docks.splice(i, 1);
      }
    }
  }

  clearJoints() {
    for (const j of this.joints) this.removeJointRec(j);
    this.joints.length = 0;
    for (const d of this.docks) this.removeDock(d);
    this.docks.length = 0;
    this.connectA = null;
  }

  get jointCount(): number { return this.joints.length; }

  // ------------------------------------------------------------ fields: place, select, move, delete
  //
  // Placing a field is a two-step, commit-or-cancel flow (the pattern every 3D builder uses): a
  // translucent GHOST appears at the view centre exerting no force, you position it, then confirm.
  // A 2D mouse can't specify a 3D point on its own, so positioning is axis-constrained: drag the
  // gizmo's arrows, or lock an axis with X/Y/Z and nudge with the arrow keys (Blender's model).
  // The same machinery edits a LIVE field: click its core to select, move it, Delete to remove it.

  /** Start placing a new field: spawns the ghost at the view centre. Nothing acts until committed. */
  beginPlace(kind: FieldKind) {
    this.cancelPlace();
    this.cancelDraw(); // starting a field closes an open draw canvas
    this.selectField(null);
    const info = FIELD_INFO[kind];
    const c = this.controls.target;
    const r = info.size;
    // A gravity well is spawned up in the air (its big region still reaches down past the floor to
    // capture bodies resting there): with the orbit centre elevated, captured bodies lift off and
    // circle it instead of grinding their orbits into the floor. Other fields keep their low default.
    const minY = kind === 'gravitywell' ? 8 : 2;
    const field: Field = {
      id: this.nextFieldId++, kind, shape: 'sphere',
      pos: new THREE.Vector3(Math.round(c.x), Math.max(Math.round(c.y), minY), Math.round(c.z)),
      quat: new THREE.Quaternion(), // wind blows local +X until you aim it (rotate gizmo / R)
      size: new THREE.Vector3(r, r, r),
      strength: info.strength, hidden: false,
    };
    if (kind === 'path') {
      const scale = 10; // base flow-curve size (matches the other fields' base region of 10)
      const q = PATH_PRESETS.circle; // a circle to start (that's just the plain vortex)
      const spec: CurveSpec = { xt: q.xt, yt: q.yt, zt: q.zt, t0: q.t0, t1: q.t1 };
      const s = samplePath(spec, scale)!;
      field.path = { spec, label: q.label, scale, swirl: 0, pts: s.pts, tans: s.tans, closed: s.closed };
    }
    const rec: FieldRec = { field, marker: this.makeFieldMarker(field) };
    this.fieldGroup.add(rec.marker);
    this.tagMarker(rec);
    this.placing = rec;
    this.attachGizmo(rec, 'translate');
    this.refreshPlaceValidity();
    this.onFieldChange?.();
  }

  /**
   * Begin EDITING a live field. Rather than mutate it in place (which used to change the running sim
   * on every click), we spawn a DRAFT copy — a ghost that exerts no force — and hide the original's
   * marker so the draft stands in for it. Every editor control now touches the draft (pure preview);
   * the original keeps running its current force untouched until you Apply (commitPlace).
   */
  beginEdit(rec: FieldRec) {
    if (this.editingOriginal === rec) return; // already editing this one
    this.cancelPlace(); // drop any in-progress placement/edit (restores a prior original if needed)
    this.selectedField = null;
    this.editingOriginal = rec;
    rec.marker.visible = false; // the draft stands in for it while you edit
    const draft: FieldRec = { field: this.cloneField(rec.field), marker: this.makeFieldMarker(rec.field) };
    this.fieldGroup.add(draft.marker);
    this.tagMarker(draft);
    this.placing = draft;
    this.attachGizmo(draft, 'translate');
    this.refreshPlaceValidity();
    this.onFieldChange?.();
  }

  /** Commit the ghost. New field → goes live. Editing → the draft's settings are written back to the
   *  original (the one place the running sim changes). Either way the editor then closes. */
  commitPlace() {
    const rec = this.placing;
    if (!rec || !this.placeValid) return;
    if (this.editingOriginal) {
      const orig = this.editingOriginal;
      this.copyFieldInto(rec.field, orig.field); // apply the draft's settings to the live field
      orig.marker.position.copy(rec.marker.position);
      orig.marker.quaternion.copy(rec.marker.quaternion);
      this.rebuildMarker(orig); // reflect the new shape/size/curve (rebuild sets visible from hidden)
      // discard the draft and close the editor
      this.placing = null;
      this.editingOriginal = null;
      if (this.transform.object === rec.marker) this.transform.detach();
      this.axisLock = null;
      this.fieldGroup.remove(rec.marker);
      this.disposeMarker(rec.marker);
      for (const e of this.entities) e.body.wakeUp();
      this.onFieldChange?.();
      return;
    }
    rec.core?.scale.setScalar(1); // stop the ghost pulse
    this.tintMarker(rec.marker, FIELD_INFO[rec.field.kind].color);
    this.fields.push(rec);
    this.placing = null;
    this.selectedField = null; // done placing — close the editor (click it again to edit)
    this.transform.detach();
    this.axisLock = null;
    for (const e of this.entities) e.body.wakeUp();
    this.onFieldChange?.();
  }

  /** Throw the ghost away without placing anything — and, if editing, restore the original marker. */
  cancelPlace() {
    const rec = this.placing;
    if (!rec) return;
    this.placing = null;
    if (this.transform.object === rec.marker) this.transform.detach();
    this.axisLock = null;
    this.fieldGroup.remove(rec.marker);
    this.disposeMarker(rec.marker);
    if (this.editingOriginal) {
      this.editingOriginal.marker.visible = !this.editingOriginal.field.hidden; // show the live field again
      this.editingOriginal = null;
    }
    this.onFieldChange?.();
  }

  /** Deep copy a field so the draft can be edited without touching the original. */
  private cloneField(f: Field): Field {
    const c: Field = {
      id: f.id, kind: f.kind, shape: f.shape,
      pos: f.pos.clone(), quat: f.quat.clone(), size: f.size.clone(),
      strength: f.strength, hidden: f.hidden, lift: f.lift,
    };
    if (f.path) c.path = {
      spec: { ...f.path.spec }, label: f.path.label, scale: f.path.scale, swirl: f.path.swirl,
      pts: f.path.pts.slice(), tans: f.path.tans.slice(), closed: f.path.closed,
      drawn: f.path.drawn ? f.path.drawn.slice() : undefined,
    };
    return c;
  }

  /** Write a draft's editable settings onto the live field (kind is fixed and never changes). */
  private copyFieldInto(src: Field, dst: Field) {
    dst.shape = src.shape;
    dst.pos.copy(src.pos); dst.quat.copy(src.quat); dst.size.copy(src.size);
    dst.strength = src.strength; dst.hidden = src.hidden; dst.lift = src.lift;
    dst.path = src.path ? {
      spec: { ...src.path.spec }, label: src.path.label, scale: src.path.scale, swirl: src.path.swirl,
      pts: src.path.pts.slice(), tans: src.path.tans.slice(), closed: src.path.closed,
      drawn: src.path.drawn ? src.path.drawn.slice() : undefined,
    } : undefined;
  }

  /** Select a live field for editing (null clears). */
  selectField(rec: FieldRec | null) {
    this.selectedField = rec;
    if (rec) this.attachGizmo(rec, 'translate');
    else if (!this.placing) { this.transform.detach(); this.axisLock = null; }
    this.onFieldChange?.();
  }

  /** Delete one field (the gap that used to force a Clear-all just to fix one mistake). */
  removeField(rec: FieldRec) {
    const i = this.fields.indexOf(rec);
    if (i < 0) return;
    if (this.transform.object === rec.marker) this.transform.detach();
    this.fields.splice(i, 1);
    this.fieldGroup.remove(rec.marker);
    this.disposeMarker(rec.marker);
    if (this.selectedField === rec) this.selectedField = null;
    for (const e of this.entities) e.body.wakeUp();
    this.onFieldChange?.();
  }

  /** This field's own strength (independent of the global multiplier). */
  setFieldStrengthOf(rec: FieldRec, strength: number) {
    rec.field.strength = strength;
    for (const e of this.entities) e.body.wakeUp();
    this.onFieldChange?.();
  }

  /** Resize the region. `size` is per-axis (sphere uses .x as radius; cylinder .x=radius, .y=½height). */
  setFieldSize(rec: FieldRec, size: THREE.Vector3) {
    rec.field.size.set(Math.max(0.5, size.x), Math.max(0.5, size.y), Math.max(0.5, size.z));
    this.rebuildMarker(rec); // geometry changed → redraw the region halo
    for (const e of this.entities) e.body.wakeUp();
    this.onFieldChange?.();
  }

  /** Change the region's shape (sphere / box / cylinder). The force stays confined to whatever it is. */
  setFieldShape(rec: FieldRec, shape: FieldShape) {
    rec.field.shape = shape;
    this.rebuildMarker(rec);
    for (const e of this.entities) e.body.wakeUp();
    this.onFieldChange?.();
  }

  /**
   * Auto-size and centre a field to the current crowd, so it actually reaches everything (the manual
   * fix from the 500-object test, where the default region under-reached a wide pile). Covers ~92% of
   * the objects (ignoring stray outliers) plus a margin. A region field gets that as its radius; a
   * gravity well is also lifted so its orbits clear the floor; a path field is centred and its curve
   * scaled to span the crowd. Operates on whatever the editor targets (a ghost/draft or a live field).
   */
  fitFieldToObjects(rec: FieldRec) {
    const ents = this.entities;
    if (!ents.length) return;
    let cx = 0, cy = 0, cz = 0;
    for (const e of ents) { const t = e.body.translation(); cx += t.x; cy += t.y; cz += t.z; }
    const n = ents.length; cx /= n; cy /= n; cz /= n;
    const dists = ents.map((e) => { const t = e.body.translation(); return Math.hypot(t.x - cx, t.y - cy, t.z - cz); }).sort((a, b) => a - b);
    const cover = dists[Math.floor(0.92 * (dists.length - 1))]; // 92nd percentile — robust to stray escapees
    const f = rec.field;
    if (f.kind === 'path') {
      f.pos.set(cx, Math.max(cy, 1.5), cz);
      rec.marker.position.copy(f.pos);
      this.setPathScale(rec, Math.max(2, cover));
      this.setFieldSize(rec, new THREE.Vector3(Math.max(2, cover * 0.4), f.size.y, f.size.z)); // tube = size.x
    } else {
      const r = Math.max(3, cover + 3); // + margin so the soft boundary shell still covers the edge bodies
      const posY = f.kind === 'gravitywell' ? Math.max(cy + r * 0.4, 8) : cy; // lift a well so orbits clear the floor
      f.pos.set(cx, posY, cz);
      rec.marker.position.copy(f.pos);
      this.setFieldSize(rec, new THREE.Vector3(r, r, r));
    }
    if (this.transform.object === rec.marker) this.transform.attach(rec.marker);
    this.onFieldChange?.();
  }

  /** Hide/show a field's region marker. Hidden = invisible in the scene but STILL exerting force. */
  setFieldHidden(rec: FieldRec, hidden: boolean) {
    rec.field.hidden = hidden;
    rec.marker.visible = !hidden;
    this.onFieldChange?.();
  }

  /**
   * Set a path field's flow curve from any equations — a preset, a catalog pick, or the user's own
   * x(t),y(t),z(t). Re-samples and redraws. Returns false (leaving the current curve untouched) if
   * the equations don't parse or the curve isn't finite, so the editor can flag a bad formula.
   */
  setPathSpec(rec: FieldRec, spec: CurveSpec, label: string): boolean {
    const p = rec.field.path;
    if (!p) return false;
    const s = samplePath(spec, p.scale);
    if (!s) return false;
    p.spec = spec; p.label = label; p.pts = s.pts; p.tans = s.tans; p.closed = s.closed;
    p.drawn = undefined; // applying real equations turns a once-drawn curve back into an equation curve
    this.rebuildMarker(rec);
    for (const e of this.entities) e.body.wakeUp();
    this.onFieldChange?.();
    return true;
  }

  /** Resize a path field's curve (its overall extent, separate from the tube's capture radius). */
  setPathScale(rec: FieldRec, scale: number) {
    const p = rec.field.path;
    if (!p) return;
    p.scale = Math.max(0.5, scale);
    if (p.drawn) {
      // a freehand curve has no equation to re-sample — re-scale the stored unit stroke geometrically
      const s = this.scaledFromUnit(p.drawn, p.scale, p.closed);
      p.pts = s.pts; p.tans = s.tans;
    } else {
      const s = samplePath(p.spec, p.scale);
      if (!s) return;
      p.pts = s.pts; p.tans = s.tans; p.closed = s.closed;
    }
    this.rebuildMarker(rec);
    for (const e of this.entities) e.body.wakeUp();
    this.onFieldChange?.();
  }

  /** Toggle a flow tube's lift: on = suspend gravity inside it, so bodies can ride a 3D curve up into
   *  the air (Lissajous, Viviani, a rising spiral) instead of dropping out the bottom of the tube. */
  setPathLift(rec: FieldRec, on: boolean) {
    rec.field.lift = on;
    for (const e of this.entities) e.body.wakeUp();
    this.onFieldChange?.();
  }

  /** 0 = flow straight along the path; higher = corkscrew swirl around it (a vortex tube). */
  setPathSwirl(rec: FieldRec, swirl: number) {
    const p = rec.field.path;
    if (!p) return;
    p.swirl = Math.max(0, swirl);
    for (const e of this.entities) e.body.wakeUp();
    this.onFieldChange?.();
  }

  /** The field the gizmo/keys currently drive: the ghost being placed, else the selected one. */
  get activeField(): FieldRec | null { return this.placing ?? this.selectedField; }
  get isPlacing(): boolean { return this.placing !== null; }
  get isEditing(): boolean { return this.editingOriginal !== null; } // editing a live field via a draft
  get editingField(): FieldRec | null { return this.editingOriginal; } // the live field being edited
  get placementValid(): boolean { return this.placeValid; }

  /** Delete whatever the editor is pointed at: the field being edited, else the plain selection. */
  removeActiveField() {
    if (this.editingOriginal) {
      const orig = this.editingOriginal;
      this.cancelPlace(); // discard the draft + restore the original's marker, then remove it
      this.removeField(orig);
    } else if (this.selectedField && !this.placing) {
      this.removeField(this.selectedField);
    }
  }
  get lockedAxis(): 'x' | 'y' | 'z' | null { return this.axisLock; }
  get gizmoMode(): string { return this.transform.mode; }

  private attachGizmo(rec: FieldRec, mode: 'translate' | 'rotate') {
    this.transform.setMode(mode);
    this.transform.attach(rec.marker);
    this.setAxisLock(null);
  }

  /** X/Y/Z lock one axis (press again to release) — the gizmo then shows only that handle. */
  setAxisLock(a: 'x' | 'y' | 'z' | null) {
    this.axisLock = a;
    this.transform.showX = !a || a === 'x';
    this.transform.showY = !a || a === 'y';
    this.transform.showZ = !a || a === 'z';
    this.onFieldChange?.();
  }

  /** Move the active field by `d` (used by the arrow keys). */
  nudgeField(d: THREE.Vector3) {
    const rec = this.activeField;
    if (!rec) return;
    rec.marker.position.add(d);
    this.syncFieldFromMarker(rec);
  }

  /** Pull pos/orientation back off the marker after the gizmo or a nudge moved it. */
  private syncFieldFromMarker(rec: FieldRec) {
    rec.field.pos.copy(rec.marker.position);
    rec.field.quat.copy(rec.marker.quaternion); // region axes + wind direction (= quat·+X)
    if (this.placing === rec) this.refreshPlaceValidity();
    else for (const e of this.entities) e.body.wakeUp(); // a live field moved — re-wake its victims
    this.onFieldChange?.();
  }

  /** A ghost is invalid below the floor or off the world — tinted red, and Enter won't place it. */
  private refreshPlaceValidity() {
    const rec = this.placing;
    if (!rec) return;
    const p = rec.field.pos;
    this.placeValid = p.y >= 0.3 && Math.abs(p.x) <= 245 && Math.abs(p.z) <= 245;
    this.tintMarker(rec.marker, this.placeValid ? FIELD_INFO[rec.field.kind].color : 0xdc4a4a);
  }

  private tintMarker(marker: THREE.Object3D, hex: number) {
    marker.traverse((o) => {
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      const col = (mat as unknown as { color?: THREE.Color } | undefined)?.color;
      if (col) col.setHex(hex);
    });
  }

  /** Remember the core (the click handle + pulse target) and point it back at its record. */
  private tagMarker(rec: FieldRec) {
    rec.marker.traverse((o) => {
      if (o.userData.fieldCore) { o.userData.rec = rec; rec.core = o; }
    });
  }

  private rebuildMarker(rec: FieldRec) {
    const attached = this.transform.object === rec.marker;
    const pos = rec.marker.position.clone(), quat = rec.marker.quaternion.clone();
    if (attached) this.transform.detach();
    this.fieldGroup.remove(rec.marker);
    this.disposeMarker(rec.marker);
    rec.marker = this.makeFieldMarker(rec.field);
    rec.marker.position.copy(pos);
    rec.marker.quaternion.copy(quat);
    rec.marker.visible = !rec.field.hidden;
    this.fieldGroup.add(rec.marker);
    this.tagMarker(rec);
    if (this.placing === rec) this.refreshPlaceValidity();
    if (attached) this.transform.attach(rec.marker);
  }

  /** The field under the cursor, picked by its solid core (the big halo would swallow every click). */
  private pickField(): FieldRec | null {
    for (const h of this.raycaster.intersectObjects(this.fieldGroup.children, true)) {
      if (h.object.userData.fieldCore) return (h.object.userData.rec as FieldRec) ?? null;
    }
    return null;
  }

  clearFields() {
    this.cancelPlace();
    this.transform.detach();
    this.selectedField = null;
    for (const f of this.fields) this.disposeMarker(f.marker);
    this.fieldGroup.clear();
    this.fields.length = 0;
    this.onFieldChange?.();
  }

  setFieldStrength(v: number) {
    this.fieldStrength = v;
    for (const e of this.entities) e.body.wakeUp();
  }

  get fieldCount(): number { return this.fields.length; }

  /** Live fields, for the panel's list (so a hidden field is still selectable). */
  get fieldList(): FieldRec[] { return this.fields; }

  /** Geometry outlining a field's region, in its local frame (the group carries pos + orientation). */
  private shapeGeometry(field: Field): THREE.BufferGeometry {
    const s = field.size;
    if (field.shape === 'box') return new THREE.BoxGeometry(s.x * 2, s.y * 2, s.z * 2);
    if (field.shape === 'cylinder') return new THREE.CylinderGeometry(s.x, s.x, s.y * 2, 28, 1);
    return new THREE.SphereGeometry(s.x, 24, 16);
  }

  private makeFieldMarker(field: Field): THREE.Object3D {
    const info = FIELD_INFO[field.kind];
    const g = new THREE.Group();
    g.position.copy(field.pos);
    g.quaternion.copy(field.quat); // region orientation (also aims wind's arrow, which points local +X)

    if (field.kind === 'path' && field.path) {
      this.addPathMarker(g, field, info.color);
    } else {
      // the region hull — translucent so you see the confined space and its boundary
      const hull = new THREE.Mesh(
        this.shapeGeometry(field),
        new THREE.MeshBasicMaterial({ color: info.color, transparent: true, opacity: 0.08, depthWrite: false }),
      );
      g.add(hull);
      // a wireframe edge makes box/cylinder read clearly and marks the smooth boundary shell
      g.add(new THREE.LineSegments(
        new THREE.WireframeGeometry(hull.geometry),
        new THREE.LineBasicMaterial({ color: info.color, transparent: true, opacity: 0.28 }),
      ));

      if (field.kind === 'wind') {
        const len = Math.min(field.size.x, 3.4);
        g.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), Math.max(len, 1.6), info.color, 0.9, 0.6));
      } else if (field.kind === 'vortex') {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(field.size.x * 0.62, 0.05, 8, 44),
          new THREE.MeshBasicMaterial({ color: info.color, transparent: true, opacity: 0.5 }),
        );
        ring.rotation.x = Math.PI / 2;
        g.add(ring);
      } else if (field.kind === 'gravitywell') {
        // concentric orbit rings in the well's spin plane — reads as "things circle here"
        for (const f of [0.35, 0.62, 0.85]) {
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(field.size.x * f, 0.04, 8, 48),
            new THREE.MeshBasicMaterial({ color: info.color, transparent: true, opacity: 0.4 }),
          );
          ring.rotation.x = Math.PI / 2;
          g.add(ring);
        }
      }
    }

    // every kind gets a solid core: it's the click handle, the gizmo's anchor, and the ghost's pulse
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.32, 16, 12),
      new THREE.MeshBasicMaterial({ color: info.color, transparent: true, opacity: 0.85 }),
    );
    core.userData.fieldCore = true;
    g.add(core);
    return g;
  }

  /** Draw a path field: the flow curve (bright), its capture tube (translucent), and flow arrows. */
  private addPathMarker(g: THREE.Group, field: Field, color: number) {
    const p = field.path!;
    const curvePts: THREE.Vector3[] = [];
    for (let i = 0; i < p.pts.length; i += 3) curvePts.push(new THREE.Vector3(p.pts[i], p.pts[i + 1], p.pts[i + 2]));
    if (curvePts.length < 2) return;

    // centerline (close the loop visually for closed curves)
    const linePts = p.closed ? [...curvePts, curvePts[0].clone()] : curvePts;
    g.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(linePts),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
    ));
    // the capture tube — bodies within this ride the flow; translucent so it reads as a region
    const curve = new THREE.CatmullRomCurve3(curvePts, p.closed);
    g.add(new THREE.Mesh(
      new THREE.TubeGeometry(curve, Math.max(32, curvePts.length), Math.max(field.size.x, 0.5), 12, p.closed),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.06, depthWrite: false }),
    ));
    // a handful of arrows showing which way the flow goes
    const arrows = 7;
    const step = Math.max(1, Math.floor(p.pts.length / 3 / arrows));
    for (let i = 0; i < p.pts.length / 3; i += step) {
      const dir = new THREE.Vector3(p.tans[i * 3], p.tans[i * 3 + 1], p.tans[i * 3 + 2]);
      const at = new THREE.Vector3(p.pts[i * 3], p.pts[i * 3 + 1], p.pts[i * 3 + 2]);
      g.add(new THREE.ArrowHelper(dir, at, 0.9, color, 0.35, 0.22));
    }
  }

  private disposeMarker(m: THREE.Object3D) {
    m.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) (mesh.material as THREE.Material).dispose();
    });
  }

  /** Remove a single entity: physics body (+ colliders), render mesh, registry, selection/grab. */
  deleteEntity(e: Entity) {
    const i = this.entities.indexOf(e);
    if (i < 0) return;
    if (this.grab?.entity === e) this.releaseGrab(); // before the body goes — the joint refs it
    this.removeJointsFor(e); // joints reference the body — drop them before it's gone
    if (this.connectA === e) this.connectA = null;
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
    this.clearJoints(); // joints reference bodies — remove them before the bodies
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

    // weld/hinge docking: draw pending pairs gently together until their colliders touch, then lock
    if (this.docks.length) this.stepDocks();

    // force brush: while the user holds + drags the brush, shove nearby bodies each step
    if (this.brushActive) this.applyBrush();

    // force fields: sum each field's force on every awake dynamic body, apply as impulse = F·dt
    if (this.fields.length) {
      for (const e of this.entities) {
        if (e.frozen) continue;
        const t = e.body.translation();
        this._p.set(t.x, t.y, t.z);
        const v = e.body.linvel();
        this._fieldV.set(v.x, v.y, v.z);
        const mass = e.body.mass();
        this._s.set(0, 0, 0);
        let liftInf = 0; // strongest gravity-suspension influence (a well's region, or a lift-flow tube)
        for (const { field } of this.fields) {
          fieldForce(field, this._p, this._fieldV, mass, this.fieldStrength, this._fieldF);
          this._s.add(this._fieldF);
          if (field.kind === 'gravitywell') liftInf = Math.max(liftInf, fieldInfluence(field, this._p));
          else if (field.kind === 'path' && field.lift) liftInf = Math.max(liftInf, pathInfluence(field, this._p));
        }
        // Suspend world gravity (∝ influence, so it fades at the boundary) inside a gravity well OR a
        // lift-enabled flow tube: the field's own force becomes the only thing acting, so bodies lift
        // off the floor and follow it — orbiting a well's centre, or riding a 3D flow curve up into the
        // air instead of falling out the bottom of the tube and stalling on floor friction.
        if (liftInf > 0) this._s.y += -this.gravityY * mass * liftInf;
        if (this._s.x || this._s.y || this._s.z) {
          e.body.applyImpulse({ x: this._s.x * FIXED, y: this._s.y * FIXED, z: this._s.z * FIXED }, true);
        }
      }
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
        // frozen reads as an icy glow; selection as a warm-grey lift; else no emissive
        selMat.emissive.setHex(e.frozen ? 0x1c4a7a : e === this.selected ? 0x3a4152 : 0x000000);
        continue;
      }
      const scale = e.kind === 'box' ? e.size * 2 : e.size; // box geo is unit cube; sphere geo is unit radius
      this._s.setScalar(scale);
      this._m.compose(this._p, this._q, this._s);
      // frozen → icy tint (takes priority so you can see what's held); else selected → highlight;
      // else the base look. Textured pools tint via instanceColor (multiplies the map).
      const col = e.frozen
        ? (e.mat.maps ? FROZEN_TINT : FROZEN_COLOR)
        : e.mat.maps
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

    // redraw each joint's connector line between its two live anchor points
    for (const j of this.joints) {
      anchorWorld(j.a.body, j.localA, this._p);
      anchorWorld(j.b.body, j.localB, this._s);
      const pos = j.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, this._p.x, this._p.y, this._p.z);
      pos.setXYZ(1, this._s.x, this._s.y, this._s.z);
      pos.needsUpdate = true;
    }
    // docks-in-progress: draw a center-to-center line so the pending link is visible while it closes
    for (const d of this.docks) {
      const ta = d.a.body.translation(), tb = d.b.body.translation();
      const pos = d.line.geometry.getAttribute('position') as THREE.BufferAttribute;
      pos.setXYZ(0, ta.x, ta.y, ta.z);
      pos.setXYZ(1, tb.x, tb.y, tb.z);
      pos.needsUpdate = true;
    }
    // an un-placed field breathes, so a ghost never reads as an already-placed one
    if (this.placing?.core) {
      this.placing.core.scale.setScalar(1 + Math.sin(performance.now() * 0.005) * 0.18);
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
    if (this.draw) { this.onDrawDown(e); return; } // a draw session owns BOTH mouse buttons
    if (e.button !== 0) return; // left button = pick/drag; right/middle handled by OrbitControls
    if (this.transform.axis !== null) return; // the placement gizmo owns this click
    this.pointerDownAt = { x: e.clientX, y: e.clientY };
    this.setPointer(e);

    // brush tool: hold + drag to push / pull / swirl nearby objects live (force applied each step)
    if (this.tool === 'brush') {
      if (this.updateBrushPoint()) { this.brushActive = true; this.controls.enabled = false; }
      return;
    }

    // a field's core is a click target: clicking one opens it for editing (via a preview draft)
    const field = this.pickField();
    if (field) { this.beginEdit(field); return; }
    if (this.selectedField && !this.placing) this.selectField(null); // clicked away → drop the gizmo

    // non-grab tools act on the picked object (or empty space) and never start a drag
    if (this.tool !== 'grab') {
      const picked = this.pick();
      if (picked) this.selected = picked.entity;
      if (this.tool === 'freeze' && picked) this.toggleFreeze(picked.entity);
      else if (this.tool === 'push' && picked) this.pushEntity(picked.entity);
      else if (this.tool === 'connect') this.connectPick(picked?.entity ?? null);
      return; // let OrbitControls keep the drag for camera moves
    }

    const hit = this.pick();
    if (hit) {
      this.releaseGrab(); // a second press mid-grab (multi-touch, missed pointerup) must not leak the joint
      if (hit.entity.frozen) { this.selected = hit.entity; return; } // frozen bodies don't grab
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
    if (this.draw) { this.onDrawMove(e); return; }
    if (this.brushActive) { this.setPointer(e); this.updateBrushPoint(); return; }
    if (!this.grab) return;
    this.setPointer(e);
    const hit = this.raycaster.ray.intersectPlane(this.grab.plane, this._p.clone());
    if (hit) this.grab.target.copy(hit);
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.draw) { this.onDrawUp(e); return; }
    if (this.brushActive) { this.brushActive = false; this.controls.enabled = true; return; }
    this.releaseGrab();
  };

  /** Set the brush's cursor point: the object under the cursor if any, else a horizontal plane at the
   *  camera focus height. Returns false if the ray hits nothing usable. */
  private updateBrushPoint(): boolean {
    const hit = this.pick();
    if (hit) { this.brushPoint.copy(hit.point); return true; }
    this.drawPlane.setFromNormalAndCoplanarPoint(_UP, new THREE.Vector3(0, this.controls.target.y, 0));
    const p = this.raycaster.ray.intersectPlane(this.drawPlane, new THREE.Vector3());
    if (p) { this.brushPoint.copy(p); return true; }
    return false;
  }

  setBrushMode(mode: BrushMode) { this.brushMode = mode; }
  get brush(): BrushMode { return this.brushMode; }

  /** Apply the force brush for one step: every dynamic body within BRUSH_RADIUS of the cursor point is
   *  steered toward a target velocity (away for push, toward for pull, tangential for swirl), eased by
   *  distance. Same velocity-target model as the fields, so it's a controlled shove, not a launch. */
  private applyBrush() {
    for (const e of this.entities) {
      if (e.frozen) continue;
      const t = e.body.translation();
      const dx = t.x - this.brushPoint.x, dy = t.y - this.brushPoint.y, dz = t.z - this.brushPoint.z;
      const d = Math.hypot(dx, dy, dz);
      if (d > BRUSH_RADIUS) continue;
      const falloff = 1 - d / BRUSH_RADIUS;
      let tx: number, ty: number, tz: number;
      if (this.brushMode === 'swirl') {
        const inv = 1 / (Math.hypot(dx, dz) || 1); // tangential about the vertical axis through the point
        tx = -dz * inv * BRUSH_SPEED; ty = 0; tz = dx * inv * BRUSH_SPEED;
      } else {
        const sign = this.brushMode === 'push' ? 1 : -1;
        const inv = 1 / (d || 1);
        tx = dx * inv * sign * BRUSH_SPEED; ty = dy * inv * sign * BRUSH_SPEED; tz = dz * inv * sign * BRUSH_SPEED;
      }
      const v = e.body.linvel();
      const k = e.body.mass() * BRUSH_RESPONSE * falloff * FIXED;
      e.body.applyImpulse({ x: (tx - v.x) * k, y: (ty - v.y) * k, z: (tz - v.z) * k }, true);
      e.body.wakeUp();
    }
  }

  // ---------------------------------------------------------------- draw a flow (grid canvas → path field)
  /**
   * Open the draw canvas: a floating white grid at the view centre, facing the camera so you sketch
   * straight onto it. Left-drag draws; right-drag tumbles the grid (so a stroke can climb into 3D);
   * erase mode rubs points out. OrbitControls is suspended — the grid owns both mouse buttons — until
   * you Place (→ a live flow field), Clear, or Cancel.
   */
  beginDraw() {
    if (this.draw) return;
    this.cancelPlace();
    this.selectField(null);
    const center = this.controls.target.clone();
    const grid = new THREE.GridHelper(20, 20, 0xffffff, 0x9fb2c8);
    const gm = grid.material as THREE.Material;
    gm.transparent = true; gm.opacity = 0.55; gm.depthWrite = false;
    const fill = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, side: THREE.DoubleSide, depthWrite: false }),
    );
    fill.rotation.x = -Math.PI / 2; // PlaneGeometry is in XY; lay it into the grid's XZ plane
    const group = new THREE.Group();
    group.add(grid, fill);
    group.position.copy(center);
    // orient the grid so its face (local +Y normal) points at the camera — you draw onto a surface
    // that's squarely in front of you, like a sketchpad held up to the screen
    const toCam = this.camera.position.clone().sub(center).normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(_UP, toCam);
    group.quaternion.copy(quat);
    this.scene.add(group);
    const line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: FIELD_INFO.path.color }));
    line.frustumCulled = false;
    this.scene.add(line);
    this.draw = { group, quat, center, plane: new THREE.Plane(), pts: [], line, mode: 'draw', stroking: false, rotating: false, lastPtr: { x: 0, y: 0 } };
    this.refreshDrawPlane();
    this.controls.enabled = false;
    this.onDrawChange?.();
  }

  setDrawMode(mode: 'draw' | 'erase') { if (this.draw) { this.draw.mode = mode; this.onDrawChange?.(); } }
  get drawing(): boolean { return this.draw !== null; }
  get drawMode(): 'draw' | 'erase' { return this.draw?.mode ?? 'draw'; }

  /** Wipe the current sketch but keep the canvas open (start over on the same grid). */
  clearDraw() {
    if (!this.draw) return;
    this.draw.pts = [];
    this.draw.line.geometry.setFromPoints([]);
  }

  /** Commit the sketch to a live flow field (if it's long enough) and close the canvas. */
  commitDraw() {
    if (!this.draw) return;
    const pts = this.draw.pts.map((p) => p.clone());
    this.endDraw();
    if (pts.length >= 3) this.createDrawnPath(pts);
  }

  /** Close the canvas without committing. */
  cancelDraw() { this.endDraw(); }

  private endDraw() {
    if (!this.draw) return;
    this.scene.remove(this.draw.group, this.draw.line);
    this.draw.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((mm) => mm.dispose());
    });
    this.draw.line.geometry.dispose();
    (this.draw.line.material as THREE.Material).dispose();
    this.draw = null;
    this.controls.enabled = true;
    this.onDrawChange?.();
  }

  /** Recompute the drawing plane from the grid's current orientation (its local +Y through the centre). */
  private refreshDrawPlane() {
    if (!this.draw) return;
    const n = _UP.clone().applyQuaternion(this.draw.quat);
    this.draw.plane.setFromNormalAndCoplanarPoint(n, this.draw.center);
  }

  private onDrawDown(e: PointerEvent) {
    const d = this.draw!;
    d.lastPtr = { x: e.clientX, y: e.clientY };
    if (e.button === 2) { d.rotating = true; return; } // right button tumbles the grid
    if (e.button !== 0) return;
    d.stroking = true;
    this.setPointer(e);
    if (d.mode === 'draw') this.addDrawPoint();
    else this.eraseAt(e.clientX, e.clientY);
  }

  private onDrawMove(e: PointerEvent) {
    const d = this.draw!;
    if (d.rotating) {
      const dx = e.clientX - d.lastPtr.x, dy = e.clientY - d.lastPtr.y;
      d.lastPtr = { x: e.clientX, y: e.clientY };
      this.rotateGrid(dx, dy);
      return;
    }
    if (!d.stroking) return;
    this.setPointer(e);
    if (d.mode === 'draw') this.addDrawPoint();
    else this.eraseAt(e.clientX, e.clientY);
  }

  private onDrawUp(e: PointerEvent) {
    const d = this.draw!;
    if (e.button === 2) { d.rotating = false; return; }
    d.stroking = false;
  }

  /** Add the point where the cursor ray meets the grid plane (spaced out so points aren't bunched). */
  private addDrawPoint() {
    const d = this.draw!;
    const hit = this.raycaster.ray.intersectPlane(d.plane, new THREE.Vector3());
    if (!hit) return;
    if (d.pts.length && hit.distanceTo(d.pts[d.pts.length - 1]) < 0.12) return;
    d.pts.push(hit);
    d.line.geometry.setFromPoints(d.pts);
  }

  /** Erase drawn points near the cursor in SCREEN space (works no matter how the grid has been turned). */
  private eraseAt(cx: number, cy: number) {
    const d = this.draw!;
    const proj = new THREE.Vector3();
    const keep = d.pts.filter((p) => {
      proj.copy(p).project(this.camera);
      const sx = (proj.x * 0.5 + 0.5) * innerWidth, sy = (1 - (proj.y * 0.5 + 0.5)) * innerHeight;
      return Math.hypot(sx - cx, sy - cy) > 16;
    });
    if (keep.length !== d.pts.length) { d.pts = keep; d.line.geometry.setFromPoints(d.pts); }
  }

  /** Tumble the grid from a right-drag: yaw about world-up, pitch about the camera's right axis. Drawn
   *  points stay put in the world, so rotating then drawing more builds the curve up in 3D. */
  private rotateGrid(dx: number, dy: number) {
    const d = this.draw!;
    const k = 0.01; // rad per pixel
    const yaw = new THREE.Quaternion().setFromAxisAngle(_UP, -dx * k);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0).normalize();
    const pitch = new THREE.Quaternion().setFromAxisAngle(right, -dy * k);
    d.quat.premultiply(yaw).premultiply(pitch);
    d.group.quaternion.copy(d.quat);
    this.refreshDrawPlane();
  }

  /**
   * Build a live path (flow) field from a freehand stroke. The polyline is simplified, centred, and
   * normalized to unit size (stored in `path.drawn` so the size input can re-scale it later — there's
   * no equation to re-sample). Closure is auto-detected so a drawn loop wraps. It reuses the whole
   * pathForce engine, so a drawn squiggle steers bodies exactly like a preset curve.
   */
  createDrawnPath(world: THREE.Vector3[]): FieldRec | null {
    const raw: THREE.Vector3[] = [];
    for (const p of world) if (!raw.length || p.distanceTo(raw[raw.length - 1]) > 0.15) raw.push(p.clone());
    if (raw.length < 3) return null; // too short to be a curve
    const c = new THREE.Vector3();
    for (const p of raw) c.add(p);
    c.divideScalar(raw.length);
    let maxR = 1e-3;
    for (const p of raw) maxR = Math.max(maxR, p.distanceTo(c));
    const closed = raw[0].distanceTo(raw[raw.length - 1]) < 0.15 * maxR + 0.3; // start ≈ end → a loop
    const n = closed ? raw.length - 1 : raw.length; // drop the duplicate endpoint on a closed loop
    const unit = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const d = raw[i].clone().sub(c).divideScalar(maxR);
      unit[i * 3] = d.x; unit[i * 3 + 1] = d.y; unit[i * 3 + 2] = d.z;
    }
    const scale = maxR;
    const { pts, tans } = this.scaledFromUnit(unit, scale, closed);
    const tube = THREE.MathUtils.clamp(maxR * 0.4, 1, 5); // capture radius scales with the drawing's size
    const field: Field = {
      id: this.nextFieldId++, kind: 'path', shape: 'sphere', pos: c.clone(),
      quat: new THREE.Quaternion(), size: new THREE.Vector3(tube, tube, tube),
      strength: FIELD_INFO.path.strength, hidden: false,
      path: { spec: { xt: '', yt: '', zt: '', t0: 0, t1: 1 }, label: 'Drawn', scale, swirl: 0, pts, tans, closed, drawn: unit },
    };
    const rec: FieldRec = { field, marker: this.makeFieldMarker(field) };
    this.fieldGroup.add(rec.marker);
    this.tagMarker(rec);
    this.fields.push(rec);
    for (const e of this.entities) e.body.wakeUp();
    this.onFieldChange?.();
    return rec;
  }

  /** Scale a unit polyline (bounding radius 1) to `scale` and recompute its unit tangents. */
  private scaledFromUnit(unit: Float32Array, scale: number, closed: boolean): { pts: Float32Array; tans: Float32Array } {
    const pts = new Float32Array(unit.length);
    for (let i = 0; i < unit.length; i++) pts[i] = unit[i] * scale;
    const n = pts.length / 3;
    const tans = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = closed ? (i - 1 + n) % n : Math.max(0, i - 1);
      const b = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
      const dx = pts[b * 3] - pts[a * 3], dy = pts[b * 3 + 1] - pts[a * 3 + 1], dz = pts[b * 3 + 2] - pts[a * 3 + 2];
      const len = Math.hypot(dx, dy, dz) || 1;
      tans[i * 3] = dx / len; tans[i * 3 + 1] = dy / len; tans[i * 3 + 2] = dz / len;
    }
    return { pts, tans };
  }

  /**
   * Keyboard placement, modelled on Blender's modal transform (the pattern precise users reach for):
   * X/Y/Z locks an axis, the arrows nudge along it, Shift is the fine step, Enter commits, Esc backs
   * out. Only active while a field is being placed or is selected, and never while you're typing.
   */
  private onKeyDown = (ev: KeyboardEvent) => {
    const el = ev.target as HTMLElement | null;
    const typing = !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'MATH-FIELD'].includes(el.tagName));
    // draw canvas shortcuts: Enter places the flow, Esc cancels, E toggles draw/erase
    if (this.draw && !typing && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      if (ev.key === 'Enter') { this.commitDraw(); return; }
      if (ev.key === 'Escape') { this.cancelDraw(); return; }
      if (ev.key.toLowerCase() === 'e') { this.setDrawMode(this.draw.mode === 'draw' ? 'erase' : 'draw'); return; }
    }
    const rec = this.activeField;
    if (!rec || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'MATH-FIELD'].includes(t.tagName))) return;

    const step = ev.shiftKey ? 0.1 : 1; // 1 = the floor grid; Shift = fine
    const k = ev.key;
    const lower = k.toLowerCase();
    if (lower === 'x' || lower === 'y' || lower === 'z') {
      const a = lower as 'x' | 'y' | 'z';
      this.setAxisLock(this.axisLock === a ? null : a);
    } else if (k === 'Enter') {
      if (this.placing) this.commitPlace();
    } else if (k === 'Escape') {
      if (this.placing) this.cancelPlace(); else this.selectField(null);
    } else if (k === 'Delete' || k === 'Backspace') {
      this.removeActiveField();
    } else if (lower === 'r' && (rec.field.kind === 'wind' || rec.field.kind === 'path' || rec.field.shape !== 'sphere')) {
      this.transform.setMode(this.transform.mode === 'rotate' ? 'translate' : 'rotate'); // aim wind / turn the region or path
      this.onFieldChange?.();
    } else if (lower === 'g') {
      this.transform.setMode('translate');
      this.onFieldChange?.();
    } else {
      const d = this.nudgeVector(k, step);
      if (!d) return;
      this.nudgeField(d);
    }
    ev.preventDefault();
  };

  /** Arrow/PageUp keys → a world-space step. With an axis locked, all arrows drive that axis. */
  private nudgeVector(key: string, step: number): THREE.Vector3 | null {
    const a = this.axisLock;
    if (a) {
      const sign = key === 'ArrowUp' || key === 'ArrowRight' ? 1 : key === 'ArrowDown' || key === 'ArrowLeft' ? -1 : 0;
      if (!sign) return null;
      return new THREE.Vector3(a === 'x' ? sign * step : 0, a === 'y' ? sign * step : 0, a === 'z' ? sign * step : 0);
    }
    switch (key) { // unlocked: arrows sweep the floor plane, PageUp/Down climb
      case 'ArrowLeft': return new THREE.Vector3(-step, 0, 0);
      case 'ArrowRight': return new THREE.Vector3(step, 0, 0);
      case 'ArrowUp': return new THREE.Vector3(0, 0, -step);
      case 'ArrowDown': return new THREE.Vector3(0, 0, step);
      case 'PageUp': return new THREE.Vector3(0, step, 0);
      case 'PageDown': return new THREE.Vector3(0, -step, 0);
      default: return null;
    }
  }

  private onResize = () => {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  };
}

const SELECT_COLOR = new THREE.Color('#ffffff');
const WHITE = new THREE.Color(1, 1, 1);
const SELECT_TINT = new THREE.Color(1.5, 1.6, 1.9); // >1 brightens the texture under the tint
const FROZEN_COLOR = new THREE.Color('#8fc4ff'); // plain frozen bodies: icy blue
const FROZEN_TINT = new THREE.Color(0.7, 0.95, 1.6); // textured frozen bodies: cool tint over the map
