# Roadmap

Every phase ships on its own — reorder, skip, or stop anywhere and still have something real.
Tags: ♻ = reuse/upgrade of a prior engine (RealisticPhysicsEngine / physics-lab / BlackHoleSim), ✦ = new.

## App 1 — Rigid Sandbox (the spine)

### Phase 1 — Real-time core ✅ DONE
Rapier + Three + Vite · 100+ objects @ 60fps via InstancedMesh · fixed timestep + interpolation ·
spawn (box/sphere/+100) · drag & throw · orbit camera · gravity slider + presets · reset · object
inspector · FPS/count HUD.

### Phase 2 — Shape creation ✦♻ (the differentiator) — *in progress*
`f(x)` solids of revolution ✅ (exact analytic mass/inertia) · **parametric curves** (springs, knots) &
**surfaces** (arbitrary shapes) · implicit/SDF (gyroids, metaballs) · superformula · freehand draw →
extrude/revolve · compound objects (♻ FixedJoint) · boolean/CSG · convex-decomposition colliders ·
GLTF/OBJ/STL import + a big preset catalog. Mass for non-revolution shapes via the Module-M voxel path.

### Phase 3 — Materials & mass ✦♻
Presets (wood/metal/rubber/ice/…) · density/friction/restitution (♻ combine rules) · **texture upload**
(PBR maps) · **element → compound → alloy composer** (density by rule of mixtures; famous alloys tabled).

### Phase 4 — Forces & fields ✦♻
Gravity direction/strength/per-object/zero-G · force fields (attractor/repeller/wind/vortex/buoyancy) ·
joints & motors (♻ hinge/slider/spring/fixed) · tools (push/blow/freeze/duplicate/delete).

### Phase 5 — Heat · charge · magnetism ✦♻
Temperature (♻ Module T one-way coupling): heat sources, conduction, thermal expansion, melt→swap ·
electric charge (Coulomb) + sparks · magnetism + field lines · wires/current. **Chemistry & reactions**
layer: rule + bond-energy reactions, build molecules, kinetics, optional molecular dynamics.

### Phase 6 — Advanced matter ✦♻
**Deformation** (the physics-lab failure, done right): resize/morph → **XPBD soft bodies** → plastic dents.
Fracture & destruction (♻ fracture research track). Fluids/particles (GPU). Cloth & rope.

### Phase 7 — Make it yours & shareable ✦♻
Save/load (JSON) + share URLs · record → GIF/MP4 · time controls (pause/step/slow-mo/**rewind**) ·
debug overlays (♻ Phase 11 viewer) · undo/redo · scene library.

## App 2 — Cosmos (astrophysics) ✦♻
N-body gravity (symplectic integrator ♻) · orbits/Kepler/Lagrange · galaxy collisions · stellar life
cycles → supernovae · radiation pressure · atmospheric entry · Roche-limit tides · black holes
(♻ BlackHoleSim) · spacecraft & megastructures · cosmic web.

## App 3 — Quantum Lab & Subatomic ✦
**Quantum** (atomic scale): wavefunctions via split-step Fourier — double-slit, tunnelling, orbitals,
wave packets; qubit/gates/entanglement/BB84 playground.
**Subatomic** (particle physics — a scale below): Standard Model explorer, build a proton from quarks,
toy collider, fission/fusion.

## Cross-cutting / signature
**Scale transitions** — the "Powers of Ten" zoom: out → planet → Cosmos; in → crystal lattice → atom →
nucleus → quarks. A camera + crossfade handoff between worlds (orchestration, not new physics).
**Portable AI scenario builder** · live **sensors & graphs** (verified-physics teaching) · deterministic
**ghost replay** · falling-sand cellular materials · electronics/logic · challenges/puzzles ·
**2D mode** (Rapier2D) · **terrain editing** (heightfield + voxel/SDF, water, procedural).

## North stars (separate future projects)
- **Physics-Minecraft** — voxel world with real materials, structural integrity, destruction, deformation.
- **Robot spatial brain** — scan → digital twin → plan paths/trajectories → sim-to-real (determinism is the edge).
