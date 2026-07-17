# Feature catalog — everything we discussed

A checklist so nothing is lost. `[x]` = in Phase 1 today · `[ ]` = planned (with its home).

## Core (Phase 1)
- [x] Real-time engine, 100+ objects @ 60fps (Rapier + InstancedMesh)
- [x] Fixed timestep + render interpolation (glassy motion; catch-up clamp)
- [x] Spawn box / sphere / +100
- [x] Drag & throw — physical point-grab: a ball joint at the grab point, so gravity/inertia keep
      acting while held (lift a rod by one end and it swings); clamped anchor speed, no teleport;
      floor clamp uses the exact support point for every shape (hull/slab/capsule-aware)
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
      (coils stay hollow — no convex-hull cheating; end caps trimmed to land exactly on open curve
      ends), Spring/Knot/Ring/Wave presets
- [x] **3D shape preview popup** — floating draggable window with its own renderer; live-updates as
      you edit any custom-shape creator (revolution + parametric curve + parametric surface)
- [x] **Parametric surfaces** x(u,v),y(u,v),z(u,v) — grid-sampled + triangulated; **shell mode**
      (thin wall of thickness h, any surface — exact triangle-lamina second moments + h²/12 term)
      or **solid mode** (closed surfaces — exact polyhedron mass via divergence theorem / signed
      tets); closure auto-detected (seams + poles; a Möbius correctly reads open); full tensor →
      principal frame; **slab-tiled compound collider** (one convex slab per coarse grid cell, so
      concavity is real: a ball threads a torus's hole, a bowl cups a marble — verified live);
      Torus / Hollow ball / Möbius / Ripple presets. Hollow vs solid = the classic 2/3·mR² vs
      2/5·mR² rolling race.
- [x] **Implicit surfaces** f(x,y,z) < 0 (gyroids, metaballs, hearts, blobs — topology no other
      creator can make) — **naive surface nets** mesh (table-free, watertight, boundary-capped to
      the cube domain), **Module-M voxel mass** (occupancy fractions → volume/c.o.m./full tensor;
      sphere within 0.2% of closed form), **greedy voxel-box compound collider** (concave-true:
      a marble free-falls through a gyroid's internal voids at exactly g — measured), box-projected
      UVs so materials work, Gyroid/Metaballs/Heart/Blob presets, debounced live preview
- [ ] Superformula (shells, flowers)
- [x] **Shape library** — a floating, tabbed catalog window over ~200 machine-validated formulas
      (`systems/catalog.ts`: 51 revolutions, 51 curves incl. torus-knot & Lissajous families,
      47 surfaces incl. seashells & superellipsoids, 47 implicits incl. TPMS lattices & CSG);
      clicking an entry fills the matching creator, pops its section open, live-updates the preview
- [ ] Freehand draw → extrude/revolve · compound objects · boolean CSG
- [ ] Convex-decomposition colliders · **GLTF/OBJ/STL import** · big preset catalog

## Materials — `systems/materials.ts` (Phase 3)
- [x] Presets (rubber/steel/ice/wood/stone + plain) · density/friction/restitution wired into every
      spawn & creator via the panel's **material picker** (one active material; creators' density
      inputs auto-sync, still editable) · CC0 PBR maps (`public/textures/`) with per-shape texture
      tiling (lathe wraps, tubes tile along their length, surfaces tile by parameter-line arc
      length) · per-(shape × material) InstancedMesh pools — 900 textured objects still hold the
      frame cap · dim RoomEnvironment so metal reads as metal
- [ ] **Texture upload** (albedo/normal/roughness/metalness PBR maps)
- [ ] **Element database → compound builder → alloy/mixture composer** ("22% gold, 73% silver")
- [ ] Mass from shape × density; famous alloys tabled (blending is a model, not chemistry)

## Forces & fields — `systems/fields.ts` (Phase 4)
- [ ] Gravity direction/strength/per-object/zero-G
- [x] **Field placement & editing** — picking a kind spawns a translucent **hologram** at the view
      centre that exerts **no force** until you confirm it (the commit-or-cancel pattern every 3D
      builder uses). Position it with an axis-constrained **gizmo** (three.js TransformControls,
      snapped to the 1-unit floor grid — axis constraint is the honest answer to "a 2D mouse can't
      pick a 3D point") or the keyboard, Blender-style: **X/Y/Z** locks an axis, **arrows**/**PgUp**/
      **PgDn** nudge, **Shift** = fine step, **Enter** places, **Esc** cancels. Ghost turns red and
      refuses to place off-world/below the floor. **R** aims a wind field (rotate mode). Fields are
      now **selectable** (click a field's core dot), **movable**, and **deletable individually**
      (**Del**) — previously the only recourse for a misplaced field was Clear-all. **Per-field**
      strength/radius are editable live (they used to be fixed presets under one global multiplier).
      Every field's **base region size is 10** (radius / half-extent) so they all start the same roomy
      size; the path/flow's base **curve size is 10** too, with a snug tube of 4.
- [x] **Path (flow) field** — the vortex generalized to any curve: bodies inside a **tube** around a
      flow curve are steered to ride ALONG it (look-ahead steering, so fast flow on a tight loop
      doesn't fling out) and drawn onto it, with an optional **swirl** that corkscrews them *around*
      the curve (a circle reproduces the plain vortex; a helix is a spiral updraft). Swirl scales with
      radius (0 on the centreline) so it's smooth, not a violent spin. On **open** curves bodies flow
      OUT the end (look-ahead extrapolates past it) instead of piling up. The curve can be a quick
      **preset**, one of **~90 in the library** (a "More…" popup: springs, spirals, waves, wires,
      torus knots, Lissajous, flowers, **spirographs**, **roses**, roulettes, butterfly, space
      curves — reusing `systems/catalog.ts`), or your **own equations** (a Desmos-style `x(t),y(t),
      z(t)` MathLive editor). Any curve is auto-centred, normalized to `scale`, and its closure is
      auto-detected. It is also **auto-oriented FLAT** by default (its best-fit plane, found by PCA, is
      laid horizontal) so it lands on a floor layer of objects and every preset does something visible —
      a Loop (a vertical circle in its raw equations) becomes a horizontal racetrack, while a genuinely
      3D curve (a Helix updraft, a trefoil knot) is left standing since it has no flat plane. Tilt it
      yourself afterwards with **R** / the rotate gizmo. The marker draws the curve, its tube, and arrows.
- [x] **Force fields** (`systems/fields.ts`) — attractor · repeller · wind · vortex · path, with
      translucent region markers, a live global strength slider, and clear-all. **One unified model:**
      every field builds a *target velocity* and steers bodies toward it, so **`strength` means the
      same on every kind** — a 5 is "move bodies at ~5 m/s," whether attractor, wind, vortex, or flow
      (verified: strength 5 → ~5 m/s peak on all). Each field is **confined to a region** with a
      **smooth (smoothstep) boundary** — full strength inside, easing to zero across the outer shell,
      zero outside; wind included (it used to be global/infinite). The **vortex swirls about the
      field's OWN axis** (tilt its region with R and the whirlpool tilts too). The region is a
      **shape you choose** — **sphere / box / cylinder** — sized per-axis, oriented with the rotate
      gizmo. Each
      field can be **hidden** (marker invisible, force still acting), toggled from the editor or a
      per-row eye in the **field list** (which also keeps hidden fields selectable). Applied as
      impulse = F·dt each fixed step.
- [x] **Draw a flow** (a **"✎ Draw a flow" button in the Fields & Forces panel**) — click it and a
      **floating white grid canvas** appears at the view centre, facing you. **Left-drag** sketches a
      stroke onto the grid; **right-drag tumbles the grid** so a single continuous stroke can climb into
      **true 3D** (drawn points stay put in world space, so you rotate the easel and keep drawing at a new
      angle); an **Erase** mode (or **E**) rubs points out in screen space. **Place** (or **Enter**) turns
      the polyline into a live **path (flow) field**; **Clear** restarts the sketch; **Cancel** / **Esc**
      closes it. Reuses the whole `pathForce` engine, so a drawn curve steers exactly like a preset; the
      stroke is simplified, centred, normalized (stored as `path.drawn` unit points so the size input can
      re-scale it), and its **closure is auto-detected**. The result is a normal path field — move / tilt
      (R / gizmo), resize its tube, toggle Lift, add swirl, or delete it like any other.
- [x] **Lift inside a flow tube** (path fields, `Lift` toggle) — suspend world gravity for bodies inside
      a flow tube (∝ the same smoothstep tube influence, via `pathInfluence`), so they ride a rising or
      3D curve **up into the air** instead of dropping out the bottom and stalling on the floor — a
      zero-gravity conveyor. Reuses the gravity-well's suspension trick. Off by default (flat floor flows
      don't need it). Verified: captured bodies climb a rising spiral/Viviani curve into an airborne arc
      (top-Y up, mean speed ~2.5× on Viviani). Honest limit: it helps the bodies a curve *captures*;
      whether a sparse 3D curve captures a compact floor pile still depends on sizing the curve to it.
- [x] **Force brush** (`Brush` tool: Push / Pull / Swirl) — hold and drag to shove objects live, no
      placed field (the Powder-Toy-style interaction). Each step, every dynamic body within a radius of
      the cursor point is steered toward a target velocity — **away** (push), **toward** (pull), or
      **tangential** (swirl) — eased by distance, using the same velocity-target model as the fields so
      it's a controlled shove, not a launch. The cursor point tracks the object under it, else a
      horizontal plane at the camera focus. Verified: push cleared a crater (48→5 bodies near the point),
      pull held them gathered, swirl spun them (tangential speed 4.5 vs ~0), camera control restored on
      release, no console errors.
- [x] **Fit field to objects** (`Fit to objects` button) — auto-centre and size any field to reach the
      whole crowd: covers the 92nd-percentile radius (robust to stray escapees) + a margin, so the region
      actually encloses the objects instead of under-reaching a wide pile (the manual fix from the
      500-object test). A gravity well is also lifted so its orbits clear the floor; a path field is
      centred and its curve scaled to span the crowd. Verified: on 200 spread objects it grew the well
      to enclose them and lifted moving-fraction 81% → 93%.
- [x] **Turbulence** (`systems/fields.ts`) — a **curl-of-noise** velocity field: bodies are steered
      toward the local curl of a 3D noise potential, which is **divergence-free**, so they churn and
      **eddy like leaves in gusty air** (scattered directions, no net push) instead of piling at a
      source. The pattern drifts over time so it's alive. Same target-velocity model — `strength` is the
      drift speed, mass-independent — confined + eased by the region like every field. Verified: heading
      scatter 0.84–0.94 (genuinely chaotic, not directional), ~84% of a crowd churning at default.
- [x] **Gravity well** (`systems/fields.ts`) — a **true Newtonian 1/r²** pull (Plummer-softened so
      it's finite at the centre). Unlike the attractor it is **conservative — no velocity-target
      damping** — so bodies keep their sideways speed and **ORBIT** instead of collapsing into a dead,
      jammed clump (the attractor's failure mode with a crowd: 100 objects piled up, ~1% still moving).
      A Coriolis-like **curl about the region axis** bends radial infall into orbits, so even a resting
      pile winds up as a spinning **accretion disc/cloud**; because that curl is ⊥ to velocity it does
      no work (no runaway spin). Inside the region **world gravity is suspended** (∝ influence), so
      bodies lift off the floor and circle the centre in free-fall rather than grinding orbits into the
      ground and stalling on friction. Its `strength` is the well's **mass**, not a target speed. Spawns
      **elevated** with a **generous default region** so it actually reaches a spread-out crowd.
      Verified: 100 objects → a fluid orbiting cloud, **93% moving** (vs the attractor's 1%), no errors.
- [x] **Joints** (`systems/joints.ts`) — the **connect tool** (click two objects): **weld** (fixed) ·
      **hinge** (an *edge pivot* — a real door hinge) · **spring** (damped tether) · **rope**
      (max-distance link).
      Weld & hinge **dock into true surface contact** before locking: a soft, mass-scaled damped
      spring (gravity suspended on the pair meanwhile, so it always reaches contact) draws them
      gently together with collisions left ON, so their real colliders — not a computed point — stop
      them exactly at the surface; the rigid joint then locks at that pose. So nothing smashes and
      nothing ends up inside anything else, at any shape / orientation (verified with diagonal &
      uneven blocks: dock peak ≈ 0.9 m/s, seats at contact, no clipping).
      The **edge pivot** additionally rotates the pair face-to-face on the way in (capped turn), then
      pivots on one **edge of the shared contact face** with an in-face, near-vertical axis (both read
      off the live contact manifold) — so it swings **open like a door** instead of sweeping through
      its partner. Collision within the pair stays ON for it, so it can never swing inside the other
      (verified: 45°-diagonal door turned in, seated at contact, swung 77° open, worst penetration
      2 mm). A locked weld instead turns collision OFF within the pair (it's one rigid body — can't
      clip itself, and it kills the collider-vs-joint jitter). Spring/rope stay center-to-center
      tethers. Live connector lines; removed automatically when either body is deleted. (Motors/slider
      still to come.)
- [x] **Tools** — a left-click **mode** selector: Grab (default) · Connect · **Freeze** (pin a body
      in place, icy tint; click again to release) · **Push** (shove away from the camera). (Blow /
      duplicate still to come.)

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
- [x] **Free-body forces view** — 3D render of the selection, live orientation, force arrows
      (weight / net / contact / velocity) + values. When the selection is **joined to other bodies**,
      the whole **connected assembly** is rendered (each body in its own material/texture, in its live
      relative pose; selected body at the origin where its arrows are) — the header reads "N-body
      system"
- [x] All panels are **windows**: drag by header, resize (contents & mini-renderers reflow)
- [x] **Collapsible panel sections** — Material / Spawn / creators / World; creators sit
      collapsed until needed, so the panel fits without scrolling; drag the panel by its title
- [x] **Material-true mini-views** — the shape-preview popup renders in the active material, the
      free-body view and inspector swatch (albedo thumbnail) render the selected object's own
      material with its world tiling
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
