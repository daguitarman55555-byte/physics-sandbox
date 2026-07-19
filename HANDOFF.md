# Physics Sandbox — Handoff

Paste this whole file as the first message in a new chat to continue the project with full context.

## What this is

A real-time, browser-based **physics sandbox** for play & learning (build things, break things, and
eventually zoom from a tabletop out to a solar system or down to atoms). It is a **separate project**
from `RealisticPhysicsEngine` (a from-scratch verified Python engine) — this one is play-focused and
built on a mature real-time engine.

- **Location:** `C:\Users\diand\Projects\physics-sandbox`
- **Stack:** Vite + TypeScript · Three.js (rendering) · Rapier `@dimforge/rapier3d-compat` (physics, Rust→WASM)
- **Run:** `cd` into the folder, `npm install` (first time), `npm run dev` → open the printed URL (http://localhost:5173)

## Current state — Phase 1 DONE and verified; Phase 2 in progress

Verified working: **800+ objects holding a solid 60 fps**, real shadows, no console errors.

Works now: fixed-timestep loop + render interpolation · `InstancedMesh` rendering (one draw call per
shape) · spawn box/sphere/+100 · drag & throw (clamped, no teleport/fling) · OrbitControls camera ·
gravity slider + Earth/Moon/Zero-G · reset · click-to-select **object inspector** (live speed, angular
velocity, mass, kinetic energy, sleep state) · FPS/object/awake HUD.

Phase 2 (shapes) — three slices shipped: `f(x)` solids of revolution (exact analytic mass/inertia),
**parametric curves** x(t),y(t),z(t) → swept tubes (springs, knots, rings; centerline-integrated mass +
full inertia tensor diagonalized to principal axes; capsule-chain colliders so coils stay hollow), and
**parametric surfaces** x(u,v),y(u,v),z(u,v) (grid-sampled + triangulated; **shell mode** = thin wall of
thickness h, works for any surface, exact triangle-lamina second moments; **solid mode** = filled body
via divergence-theorem signed tets, exact polyhedron mass — verified against closed forms to <0.15%;
closure auto-detected from seams/poles so a Möbius correctly reads open and refuses solid; convex-hull
collider, rounded outward by h/2 in shell mode; Torus / Hollow ball / Möbius / Ripple presets — hollow
vs solid ball is the 2/3·mR² vs 2/5·mR² rolling-race demo).
All custom-shape creators live-update a **3D preview popup** (floating, draggable) while you design,
and every expression renders as **live KaTeX math** (Desmos-style) under its input — `systems/expr.ts`
emits LaTeX from the same parse that compiles the evaluator. Selection now has a **forces window**
floating above the selected object (weight, measured ΣF = m·a, contact/drag decomposition, momentum,
contacts), a **Delete object** button in the inspector, and **Delete all** below Reset scene.
Collider fidelity (2026-07-14): surfaces use a **slab-tiled compound collider** (one small convex
hull per coarse grid cell, corners pushed ±h/2 along vertex normals for shells / a skin inside the
boundary for solids) — concavity is real and verified live: a marble settles inside a typed bowl, a
ball threads a torus's hole; flat sheets tile fine (no fallback needed). Open curves trim their end
capsules by one tube radius so caps land exactly on the curve ends. The drag floor-clamp now uses
the exact support point for custom shapes (hull points / slab corners / capsule ends). Remaining
honest notes: tube volume still ignores coil self-overlap (voxel path later), and V-HACD convex
decomposition stays relevant only for the future GLTF/OBJ/STL import (no grid to exploit there).
Phase 3 first slice shipped (2026-07-14): a **material picker** (Plain/Rubber/Steel/Ice/Wood/Stone
chips) drives every spawn and creator — density (water-units: kg/m³÷1000) × exact volume → mass,
friction/restitution → colliders, CC0 PBR maps (public/textures/) → appearance. Rendering scales
via per-(shape × material) InstancedMesh pools (900 textured objects hold the frame cap); texture
tiling is per-shape (lathe wraps, tubes tile along length, surfaces tile by parameter arc length);
a dim RoomEnvironment (intensity 0.3) makes metal read without brightening the dark look. The
panel is reorganized into collapsible sections (Material / Spawn / creators / World) — drag by the
title, creators collapsed by default; creators' density inputs auto-sync to the material.
Implicit surfaces shipped (2026-07-14, `systems/implicit.ts`): f(x,y,z) < 0 in a cube domain —
naive **surface nets** mesh (table-free marching-cubes cousin; boundary layer forced outside so
shapes cap watertight at the walls), **Module-M voxel mass** (per-cell occupancy fraction → V /
c.o.m. / full tensor; sphere within 0.2%, verified), collider = occupancy voxels **greedy-merged
into compound boxes** (concave-true — a marble placed in a gyroid's void free-falls at exactly g
through the internal labyrinth and exits the bottom; measured). Box-projected UVs (~2 m/tile) so
the material picker works on implicits. Presets: Gyroid / Metaballs / Heart / Blob. Honest notes:
collider is blocky at ~size/16 (walls thinner than a collider voxel can drop out — a lowered
occupancy threshold catches most), and balls roll far on the floor (no rolling resistance in
Rapier — a future materials knob).
Look pass (2026-07-14): ACES filmic tone mapping (exposure 1.2, also on the preview/forces mini-
renderers), env intensity 0.45; implicit meshes get a **smooth pass** — one Newton step projects
every vertex onto the exact isosurface (sphere radius spread → 0.0000) and field-gradient normals
replace topology normals (wall-cap vertices keep flat normals) — so hearts/gyroids shade smoothly
at any grid res; spheres at 48×32; tubes 16-sided; lathe 64 segments; texture anisotropy 8; sphere
pools tile [2,1] so texel aspect matches boxes; steel swapped to brushed Metal009 (polished
Metal049A read mirror-on-ball vs dark-mirror-on-flat-faces — brushed reads identical on both).
Catalog + polish (2026-07-15): a **shape library** window (floating, tabbed, draggable) browses
~200 machine-validated formulas in `systems/catalog.ts` (51 revolutions / 51 curves / 47 surfaces
/ 47 implicits, incl. torus-knot, Lissajous, TPMS and CSG families); each creator's "More…" opens
it, clicking an entry fills that creator and pops its section open. Implicit UVs are now
per-FACE box projections with duplicated seam vertices (per-vertex axes smeared a visible band
across e.g. the heart). All mini-views are material-true: preview popup uses the active material,
forces view + inspector swatch (albedo thumb) use the selected object's material + tiling
(sandbox.materialFor / previewMaterial; Entity.texRepeat). Steel = roughnessScale 0.62 +
envBoost 2.4 + metalness 0.85 (pure metalness-1 flat faces read as dark mirrors of the dim room).
Note: Rapier's body.mass() reads 0 in the same JS tick a body is created — it finalizes on the
next step; not a bug.
Also removed the Peanut implicit preset (its Cassini surface sat in the two-lobe regime: two blobs,
one body) and fixed the shape-preview KaTeX caption going invisible until the tab was resized (it
rendered before web fonts loaded → zero-height glyphs; now deferred past layout + re-rendered on
document.fonts.ready).
Phase 4 first slice shipped (2026-07-15) — the sandbox becomes playable:
  • **Force fields** (`systems/fields.ts`) — attractor / repeller / wind / vortex, added at the
    camera focus (controls.target) with translucent markers; a live global strength slider
    (sandbox.setFieldStrength) and Clear. Applied as impulse = F·dt each fixed step, before
    world.step(); frozen bodies are skipped. Radial ∝ mass w/ smooth radius cutoff; wind = constant
    directional force (not mass-scaled, so light things blow faster); **vortex steers toward a
    swirl+inward TARGET velocity** (needs the body's current velocity, passed into fieldForce) so
    objects orbit stably instead of a pure-tangential force flinging them out. Verified: attractor
    pulled spread 6.0→0.7, vortex holds 8 spheres in a ring.
  • **Joints** (`systems/joints.ts`) — the **connect tool** clicks two bodies to link them: weld
    (fixed, frame math preserves current relative pose so no snap), hinge (revolute about world-X),
    spring (JointData.spring, center-to-center), rope (JointData.rope, center-to-center). NB:
    spring/rope anchor at each body CENTER (localA=localB=0) so two boxes 2 apart stay ~2 apart;
    fixed/hinge share a midpoint pivot. Live connector lines updated each frame from anchorWorld();
    joints auto-removed when either body is deleted (removeJointsFor in deleteEntity + clearJoints
    in clear).
  • **Tools** — a left-click mode on the Sandbox (`tool`: grab | connect | freeze | push),
    intercepted in onPointerDown. Freeze switches a body Dynamic↔Fixed (icy emissive/tint via
    e.frozen in syncRender); Push applies a camera-forward impulse (mass-scaled ~9 m/s kick).
  • UI: new collapsible **Tools** and **Fields & Forces** sections (buildToolsSection /
    buildFieldsSection in ui.ts); joint-type chips show only in Connect mode. All four tools + four
    fields verified through real UI-button + canvas-pointer clicks.
Joints refinement (2026-07-15): weld & hinge now **dock into real surface contact** instead of
freezing at their spawn separation — and do it gently, without ever ending up inside each other, at
any orientation. Mechanism (all in sandbox.ts): on connect, weld/hinge don't create the rigid joint
immediately; they start a **DockRec** — a soft, mass-scaled damped **spring** (`JointData.spring(0,
4·mAvg, 6·mAvg, …)`) that pulls the pair together with **collisions left ON**, so the bodies' real
colliders (not a computed contact point) stop them exactly at the surface. `stepDocks` (in the
fixed-step loop, before `world.step`) also **cancels gravity on the docking pair** each step —
otherwise, when one body is frozen or much heavier, gravity stretches the soft spring to a hanging
equilibrium and they never touch. The instant `pairInContact` (a real contact manifold) is true, the
spring is removed and `lockJoint` creates the rigid weld/hinge at that pose. A locked **weld** turns
OFF collision within the pair (`joint.setContactsEnabled(false)`) — it's one rigid body, so it can't
clip itself and the colliders don't fight the joint (that fight was spinning fresh welds); a **hinge
keeps collision ON** so it can't swing inside its partner. Verified live with diagonal / uneven /
different-size blocks and a frozen anchor: dock peak ≈ 0.9 m/s (no violent snap), seats at true
contact (no clipping, no big gap), stable at rest. Earlier attempts that FAILED and why (don't repeat
them): a stiff fixed-joint anchor-tween to a support-extent contact point — the point is wrong for
uneven blocks (real colliders touch elsewhere first) so the stiff joint pulled past contact and
detonated; and velocity-override docking (`setLinvel` each step) — it erased the collision solver's
separating velocity, so they clipped straight through. The compliant spring is the key: the collision
solver can win against it.
The old centre-pivot hinge is GONE (2026-07-15) — replaced by an **edge pivot** (JointKind `'edge'`;
the UI chip still reads "Hinge"), i.e. a real door hinge. Two pieces sit on top of the same dock:
(1) `alignDock` gently rotates the free body to the other's orientation (velocity-capped ≤5 rad/s),
and the dock only locks once the pair is BOTH in contact AND aligned. This is REQUIRED because
Rapier's `JointData.revolute` takes a SINGLE axis applied to both bodies' local frames, so it
force-aligns their axes: lock it on misaligned bodies and it snaps them violently (measured — a
body 50° off swept 50° instantly). Aligning first leaves the revolute nothing to correct, so no snap.
(2) `computeEdge` reads the live contact manifold (`normal()` + `solverContactPoint(i)`) and pivots on
the contact point furthest to one side — an EDGE of the shared face — with the axis = the in-face
direction closest to vertical. So it swings OPEN like a door instead of sweeping through its partner,
and collision within the pair stays ON so it can never close into it. Verified: a 45°-diagonal wood
door + frozen stone post → turned in, seated at contact (penetration +0.001), swung 77° open, worst
penetration 2 mm.
The **forces window also renders the whole connected assembly** when the
selection is jointed: `Sandbox.assemblyOf(e)` BFS's the joint graph, and buildForcesView rebuilds a
group with one mesh per member — each in its own material/texture, placed in its live relative pose,
selected body at the origin where the force arrows are (header shows "N-body system"). Verified
2- and 3-body welds live.
Field placement + editing (2026-07-15): picking a field kind no longer dumps it at `controls.target`.
`beginPlace(kind)` spawns a **hologram** — a FieldRec held in `this.placing`, deliberately NOT in
`this.fields`, so it exerts zero force until `commitPlace()` (verified: ring of bodies unmoved at
spread 6.0 while ghosting, pulled to 0.87 once committed). `cancelPlace()` throws it away. Position
it with a **TransformControls gizmo** (`this.transform`, snap 1 = the floor grid, helper added via
`getHelper()` — r169+ made TransformControls a non-Object3D `Controls`, so `scene.add(transform)` is
WRONG now) or the keyboard (`onKeyDown`): X/Y/Z axis lock (drives `transform.showX/Y/Z`), arrows +
PgUp/PgDn nudge, Shift = 0.1 fine step, Enter place, Esc cancel, Del remove, R aims wind. The ghost's
core pulses (syncRender) and tints red when off-world/below floor (`refreshPlaceValidity`), and Place
is disabled then. Fields are now **selectable/movable/deletable individually**: every marker gets a
solid `core` mesh (userData.fieldCore → its FieldRec) as the click handle — `pickField()` accepts ONLY
core hits, since the big translucent halo would otherwise swallow every click. Per-field strength &
radius are live-editable (`setFieldProps`; a radius change rebuilds the marker so the halo matches its
reach). Wind's marker holds its direction in the group QUATERNION (arrow points local +X) so the
rotate gizmo can aim it; `dir` is read back off the quaternion. `sandbox.onFieldChange` re-renders the
panel. GOTCHA: `.hidden` had no generic CSS rule (only `#forces.hidden` etc.), so `classList.toggle
('hidden')` silently did nothing — added `.hidden { display: none !important; }` (needs !important to
outrank `button`/`.row` display rules).
NB for testing in the Claude browser: (1) the preview tab is heavily THROTTLED (rAF ~2-6 fps) and the
loop's MAX_CATCHUP clamp caps physics at 3 steps/frame, so sim time can run ~8x slower than wall
time — a dock needing ~2 s of sim can take ~20 s of wall clock. Poll on `sandbox.jointCount` instead
of assuming a fixed wait, or you'll wrongly conclude the dock is stuck (I did, twice). (2) If the pane
gets hidden, `document.hidden` goes true and rAF STOPS entirely (fps 0, screenshots time out) — it
looks exactly like a crash but isn't; `navigate` to the URL again to restore it. (3) `computer` clicks
are in SCREENSHOT pixel space, which is ~1.1x the page viewport here — convert before clicking, or you
will miss what you aimed at.
Field regions: shape, confinement, hide (2026-07-15). `Field` gained `shape` ('sphere'|'box'|
'cylinder'), `size: Vector3` (sphere→radius in .x; box→half-extents; cylinder→(radius,½height,radius)),
`quat` (region orientation; wind blows quat·+X — `dir` is GONE), and `hidden`. `fieldInfluence(field,
pos)` in fields.ts is the one confinement+falloff function: transforms the point into region-local
axes, computes a normalized reach `n` (sphere=dist/r, box=Chebyshev/∞-norm, cylinder=max(radial,axial)),
returns 1 for n≤SOFT_EDGE(0.55), smoothstep down to 0 by n=1, 0 outside — so a field only acts inside
its region with a smooth boundary (verified: sphere 1→0.83→0.31→0 across the edge; box 0 just past each
face). Wind was GLOBAL (radius 0) — now confined like the rest (verified: body inside blows 14 m/s, body
40 m away = 0). fieldForce multiplies every kind by this influence. Markers: `shapeGeometry` draws the
hull per shape + a WireframeGeometry edge so box/cylinder read; `setFieldHidden` sets `marker.visible`
(force still runs — the step loop never checks visibility, verified a hidden field still blows). UI
(`buildFieldsSection`): a **field list** (`sandbox.fieldList`) with per-row select + eye toggle keeps
hidden fields reachable; shape buttons; per-axis size inputs relabeled per shape; Hide/Show button.
`setFieldShape`/`setFieldSize` rebuild the marker. GOTCHA that cost me a test: don't assume a
freshly-placed field sits at (0,5,0) — `beginPlace` uses `controls.target`, (0,2,0) by default; probe
influence RELATIVE to `field.pos`.
Path (flow) field (2026-07-15): a 5th field kind `'path'` — the vortex generalized to any curve.
`Field.path?: FieldPath` = { preset, scale, swirl, pts, tans, closed } — a preset curve sampled to a
local-space polyline + unit tangents by `samplePath(preset, scale)` (reuses `parseExpression` from
expr.ts; presets in `PATH_PRESETS`: circle/loop/helix/figure8/wave). `size.x` is the TUBE (capture)
radius, `strength` is flow m/s. `pathForce` (in fields.ts, dispatched from fieldForce before the
point-field path): transform body into curve-local, find nearest sample, confine to the tube (same
smoothstep boundary), then **LOOK-AHEAD steering** — aim target velocity at the sample PATH_LOOKAHEAD
(4) ahead on the curve. That one vector follows curvature (centripetal) AND draws stray bodies on, in
one — the first attempt (tangent·speed + radial pull) let fast flow spiral out past the tube and escape
(radius 3→7); look-ahead fixed it (body hugs radius ~3.3 at speed 10, verified). `swirl>0` adds a
corkscrew about the tangent axis (tangent × radial); verified swirl adds out-of-plane velocity, and a
helix makes bodies rise. Marker (`addPathMarker`): the curve as a Line + a translucent TubeGeometry at
capture radius + ArrowHelpers for flow direction. Setters: `setPathPreset`/`setPathScale` re-sample +
rebuild the marker; `setPathSwirl` just updates (no rebuild); tube radius goes through `setFieldSize`
(size.x). UI: path fields swap the shape/size rows for preset buttons + curve-size/tube/swirl inputs
(refresh toggles `shapeRow`/`sizeRow` vs `pathRow`/`pathNums`); the strength label reads "flow m/s".
Fields overhaul (2026-07-15): (1) UNIFIED STRENGTH — every kind is now a velocity-target field, so
`strength` = target speed in m/s for ALL of them (a 5 feels the same on attract/repel/wind/vortex/
path). fieldForce builds a target velocity of magnitude ≈ `strength*gain` (attract/repel: unit
toward/away · speed; wind: quat·+X · speed; vortex: tangential+inward · speed) then returns
`(targetV − vel)·mass·RESPONSE·inf` (RESPONSE=5, was VORTEX_RESPONSE). Verified strength 5 → ~5 m/s
peak on all. NOTE this changed wind from a constant force (light things blew faster) to a velocity
target (everything reaches wind speed = terminal velocity, mass-independent) — deliberate, for the
uniform scale; FIELD_INFO defaults are now all strength 8. (2) STUCK-AT-END fix: open paths (helix/
coil/spiral/wave) piled bodies at the end because look-ahead clamped to the last sample (target→self→
speed 0). Now for open paths past the end it EXTRAPOLATES the ahead-point along the final tangent
(`pts[last] + tans[last]*over`), so bodies flow out and leave the tube (verified: helix-end speed 7).
(3) SWIRL smoothed: was constant `speed*swirl` (too strong, 7.7 m/s ⊥). Now `speed*swirl*SWIRL_GAIN
(0.7)*(dist/R)` — solid-body profile, 0 on the centreline ramping out (verified max ⊥ 0.74 @ swirl 1).
(4) MORE PRESETS: added infinity, rose, knot (trefoil), coil, spiral (now 10 total). All authored
≈unit-sized; `scale` sizes them. Headless-tested the whole lot by bundling fields.ts with vite's
`build({write:false, lib})`, rewriting the external `from "three"` to three's resolved file:// URL,
and importing the code as a data: URL (Bash, no browser needed) — handy pattern when the preview is
throttled/down.
Path curves = any equations + a big library + tilted vortex (2026-07-15): (1) VORTEX now swirls about
the field's OWN axis — fieldForce transforms the body into region-local (quat⁻¹), swirls in local XZ,
transforms the target velocity back (verified: upright maxVy 0, tilted-90° maxVy 7.7). (2) PATH curves
are now GENERAL: `FieldPath` stores a `CurveSpec {xt,yt,zt,t0,t1}` + `label` (was a preset key).
`samplePath(spec, scale)` compiles via `parseExpression`, samples 128 pts, **auto-centres on the
centroid, normalizes so bounding radius = `scale`** (so any formula's raw magnitude is irrelevant),
and **auto-detects closure** (start≈end within 8%). Returns null on bad/undefined-var/non-finite —
`Sandbox.setPathSpec(rec,spec,label)` returns that bool so the editor flags a bad formula. (3) UI: the
path editor has quick preset buttons + **"More…"** (a `#curve-library` popup, same look as the shape
library, listing all of `CURVE_CATALOG` grouped — click applies + closes) + **"f(t)"** (three MathLive
fields for x/y/z(t) + t-range + Apply, using the existing `mathField` helper). (4) CATALOG: added ~32
curves to `CURVE_CATALOG` (now 87) — Spirographs (hypotrochoid), Epitrochoids, Roses (r=cos kt, +3D),
Roulettes (cardioid/nephroid/deltoid/astroid/lemniscate/**butterfly**), Space curves (Viviani, baseball
seam), log/rose/toroidal spirals. All verified to sample OK headlessly. NB the shape-creator's "More…"
button ALSO has class `.more`, so `querySelector('button.more')` is ambiguous — scope to the path
editor. NB `CurveSpec` has no `closed` field anymore (auto-detected), and PATH_PRESETS dropped it too.
Field editing = PREVIEW-THEN-APPLY + live equation preview (2026-07-16): fixed two reported bugs.
(1) Custom flow equations gave NO preview (you typed into a void, had to press "Apply equations" to
see anything), and (2) editing an already-placed field mutated the LIVE sim on every click, while the
f(t) box showed STALE defaults (`cos/0/sin`) instead of the field's real curve — so an Apply/preset
click silently overwrote it. Both fixed by making EDITING a live field reuse the placement GHOST
machinery: `Sandbox.beginEdit(rec)` spawns a **draft** = `cloneField(rec.field)` (a ghost, NOT in
`fields`, exerts zero force), hides the original's marker so the draft stands in, and points every
editor control at the draft. The original keeps running its CURRENT force untouched; `commitPlace`
(now the "Apply" button when `editingOriginal` is set) writes the draft back via `copyFieldInto` and
rebuilds the live marker; `cancelPlace`/Esc discards the draft and restores the original (verified:
draft→Loop preview, list stays "Path·custom", Esc snaps back to the helix; Apply→"Path·Circle").
New state: `editingOriginal: FieldRec|null`, getters `isEditing`/`editingField`; `commitPlace` now
branches on it and both commit paths DESELECT afterwards (a placed field is no longer left live-
editable — the old bug's root). `removeActiveField()` deletes whatever the editor targets. Clicking a
field's core / list row → `beginEdit` (was `selectField`). UI: the f(t) editor now PREVIEWS live as
you type (debounced 200ms `applyCustom` on the mathfield `input` + t-range; the "Apply equations"
button is GONE — a status line reads "curve updated" / parse error). Presets/catalog use `pickCurve`
= `setCurveFields` (mirror equations into the mathfields) + `applySpec`. `refresh` repopulates the
mathfields ONLY on active-field IDENTITY change (`shownField` guard) so live typing isn't clobbered by
the refresh it triggers, and `mathField.set` uses `silenceNotifications` so it never re-fires input.
Verified live (path curves + region shapes), 60 fps, no console errors. `selectField(non-null)` now
has no callers — `selectedField` stays null; `activeField` = `placing` during any edit.
Next: joint MOTORS (spin a hinge) + more tools (blow, duplicate), per-object gravity, or buoyancy;
then Phase 7 save/load + time controls (pause/step/rewind). Also still open: superformula /
freehand creators, GLTF/STL import (V-HACD), texture upload, alloy composer.
QUEUED new FIELD kinds (Rafael picked 2026-07-16, build ONE at a time, each its own commit+push):
**Turbulence** (curl-noise region — objects jitter/swirl like leaves in gusty air), **Magnetic**
(F=q·v×B, force ⊥ velocity so movers curve into circles/helices — distinct from the positional
vortex), **Drag zone** (damps velocity → terminal-velocity / slow-mo pockets; bridges the roadmap's
wind→relative-velocity drag). Harmonic trap + one-shot Explosion are the "Other" runners-up.
Gravity well SHIPPED (2026-07-17): the 5th field kind `'gravitywell'` — a true Newtonian 1/r² pull
(Plummer-softened, `WELL_SOFT`). It does NOT use the target-velocity model — that model damps out
sideways velocity, which is exactly why the ATTRACTOR collapses a crowd into a jammed static clump
(measured: 100 objects → ~1% moving). The well applies a CONSERVATIVE central force (no `vel` term)
so bodies keep tangential speed and orbit; plus a Coriolis-like curl about the region axis
(`WELL_SWIRL`, ⊥ to velocity ⇒ does no work) that bends radial infall into a spinning disc so even a
resting pile swirls up instead of falling dead-straight in. KEY realizations from testing: (1) a pure
well is far too weak to beat FLOOR FRICTION (~μg ≈ 6 m/s²) — bodies just sit; had to raise `WELL_GM`
to 60 AND (2) suspend WORLD GRAVITY inside the region (∝ influence, done in `stepPhysics`'s field loop
using `fieldInfluence` + `this.gravityY`, same trick as `stepDocks`) so bodies lift off the floor and
orbit in free-fall instead of grinding on the ground; (3) reach beats strength — a spread 100-object
pile sits out to floor-radius ~12–20, so the well needs a BIG default region (size 16) + elevated
spawn (`beginPlace` puts it at y≥8) or it only grabs the few bodies right under it. `strength` = the
well's MASS (UI label reads "mass", not "speed"). Marker = concentric orbit rings. Verified live:
100 objects → fluid orbiting cloud, 93% moving, 30fps, no console errors (attractor left as-is = the
plain gatherer). Was queued as fitting the target-velocity model — that turned out to be WRONG; it
needed its own conservative path + gravity suspension.
Path curves auto-orient FLAT (2026-07-17): reported that some path presets don't move a floor pile —
the Loop is `(cos t, sin t, 0)`, a VERTICAL circle, so a horizontal layer of objects sits outside its
tube (measured: 11% moving vs a horizontal Circle's 64%). Fix: `samplePath` now calls `layCurveFlat`,
which rotates the sampled points (in the field's LOCAL frame — `field.quat` is left alone so R/gizmo
still tilt the whole thing) so the curve's best-fit plane is horizontal. The plane normal is the
least-variance eigenvector of the point covariance via a compact cyclic-Jacobi 3×3 solver (`planeNormal`)
— NOT Newell's area method, which returns ~0 for a symmetric sine wave (zero net enclosed area) and left
it vertical. `planeNormal` returns false when the smallest spread isn't appreciably flatter than the
largest (a 3D-isotropic knot), so genuinely 3D curves — Helix (an updraft), trefoil — are left standing
instead of yanked to some arbitrary plane. Verified live: Loop, Wave, and a vertical Rose all lay flat
and carry the pile (Loop 4.4 m/s, 64% moving, horizontal racetrack on screen); Helix/trefoil unchanged;
no console errors. Wave stays marginal but that's its open-path drain-off, not orientation.
Draw-a-force shipped (2026-07-17, build 1 of 4 Rafael queued): a **`'draw'` Tool** — left-drag on the
canvas sketches a stroke that becomes a live **path field** ("Draw a force"). onPointerDown/Move/Up in
sandbox.ts branch on `this.stroke` first; `beginStroke` raycasts onto a HORIZONTAL plane through
`controls.target.y` (OrbitControls suspended for the drag), `extendStroke` appends points >0.08 m apart
+ redraws a preview Line, `finishStroke` → `createDrawnPath(worldPts)` which simplifies (drop <0.15 m
samples), centres, normalizes to unit radius (kept in new `FieldPath.drawn`), auto-detects closure, and
pushes a live path field reusing `pathForce` (no equation). `setPathScale` re-scales `path.drawn`
geometrically (guarded — a drawn curve has no spec to sample); `setPathSpec` clears `.drawn` when a real
equation is applied. Tested via SYNTHETIC PointerEvents (project world pts→client coords with
`camera.project`, dispatch pointerdown on #scene + move/up on window): a circle→closed field, an
S-curve→open field (63% of 100 objects follow it), controls re-enabled after, no errors. NB import('three')
fails in the console (bare specifier) — grab THREE via `S.controls.target.constructor` instead.
Lift-inside-flow-tube shipped (2026-07-17, build 2 of 4): a per-path-field `lift` flag (Field.lift) +
`Lift` toggle in the path editor. New export `pathInfluence(field,pos)` in fields.ts (mirrors the tube
`inf` pathForce computes) lets stepPhysics suspend world gravity for bodies inside a lift-tube — the
`wellInf` var is now `liftInf`, max'd over gravity-wells (fieldInfluence) AND lift path tubes
(pathInfluence). Also FIXED a latent bug: cloneField/copyFieldInto were dropping `path.drawn` (so
editing a drawn field lost its stroke) — both now carry `drawn` + the new `lift`. HONEST RESULT from
testing: lift works (captured bodies ride a rising spiral / Viviani UP into the air — topY↑, meanSpeed
~2.5× on Viviani) but only modestly lifts movingFrac on the SPARSE 3D curves (Viviani ~21%→~34%),
because the real ceiling is CAPTURE — a compact floor pile doesn't fill a big sparse 3D tube. At a
compact scale (~6) sitting in the pile, helix/sphere-spiral already hit ~90% with OR without lift. So
lift = a real opt-in "zero-g flow tube", not a capture fix (capture ≈ curve scale vs pile size → that's
what build 4's auto-fit is for). Verified live, 30fps, no console errors.
Turbulence field shipped (2026-07-17, build 3 of 4): the 6th field kind `'turbulence'` — a curl-of-noise
velocity field (all in fields.ts: `turbHash`/`turbNoise` sin-scramble value noise, `curlNoise` takes the
finite-diff curl of three offset noise potentials → a divergence-free unit swirl direction,
`turbulenceForce` steers toward it via the shared target-velocity model). Time drifts via `performance.now()`
(guarded for headless). Bodies eddy in scattered directions (measured heading-scatter 0.84–0.94, ~84%
of a crowd churning at default strength 8) instead of a net push. Tunables TURB_FREQ/TURB_TIMESCALE/
TURB_EPS. Auto-wired into the UI (FIELD_INFO iteration → button; generic region controls). Verified live,
30fps, no console errors.
Build 4 (last of the 4) shipped as TWO commits (2026-07-17):
 4a AUTO-FIT — `Sandbox.fitFieldToObjects(rec)` + "Fit to objects" button in the field editor. Covers the
    92nd-percentile object radius (+margin) so a region stops under-reaching a wide crowd; a well is also
    lifted (orbits clear the floor); a path field is centred + its curve scaled to span the crowd. NB
    rebuildMarker keeps the marker's OWN position, so fit copies field.pos into rec.marker.position before
    resizing. Verified: 200 spread objects, well grew to enclose them, movingFrac 81%→93%.
 4b FORCE BRUSH — a `'brush'` Tool + `BrushMode` ('push'|'pull'|'swirl') with mode chips. onPointerDown
    (brush) → `updateBrushPoint` (object under cursor, else horizontal plane at controls.target.y) + sets
    `brushActive`, suspends OrbitControls; move updates the point; up clears it. `applyBrush()` runs in
    stepPhysics (after stepDocks) — bodies within BRUSH_RADIUS steered toward a target velocity (away/
    toward/tangential) via the shared velocity-target model, eased by distance. Verified via synthetic
    pointer events + direct stepping: push cleared 48→5 near the point, pull held them, swirl gave
    tangential speed 4.5; controls restored on pointerup; no console errors.
ALL FOUR of Rafael's picks are now DONE (draw-a-force, lift, turbulence, brush+auto-fit).
Draw reworked into a GRID CANVAS + base size 10 (2026-07-17):
 • BASE SIZE 10 — every FIELD_INFO.size is now 10 (was 6; well was 16, turbulence 6). Path's tube stays 4
   but its base curve `scale` in beginPlace is now 10 (the path's "size" is the curve, not the tube). NB
   the well going 16→10 slightly cuts its default reach on a big crowd — the Fit-to-objects button covers it.
 • DRAW CANVAS — the old 'draw' TOOL is GONE (removed from the Tool union + Tools section). Draw now starts
   from a **"✎ Draw a flow" button in the Fields panel** → `Sandbox.beginDraw()` spawns a white GridHelper
   (+ faint fill plane) at controls.target, oriented to FACE THE CAMERA (setFromUnitVectors(_UP, toCam)) so
   you sketch straight onto it. A `this.draw` session owns BOTH mouse buttons (OrbitControls suspended):
   onPointerDown/Move/Up route to onDrawDown/Move/Up. LEFT-drag = draw (raycast onto the grid plane, points
   spaced ≥0.12) or erase (screen-space, remove pts within 16px). RIGHT-drag = `rotateGrid` (yaw about world
   up + pitch about camera-right; drawn points stay in WORLD space so you rotate then keep drawing → real 3D
   curve). Grid plane rebuilt on every rotate (`refreshDrawPlane`, normal = quat·+Y). commitDraw → the
   existing `createDrawnPath` (unchanged) makes a live 'path'/'Drawn' field; clearDraw restarts; cancelDraw/
   endDraw disposes the grid + restores controls. Keys: Enter=place, Esc=cancel, E=toggle erase (added at TOP
   of onKeyDown, before the activeField guard). contextmenu is preventDefault'd while drawing so right-drag
   doesn't pop the browser menu. UI: buildFieldsSection has the start button + a draw panel (Draw/Erase chips,
   Place/Clear/Cancel) toggled by `sandbox.onDrawChange`. Verified via synthetic PointerEvents: grid appears,
   58-pt spiral captured, right-drag rotated 0.8 rad, erase 21→14, commit made a path/'Drawn' field, objects
   follow it; all field defaults read 10; no console errors. NB the screenshot tool was timing out this
   session (app rendered fine, fps 20, no errors) so this build has functional verification but no new
   screenshot — re-shoot next session if Rafael wants the visual.
Draw reworked AGAIN into a windowed mini-editor (2026-07-17): Rafael wanted the in-scene grid replaced by
a "moveable and sizeable tab", a visible line while drawing, and X/Y/Z axis buttons + gnomon. New file
`src/drawpad.ts` = `DrawPad` class: a floating, `resize:both` window (#drawpad, CSS matches #shape-preview)
with its OWN WebGLRenderer/scene/camera — fully independent of the sim until Place. Contents: a GridHelper
"paper" that billboards to the draw plane, an always-on AxesHelper gnomon + X/Y/Z sprite labels, and the
live orange sketch Line. Camera orbits via spherical az/pol (right-drag); X/Y/Z buttons snap to look down
each axis (front/side/top); left-drag draws onto the plane through the origin ⊥ to the view (so two views
build a real 3D curve — verified extent ~10×8×8 across all axes). Erase removes points in screen space.
Place → `sandbox.createDrawnPath(worldPts)` centred on controls.target. The Fields "✎ Draw a flow" button
lazily `new DrawPad(sandbox)` + `.open()`. The OLD in-scene draw session in sandbox.ts is GONE (removed
beginDraw/onDraw*/rotateGrid/etc., the `this.draw` state, pointer routing, keyboard block, contextmenu —
kept only createDrawnPath). BUG FOUND + FIXED: the sketch line was invisible because `clear()` did
`lineGeom.setFromPoints([])`, which creates an EMPTY position attribute; this three build's setFromPoints
then only WRITES INTO the existing zero-length buffer and silently drops every point (attr stayed length 0
even with 22 pts). Fix = `updateLine()` sets a FRESH BufferAttribute each time (never setFromPoints).
Verified live: window opens/moves/resizes, orange loop visible while drawing, X/Y/Z snap + gnomon, 2-view
3D curve, Place makes a 'Drawn' path field moving objects, no console errors.
Forces/fields POLISH PASS started (2026-07-17): first deliverable = LIVE FLOW TRACERS (`systems/fieldviz.ts`,
`FieldFlow` class). Research take: the fields were invisible until you dropped objects in — every great
flow/particle sandbox makes the FORCE itself visible. So each field (+ the ghost being placed, minus the
one mid-edit) gets ~260 glowing additive Points advected each frame by the field's REAL `fieldForce`
(unit-mass probe → truthful), with light drag (DAMP 0.985), a speed cap, a snug respawn bound (~1.08×
region so they don't coast off), and a sin-over-life fade so they breathe. Hooked in `syncRender` via
`this._flowList` (no per-frame alloc); `sandbox.setFlowViz/flowViz`; UI toggle `✦ Flow tracers` in the
Fields panel (on by default). Verified live: vortex fills with swirling purple motes, attractor pulls a
bright core, 30fps, no console errors. GOTCHA during testing: setting `field.pos` after beginPlace does
NOT move the marker (marker keeps its spawn pos) — a test artifact, not a bug; real placement uses the
gizmo which moves both. Rafael will now FEEL it and decide on changes.
Polish round 2 (2026-07-17, after Rafael: "everything looks good… turbulence is too powerful"):
 • TURBULENCE TAMED — root cause: with the shared RESPONSE(5) its ever-CHANGING target velocity means a
   body is always far from target → the correction never lets up (wind settles at wind speed; turbulence
   never settles) → blender. Fix: own TURB_RESPONSE=1.6 + default strength 8→6. Verified mean ~1 m/s.
 • EXPLOSION (one-shot 💥, web research: shockwave/explosion is THE most-loved sandbox interaction; juice
   trio = flash+wave+shake) — FieldKind 'explosion' (fieldForce returns 0; FIELD_INFO strength 14 = blast
   m/s). commitPlace branches: kind==='explosion' → `detonate(field)` + dispose ghost, nothing pushed to
   `fields`. detonate: radial impulse ∝ mass·strength·fieldInfluence (so SHAPED charges work), +0.35 up
   bias (debris arcs), random torque kick (tumble), wake. Visual: sphere shell + flat ring expanding
   cubic-out over 500ms, animated in `stepShocks` (this.shocks list, disposed when done). CAMERA SHAKE:
   `this.shake` decaying offset added to camera.position ONLY around renderer.render then subtracted —
   OrbitControls never sees it. UI: Place button reads "💥 Detonate". FieldFlow skips explosion ghosts
   (no steady force → dead cloud). Verified: pile 1.0→9.3 m/s mean, shock dome+ring on screen, fields=0.
 • DRAWPAD SMOOTHING + GLOW — `chaikin(pts,2)` corner-cutting → `this.smoothed` is what's displayed AND
   what Place uses (see-what-you-get); glow = THREE.Points SHARING lineGeom with softDot() (now exported
   from fieldviz) — thick luminous stroke without Line2 (GPU linewidth unreliable on Windows). Verified:
   jagged zigzag renders silky + glowing.
 • QUICK SCENES row in Fields panel — 🌪 Tornado (cylinder vortex 6×12×6 @y12 s12), 🌬 Wind tunnel (box
   wind 14×4×8 @y4 s10), 🕳 Black hole (well s25 sz12 @y10): beginPlace + setFieldShape/Size/StrengthOf +
   pos on BOTH field.pos and marker.position (the marker gotcha) + commitPlace. Verified tornado: cylinder
   column of tracers, 51% of 70 objects spinning. All: 30fps, no console errors.
Polish round 3 (2026-07-17, Rafael: "add tornado updraft; some forces appear the moment you click without
letting you edit first"):
 • QUICK SCENES now open a pre-configured GHOST (removed the commitPlace() from their onclick) — same
   commit-or-cancel flow as every field; that was the "appears on click" report. Regular kind buttons
   always ghosted (verified). Ghost TRACER clouds now render DIMMED (FieldFlow.update takes ghostId →
   material.opacity 0.35 vs 1) so a preview never reads as live.
 • TORNADO UPDRAFT — took THREE attempts; the failures matter:
   (1) lift fading to zero at the radial edge → nothing rose (swirl slings bodies outward to where lift=0).
   (2) widened lift profile still dead — REAL root cause was placement: the influence smoothstep fades over
       a region's outer 45% (SOFT_EDGE 0.55), and the preset cylinder's bottom cap KISSED the floor → floor
       bodies sat at ~96% axial extent → ~2% force. Regions must be SUNK INTO the floor. All three quick
       scenes lowered: tornado y=6 (was 12), wind tunnel y=2 (was 4), black hole y=8 r=14.
   (3) ALSO required a RANKINE profile: constant-speed swirl near the axis demands v²/r ≫ the inward pull →
       bodies slung out of the region before lift acts. Now tangential target *= min(1, rf/0.6) (solid-body
       core), inward draw 0.35, lift = speed·VORTEX_LIFT(0.6)·(1−0.7·rf). Result: bodies collect at the
       axis and ride up — verified maxHeight 19.3 (was 0.8), 7 airborne at once, fountain out the top.
   LESSON for every floor-adjacent field: sink the region, don't kiss the floor.
PHYSICS ACCURACY PASS (2026-07-18, from Rafael's bug reports — all measured & fixed):
 • "ORBITING AROUND NOTHING" root causes, BOTH real: (1) the gravity-suspension in stepPhysics didn't
   scale with the GLOBAL strength slider — wells at global 0 exerted zero pull but still cancelled
   gravity, so 816 objects coasted forever in zero-g at 57 m/s (vy≈0, y≈52 — measured live). Fix:
   suspend ∝ liftInf · clamp(fieldStrength, 0, 1). (2) the well's Coriolis "orbit seed" k·(axis×v) is
   CYCLOTRON dynamics — it circles bodies around wherever they are, not the centre. REMOVED. Orbits now
   come from ORBITAL INSERTION (insertOrbits, on well place/apply): each captured body's tangential
   velocity component is set to √(a_eff·r) about the well axis (wellOrbitalVelocity in fields.ts) —
   real satellite insertion. a_eff MUST include fieldInfluence (soft edge) or edge bodies are 1.5× too
   fast and fling out (measured). Well default y=8→5: at y=8 the floor crowd sat in the soft edge →
   partial gravity → floor friction ground orbits dead; at y=5 floor is full-influence → frictionless.
   Verified: meanTang −7.7 → −5.3 over 10 s (sustained; residual decay = honest collision loss).
 • VORTEX ≠ TORNADO — split into two kinds (Rafael: vortices must not lift). VORTEX = flat Rankine
   whirlpool (rankine(): solid-body core ∝ r, free vortex ∝ 1/r outside — constant-speed-at-all-radii
   demanded impossible centripetal force near the axis) + gentle inward draw, ZERO vertical. Verified
   maxY 0.6. TORNADO (new kind, cylinder default, SUNK 3 below floor — soft edge would zero the ground
   inflow if the bottom sat at y=0): Rankine swirl + ground-hugging inflow ∝ (1−hf)² + funnel-WALL
   updraft. Two hard-won findings: (a) a core-centred updraft lifts NOTHING — centrifugal balance
   forbids the core (needs ~45 m/s², inflow gives ~19); debris settles in an annulus at rf≈0.5, so the
   lift lives there (TORNADO_WALL 0.5 ± 0.35) — same as real tornadoes (calm core, debris up the wall).
   (b) the recirculation loop must close INSIDE the region: radius 6 shed everything (landed outside,
   never recaptured); radius 10 (wall still at ~5, funnel cone visual at 0.75·r) + inflow 0.7 →
   STEADY STATE: airborne 30→27→29 over 17 s, 46/50 retained. Marker = wireframe cone, apex down.
 • REVERSE FLOW — `Field.dir: 1|-1` + ⇄ Reverse-flow button (editor, only for vortex/tornado/
   gravitywell/path). dir mirrors HANDEDNESS only: vortex/tornado tangential ×dir, well insertion
   handedness, path look-ahead ±dir (open-path reverse extrapolates past the START). PROTECTED
   separately: NEGATIVE STRENGTH still reverses swirl AND flips draw→outward fling (Rafael likes it;
   verified: strength −8 → tang −0.76, radial +1.8 outward; dir −1 → tang −3.76, radial inward 0.24).
   dir is copied in cloneField/copyFieldInto (draft/apply safe).
VORTEX PILLAR + TORNADO FORM PASS (2026-07-18, Rafael's reports — measured & fixed):
 • PILLAR BUG: well+vortex stacked (his scene: r=100 both, vortex strength 200, global ×3) crushed 986
   objects into a standing column on the axis (median radius 1.6, heights to 87). Cause: the vortex's
   inward draw was a CONSTANT 0.3·speed at every radius (= 180 m/s inward). Fix: draw ∝ the local
   Rankine profile (`draw = 0.3·speed·prof`) — real vortices have calm cores/pressure-scaled inflow.
   Same scene now → razor-thin orbital RING at radius 21.3 (all quartiles!), 49 m/s tangential, flat.
   This is also why explosions "couldn't" eject things before — the 180 m/s recapture is gone.
 • TORNADO EYE + FORM: objects trapped dead-centre in the eye (inward-only inflow pins them on the
   axis) + wall debris launching off the top. Fix: radial steering is now SIGNED toward the FUNNEL
   CONE surface at each height (coneR: rf 0.3 at ground → 0.78 at top; eye objects pushed OUT, stray
   debris pulled IN; coef strong at ground, 35% aloft) and lift lives on that cone annulus fading
   LINEARLY with height → debris stalls ~¾ up and recirculates. Marker = matching tapered wireframe
   tube (CylinderGeometry 0.78R top / 0.3R bottom). Verified: 46/50 airborne dead-stable over 19 s,
   eyeCount 0 throughout, 47/50 retained, ring rides the funnel wall on screen.
 • Removed the 🌪 quick-scene (Tornado is a kind button now — two buttons read as duplicates). Rafael
   plans FUTURE CUSTOM KINDS for wind tunnel + black hole (quick scenes stay as tunings until then).
TORNADO SPREAD + SOLE GRAVITY (2026-07-18, round 2 of Rafael's feedback):
 • "Objects holding in ONE LINE" on the funnel — root cause: every body at a given height gets the
   IDENTICAL steering target, so collisions bead debris into a single rotating chain (the gust noise
   is positional — a tight clump shares one gust and stays a clump). Fix = SUCTION SUB-VORTICES (real
   tornadoes carry 2–5 of them): a traveling wave around the azimuth, sin(3θ − dir·2.4·t + 3hf),
   added to vRad (±0.22·speed) — each angular position gets a different push, shearing chains apart.
   Verified: azimuth occupancy 2/8 bins → 8/8, sustained.
 • POINTIER cone: marker funnel is now 0.06R tip → 0.9R top (visual). The PHYSICS cone stays 0.3→0.85
   (W 0.35): setting the physics tip to 0.06 dropped airborne to 2 — at ground level centrifugal
   balance vs the Rankine swirl parks debris at rf≈0.35-0.5, so a lift annulus at a pointy radius acts
   where debris CANNOT exist (same bug class as the original core updraft). Real tornadoes match: the
   visible funnel is condensation; the debris cloud swirls WIDER around it. Snap gain is now height-
   dependent (3.3 ground → 1.5 top: tip holds debris, top is a loose shell for the sub-vortices).
 • TORNADO_LIFT 0.7 → 1.15 + gust base 0.65 → 0.8: net climb = target·(wall·gust·(1−hf)) − g/RESPONSE,
   and at 0.7 the product fell below gravity by mid-column → everything hovered under y=6. Verified
   after: low 19 + mid 17 bodies, rLow 6.5 → rMid 7.6 (radius grows with height = cone form), maxY
   8.7 (no launching), 8/8 azimuth, 30 fps.
 • SOLE GRAVITY (Rafael's ask): `Field.sole` + "☉ Sole gravity" editor button (gravitywell only) —
   world gravity FULLY suspended (binary, not soft-edge-eased) anywhere inside the region, so the
   well's centre is the only "down"; other wells/attractors still add their pull. Copied in cloneField/
   copyFieldInto. Verified in the y=8 friction-prone config: sole OFF → orbits die (1 moving), ON →
   orbits alive (15 moving, meanTang −2.17). Still scaled by the global-strength clamp path (gain 0 =
   fully off — the suspension reads liftInf which is gated in stepPhysics).
QUEUED (Rafael, 2026-07-18): MUTUAL ATTRACTION between objects (N-body) so his current sim — 995
objects orbiting one giant well (median r 4.3, disc at the well plane, tail to r 28 — observed live)
— can evolve into STAR SYSTEMS with planets: moons around planets around the star. Plan sketch:
opt-in "self gravity" toggle; direct O(n²) is fine to ~300 bodies at 60 Hz (pairwise force loop in
stepPhysics before world.step), Barnes-Hut octree if more; G scaled so two 1 kg spheres 2 m apart
drift together in ~seconds (visible); wake management matters (mutual pull keeps everything awake —
maybe only apply between awake bodies + bodies above a mass threshold, e.g. "planets" only).
TORNADO LINE ROUND 3 + BIG MAP + APPLY-SPIN FIX (2026-07-18):
 • The line CAME BACK (Rafael, with 100+ objects, enlarged tornado, minutes of runtime). Root cause of
   the recurrence: bodies PHASE-LOCK onto a single traveling wave — its equilibrium azimuths co-rotate
   with it and debris surfs them, re-forming rotating arms. Fix: TWO incommensurate counter-traveling
   waves (0.6·sin(3θ−2.4t·dir+3hf) + 0.4·sin(2θ+1.7t·dir+40)) — no rotating frame makes both static,
   so no equilibria to lock onto. ALSO the waves now die toward the rim (×clamp(2(1−rf),0,1)): a full-
   strength outward half-wave at the rim was ACTIVELY ejecting borderline bodies ("objects fall off
   way too much"). VERIFIED THE WAY RAFAEL ASKED: 120 objects, enlarged tornado (16,13,16 @y10), TWO
   FULL SIM-MINUTES chunked: airborne 107→106→107→107 (dead constant), retained 112→111→111→111,
   azimuth 12/12 bins the whole run, circular concentration r̄ 0.09–0.19 (a line reads ~0.7+), maxY≈16
   (no launching), 30 fps. Long runs + big crowds are REQUIRED for tornado testing — short small tests
   passed twice while the line still formed at scale.
 • MAP ×2: floor 1000×1000 (collider half-extents 500, plane 1040, grid 1000 w/ 2 m cells), fog
   pushed 80,400 → 250,1200, camera far 500 → 1600, grab/place clamps 245 → 495.
 • APPLY-FLIPPED-SPIN BUG (Rafael: vortex-spun blocks inside a well reversed direction after delete-
   vortex → open well editor → Apply): commitPlace re-runs insertOrbits, which snapped every body's
   tangential velocity to the WELL's dir. insertOrbits is now HANDEDNESS-PRESERVING: |vTan|>0.4 keeps
   its own sign (speed topped up to circular), only near-rest bodies get the well's dir. Verified:
   flipped crowd +3.72 stays + after Apply (was: flipped back to −).
MUTUAL GRAVITY SHIPPED (2026-07-19) — the queued N-body build, sized for 1000+ objects: new
`systems/nbody.ts` = a **Barnes-Hut octree** (θ=0.7, Plummer soft 0.6 — same softening trick as the
well; softening also makes self-force exactly ZERO, so no self-exclusion bookkeeping is needed
anywhere). Deliberately dependency-free + allocation-free after warmup: struct-of-arrays typed arrays
for bodies AND tree nodes, explicit traversal stack, nodes cleared on creation not per-build — so it
benches headless in node (esbuild-transpile the one file, no three/rapier) and never GC-stutters.
Direct O(n²) would be ~500k pair evals/step at n=1000 — measured BH: 1.5 ms/step @1000, 4 ms @2000,
13.5 ms @5000; BH vs direct-sum mean rel error 1.8% (the scary-looking "worst 64%" case is a body at
the cloud's force-cancellation point — tiny absolute error, standard BH behavior). Integration
(sandbox.ts `stepSelfGravity`, runs before the fields loop): rebuild tree from all entities each step,
impulse = m·a·dt; FROZEN bodies stay in the tree as attractors (a pinned "sun" pulls) but take no
impulse; mass-0 first-tick bodies skipped; |a|²<1e-8 skipped so femto-pulls don't wake distant
sleepers; setSelfGravity(true) wakes the scene so a resting pile starts drifting immediately. UI =
World panel: "☄ Mutual gravity" toggle (primary when on) + "Pull strength G" slider 0-10 (default 2 —
two 1 kg spheres 2 m apart meet in ~2 s). VERIFIED LIVE at Rafael's requested scale: 1000 objects in
Zero-G collapsed spread 31→6.1 and HELD (self-bound rubble-pile planet, real gravitational
equilibrium; screenshot taken); full stepPhysics measured 3.96 ms/step spread → 7.34 ms/step fully
clumped (worst case, still <½ the 16.7 ms budget); UI-button-driven run confirmed (click → collapse);
console clean. NB the pair drift-test reads "slow" if you forget the bodies BOUNCE at contact —
d settles ~1.2 for two r=0.5 spheres, that's restitution, not weak gravity. NEXT SLICES for star
systems: accretion MERGING (contact clumps → one bigger body, keeps n in budget as piles grow),
per-clump c.o.m. naming/inspector, maybe tidal breakup. Solar-system recipe that works TODAY:
Zero-G + a big gravity well (star) + mutual gravity on + spawn a few hundred spread objects.
ACCRETION SHIPPED (2026-07-19, same session): "🪐 Accretion" toggle next to Mutual gravity (clicking
it auto-enables mutual gravity; the step is gated on BOTH). stepAccretion in sandbox.ts, every 10
steps (6 Hz): walks Rapier's live contact graph (world.contactPairsWith over a collider-handle→entity
map; contactPairsWith includes broad-phase near-misses, so each candidate is confirmed with the
existing pairInContact manifold check), fuses ≤8 pairs/check (a clump melts into a planet over
seconds, not one frame). mergePair: sphere of combined volume at the pair's c.o.m., mass conserved
EXACTLY by collider.setDensity(M/V) after spawn (works across mixed materials), momentum via
setLinvel, angular momentum = orbital term + 0.4·m·r² spin approx, capped at 8 rad/s; heavier
parent's material+color; label "accreted ×N" (Entity.accreted); lastVel seeded so the forces window
shows no phantom spike. Skips frozen/grabbed/jointed/docking bodies and first-tick mass-0 spawns.
KEY TUNING FOUND IN TESTING: a flat 2 m/s fuse threshold left a moon ROLLING on the planet's surface
at 2.2 m/s forever (no rolling resistance in Rapier → rolling contact never slows) — threshold is now
max(2, 0.7·v_esc) with v_esc = √(2·G_slider·(mA+mB)/(rA+rB)), i.e. real escape-velocity capture:
grown planets swallow what touches them, pebbles keep the 2 m/s floor. NB spawn(pos,…) places
EXACTLY at pos (the overlap-rejection lives only in findSpawnSpot), so merged planets don't jump.
VERIFIED LIVE: 400 spread objects, Zero-G, one UI click → n: 400→1, "accreted ×400" r=5.03, total
mass 534.26 unchanged at every checkpoint; recipe test with a fitted gravity-well star (beginPlace →
fitFieldToObjects → commitPlace, orbital insertion) → stable 5-body system (r=4.8 planet, r=1.7
planet, 3 moonlets) orbiting for 60+ sim-s, mass 498.3 constant, console clean, screenshots taken.
LIKELY NEXT: motion STREAKS for tracers; affected-object glow/tint; per-object trails; drawpad per-axis
ortho cam. NB screenshotting a 500ms shockwave: pin `S.shocks[0].born = now-190` on an interval.
Research dossier: docs/FORCES_RESEARCH.md.
STANDING RULE (Rafael, 2026-07-16): git commit AND push after EVERY build — don't wait to be asked.

Stability hardening (2026-07-13): dynamic bodies now spawn with CCD enabled and reject deeply-
overlapping drop points — previously, an overlapping spawn could make Rapier's solver inject a huge
separating velocity, and without CCD that let a body tunnel straight through the floor collider and
free-fall forever (confirmed one sphere at y ≈ -1.3M, still accelerating). There's also now a per-step
speed cap and a below-the-world respawn safety net, plus a small screen-space pick tolerance so a
small/fast-moving ball doesn't require pixel-perfect clicking to grab.

Key files: `src/main.ts` (boot), `src/sandbox.ts` (the whole Phase 1 core), `src/ui.ts` (panel/HUD/inspector).

## ⭐ STANDING RULE — verify in the Claude browser after EVERY change

After making any change and before telling Rafael it's done, you MUST:
1. Make sure the dev server is running (`npm run dev` in the background; it serves http://localhost:5173).
2. Open/refresh the simulation in the **Claude browser** — `preview_start` with `url: http://localhost:5173/`
   (or `navigate` to it if already open), then **take a screenshot** and **check console for errors**
   (`read_console_messages` with `onlyErrors: true`).
3. Confirm the change actually works on screen (and FPS is still healthy) before reporting.
Never report a change as delivered without this browser check. Rafael wants to *see* it every time.

## Architecture & conventions (don't fight these)

- **Physics is the single source of truth**; the renderer only *reads* body transforms. Never write a
  body transform from the render side.
- **Fixed timestep** (1/60) with an accumulator + render **interpolation** (lerp/slerp between the two
  latest physics states). A catch-up clamp (max 3 steps/frame) keeps a slow frame from freezing.
- **Rapier and Three are both right-handed, Y-up** → transforms copy straight across, no conversion.
- **Rendering scales via `InstancedMesh`** (one draw call per shape type). This is why 100s of objects
  are cheap — keep new shapes instanced.
- **Add features as "systems," never by rewiring the core loop.** A system runs over the entity registry
  each step/frame. See `src/systems/README.md` for the planned set and each one's home.
- Visual identity = the blueprint dark palette already in `src/style.css` and the stress-ramp object
  colors. Propose any new visual/aesthetic choice to Rafael before finalizing; then reuse it.

## The full plan (everything discussed is captured — nothing is lost)

- `docs/ROADMAP.md` — all phases (P1–P7) + the three worlds, in order.
- `docs/FEATURES.md` — a checklist of EVERY feature discussed. **Update it as things get built.**
- `docs/ARCHITECTURE.md` — the loop, data model, systems layout, scale-transition orchestration.
- `src/systems/README.md` + `src/worlds/README.md` — a named code home for every future system, with
  typed stubs (`shapes.ts`, `materials.ts`, `deformation.ts`, `ai.ts`).
- External design docs (rich): Roadmap, Build handbook, Extensions (URLs are in `README.md`).

Scope spans: rigid sandbox P2 shapes (function/**parametric**/implicit/superformula solids, freehand,
CSG, model import — mass via a Module-M voxel path), P3 materials (textures + **element/compound/alloy**
composer), P4 forces & fields + joints, P5 heat/charge/magnetism + **chemistry/reactions**, P6
**deformation** (XPBD soft bodies — the physics-lab failure; rigid engines can't deform, needs a
separate soft-body sim) + fracture + fluids, P7 save/share/record/rewind. Separate worlds: **Cosmos**
(N-body, stellar life cycles, black holes), **Quantum** (wavefunctions, qubits), **Subatomic** (Standard
Model, quarks). Signature UX: **scale-transition zoom**. Plus: portable AI scenario builder, 2D mode
(Rapier2D), terrain editing, live sensors & graphs. North stars: physics-Minecraft, robot digital-twin.

## What's next

Recommended next build: continue **Phase 2 — shape creation** with **implicit/SDF surfaces** (gyroids,
metaballs) via marching cubes + the Module-M voxel mass path — or start **Phase 3 materials**
(`systems/materials.ts` already has the preset table; wire density/friction/restitution presets into
all four creators). Or pick any item from `docs/FEATURES.md`.

## Working loop for each task

Design briefly → implement one system → `npx tsc --noEmit` (type-check) → ensure `npm run dev` is up →
**open in the Claude browser + screenshot + check console** (the standing rule) → tick it off in
`docs/FEATURES.md` → report with the screenshot. Ship one coherent thing at a time; stop and let Rafael
try it. Rafael writes no code — propose decisions as specific questions.
