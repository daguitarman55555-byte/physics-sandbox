# Feature catalog — everything we discussed

A checklist so nothing is lost. `[x]` = in Phase 1 today · `[ ]` = planned (with its home).

## Core (Phase 1)
- [x] Real-time engine, 100+ objects @ 60fps (Rapier + InstancedMesh)
- [x] Fixed timestep + render interpolation (glassy motion; catch-up clamp)
- [x] Spawn box / sphere / +100
- [x] Drag & throw — physical point-grab: a ball joint at the grab point, so gravity/inertia keep
      acting while held (lift a rod by one end and it swings); clamped anchor speed, no teleport
- [x] Orbit / pan / zoom camera
- [x] Gravity slider + Earth/Moon/Zero-G, reset scene
- [x] Object inspector (live speed, angular vel, mass, energy, sleep) + FPS/count HUD

## Shapes — `systems/shapes.ts` (Phase 2)
- [x] `f(x)` solids of revolution — LatheGeometry + **exact analytic mass/inertia tensor** (Simpson
      quadrature of the profile), convex-hull collider, safe expression parser (`systems/expr.ts`),
      Vase/Egg/Top/Dome presets, live volume/mass preview
- [x] **Parametric curves** x(t),y(t),z(t) → swept tubes (springs, knots, rings, waves) — TubeGeometry
      render, mass/c.o.m./**full inertia tensor** integrated along the centerline (per-segment cylinder
      terms, Jacobi-diagonalized → principal moments + frame for Rapier), **capsule-chain collider**
      (coils stay hollow — no convex-hull cheating), Spring/Knot/Ring/Wave presets
- [x] **3D shape preview popup** — floating draggable window with its own renderer; live-updates as
      you edit any custom-shape creator (revolution + parametric curve)
- [ ] **Parametric surfaces** x(u,v)… → arbitrary surfaces (torus, seashells, Möbius)
- [ ] Implicit / SDF surfaces (gyroids, metaballs) · superformula (shells, flowers)
- [ ] Freehand draw → extrude/revolve · compound objects · boolean CSG
- [ ] Convex-decomposition colliders · **GLTF/OBJ/STL import** · big preset catalog

## Materials — `systems/materials.ts` (Phase 3)
- [ ] Presets (wood/metal/rubber/ice/stone) · density/friction/restitution
- [ ] **Texture upload** (albedo/normal/roughness/metalness PBR maps)
- [ ] **Element database → compound builder → alloy/mixture composer** ("22% gold, 73% silver")
- [ ] Mass from shape × density; famous alloys tabled (blending is a model, not chemistry)

## Forces & fields — `systems/fields.ts` (Phase 4)
- [ ] Gravity direction/strength/per-object/zero-G
- [ ] Force fields: attractor · repeller · wind · vortex · buoyancy zone
- [ ] Joints & motors: hinge · slider · spring · fixed · rope
- [ ] Tools: push · blow · freeze · duplicate · delete

## Effects & chemistry — `systems/effects.ts`, `systems/chemistry.ts` (Phase 5)
- [ ] Temperature: heat sources · conduction · thermal expansion · melt→swap (Module T rule)
- [ ] Electric charge (Coulomb) + sparks · magnetism + field lines · wires/current
- [ ] Reactions: rule + **bond-energy** model · build molecules (valence) · kinetics · molecular dynamics

## Advanced matter — `systems/deformation.ts` (Phase 6)
- [ ] **Deformation** (the physics-lab fix): resize/morph → **XPBD soft bodies** → plastic dents
- [ ] Fracture & destruction (fracture research track) · fluids/particles (GPU) · cloth & rope

## UX & sharing — `systems/share.ts` (Phase 7)
- [ ] Save/load (JSON) + share URLs · record → GIF/MP4
- [ ] Time: pause/step/slow-mo/**rewind** · debug overlays · undo/redo · scene library

## Inspector & selection — `systems/inspector.ts`
- [x] Single-select + live read-out (+ shape label for custom objects) + **Delete object** button
- [x] **Free-body forces view** — isolated 3D render of the selection, centered, live orientation,
      force arrows (weight / net / contact / velocity) + values
- [x] All panels are **windows**: drag by header, resize (contents & mini-renderers reflow)
- [x] **Forces window** — floating readout tracked above the selected object: weight m·g, measured
      net force ΣF = m·a, contact/friction/drag decomposition, velocity, momentum, KE, contact count
- [x] **Delete all** button (below Reset scene) — clears the world without respawning defaults
- [x] **Live KaTeX math** — creator expressions render as pretty math (Desmos-style) under each input
      and in the preview popup, via an AST→LaTeX emitter in `systems/expr.ts` (same parse, no drift)
- [ ] Shift-multi-select · marquee/box select · **editable** properties (set velocity, scale, density)
- [ ] Density-distribution heatmap (Module M) · molecular-arrangement lattice view (doorway to zoom-in)

## Separate worlds — `worlds/`
- [ ] **Cosmos**: N-body (symplectic) · orbits/Kepler/Lagrange · stellar life cycles → supernovae ·
      radiation pressure · atmospheric entry · Roche tides · black holes (BlackHoleSim) · megastructures · cosmic web
- [ ] **Quantum**: split-step Fourier · double-slit · tunnelling · orbitals · wave packets · qubits/gates/entanglement/BB84
- [ ] **Subatomic**: Standard Model · build proton from quarks · toy collider · fission/fusion

## Cross-cutting / signature
- [ ] **Scale transitions** (Powers-of-Ten zoom: material→lattice→atom→nucleus→quarks, and out→Cosmos)
- [ ] **Portable AI scenario builder** — `systems/ai.ts` (export prompt → paste JSON → validate → build)
- [ ] **Live sensors & graphs** — `systems/sensors.ts` (verified-physics teaching angle)
- [ ] Deterministic **ghost replay** · falling-sand cellular materials · electronics/logic · challenges/puzzles
- [ ] **2D mode** (Rapier2D) · **terrain editing** — `systems/terrain.ts` (heightfield + voxel/SDF, water, procedural)

## North stars (separate future projects)
- [ ] **Physics-Minecraft** (voxel world + real materials + structural integrity + destruction/deformation)
- [ ] **Robot spatial brain** (scan → digital twin → path/trajectory planning → sim-to-real; determinism is the edge)
