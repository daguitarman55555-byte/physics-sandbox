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
TEXTURES MERGE v2 — IMPACT-SITED PLANET SKINS (2026-07-19, replaced the v1 random re-bake the same
day at Rafael's ask for max detail + realistic accretion + patches where things land). `systems/
planettex.ts` = `PlanetSkin`: a planet's PERSISTENT painted surface — four equirect canvases
(albedo+normal up to 2048×1024, rough+metal at half; TARGET_PXM 96 px/m, TILE_M 2 matching pools)
behind one MeshStandardMaterial (roughness/metalness scalars = 1, the painted maps carry values;
steel's roughnessScale 0.62 / metalness 0.85 baked via ctx.filter brightness). `Entity.comp` =
volume-weighted {mat, vol, color}; compOf/mergeComp as v1. REALISTIC MERGE SHAPE (mergePair): the
LARGER body (by volume) SURVIVES — keeps entity identity, orientation, spin, and skin; grows in
place; the smaller is painted at the impact point: centre-to-centre dir → big's LOCAL frame (quat
inverse) → SphereGeometry UV. A pool sphere converts to a skinned 'custom' (unit SphereGeometry(1,
64,48) × mesh.scale=R) on its first foreign bite once R ≥ SKIN_MIN_R (0.8) — smaller mixed pebbles
stay pooled (splats invisible at that size; comp still tracked, minors scatter-painted at
conversion). Splat = TRUE SPHERICAL CAP (cosΔφ = (cos α − cosθ·cosθ0)/(sinθ·sinθ0) per row; polar
rows go full-circle), sized max(1.6·r_impactor, 2R√(volFrac)), faint crater rim (mid-lat only),
impactor minors as jittered sub-blotches. FOUR hard-won traps, in order of pain:
 (1) RAPIER: `Collider.setRadius()` does NOT recompute the body's mass properties in this build —
     planets grew while mass froze (measured: r 3.9 @ 12.7 kg), the feather-weight giants then
     flung everything into the void (mass 1265→27!). GROW BY REPLACING THE COLLIDER:
     removeCollider + createCollider(ball(R).setDensity(M/V)) — that path is exact.
 (2) CANVAS: pattern-fill of MANY 1-px rows re-tiles the pattern PER CALL — a big cap was ~12k
     fillRects ≈ 1.2 s inside ONE mergePair (worst step 14 s!). Fill the cap as ONE Path2D polygon
     (edge sampled per row, band rect for full-circle rows, ±W translated copies for the seam —
     safe because fills snap to an integer tile count per width, so pattern phase survives ±W).
     Worst step 14,270 ms → ~90–290 ms; live fps 28–30 through a 400-object merge storm.
 (3) UV CONVENTION: SphereGeometry stores uv.y = 1−v and CanvasTexture flipY re-inverts — they
     CANCEL: north pole = canvas row 0. (First guess painted the pole drop on the south pole; the
     equator can't catch this bug — test with a pole drop.) u = atan2(z,−x)/2π matches; verified
     +X and +Y impacts land on-screen where thrown.
 (4) EDGE JITTER: wobble the LONGITUDE span only, long wavelength (~50 rows) & small (8%/4%) —
     jittering the cap RADIUS per row slices it into streaks/rings, high frequency reads as comb.
Anti-lag plumbing: splat/fill only mark `dirty`; `flushIfDue` (called from syncRender per custom
entity) uploads all four textures at most every FLUSH_MS 300 — a planet eating 8 bodies/check
uploads once. Skin BIRTHS (4 full canvas fills) budgeted ACCRETE_SKIN_BUDGET 1 per check — an
over-budget pair merges next check. createPattern cached per (layer×mat×plainColor), cleared on
ensureCapacity (which upscales canvases when R outgrows TARGET_PXM; pattern transforms are
width-relative). Longitude seam fix: fills snap to whole tiles across W. deleteEntity/clear
dispose ALL FOUR maps when userData.ownedTex. Console tip: `import('/src/systems/materials.ts')`
in the dev console grabs PRESETS/PLAIN for spawning specific materials; NB dynamic import may get
a DIFFERENT module instance than the app's (HMR query strings) — prototype patches won't stick.
VERIFIED LIVE: pellet tests (steel→+X face, wood→north pole) land exactly on-screen with clean
organic caps; 400 mixed collapse → one "accreted ×400" (stone 36/wood 27/steel 27/plain 11%),
mass exact at every checkpoint, fps 28–30 (throttled-tab ceiling) through the whole storm, console
clean. Honest notes: normal-map patches keep source tangent orientation (slightly wrong near poles
— invisible in practice); equirect pole pinch on the base fill remains (triplanar would fix, later);
paint history upscales blurry on ensureCapacity (new splats stay crisp).
ACCRETION UX PACK + TIME CONTROLS (2026-07-19, same session): (1) PLANET DRAG fixed — bodyBottomY
treats skinned planets as spheres (the OBB fallback read a rotated planet as √3·R deep and the drag
clamp shoved it skyward — measured yDrift 0 after), and grabs on skinned planets anchor at the
CENTRE (a heavy uniform ball grabbed by its rim pendulums wildly; centre-hold tracks the cursor).
(2) INSPECTOR/FORCES show the real skin: PlanetSkin.thumbURL() = cached 64×32 data-URL (inspector
rebuilds at 10 Hz — NEVER toDataURL the full canvas there), invalidated on paint; materialFor(e)
returns e.skin.material.clone() (shares canvas textures; material.dispose() leaves textures alone;
clone's userData cleared so ownedTex doesn't travel); forces-view meshes get mesh.scale=e.size for
skinned (unit geometry) + radius×e.size for framing. (3) JOINT TRANSFER on absorb: canAccrete no
longer excludes jointed bodies; a directly-jointed pair NEVER fuses with itself (jointed() check in
the candidate scan — welds/tethers are constructions); mergePair captures small's joints (+ big's
too on the fresh path) BEFORE deleteEntity strips them, then lockJoint(e, other, kind) re-links at
the current pose (dedupe via jointed(); entities.includes guards partners merged away the same
check). Verified: planet ate a spring-tethered box mid-flight and inherited the spring to its
partner. (4) ACCRETION ≠ MUTUAL GRAVITY: the stepPhysics gate is accretionOn only; the UI button no
longer auto-enables gravity. CRITICAL COMPANION FIX — IMPACT-TIME CAPTURE: without gravity a thrown
body bounces off a planet in 1–3 steps and the 6 Hz scan NEVER sees the contact (measured: tethered
box sailed through 2400 steps unfused). New RAPIER.EventQueue passed to world.step; every entity
collider gets ActiveEvents.COLLISION_EVENTS (enableContactEvents(body) called in spawn,
finishCustomEntity, and mergePair's two collider builds); drainContactMerges (right after
world.step, accretion on; events.clear() otherwise or the queue grows) resolves started-pairs via a
lazily-built collider→entity map and runs the same capture test on POST-BOUNCE velocity (physically
right: a slow rebound can't escape) then mergePair. setAccretion(true) primes skinBudget so an
impact merge before the first 6 Hz check isn't skipped. NB the event queue is also the feed impact
BREAKAGE will need (per-impact pairs at the exact step). (5) ✨ HD SKINS toggle (World row):
planettex setSkinDetail/skinDetailHigh — hi {96 px/m, 1024–2048} / lo {32 px/m, 256–512}; applies
to skins born/resized after the switch. (6) PAUSE + TIME SCALE (World): `paused` skips accumulator
feed; `timeScale` (0.1–3) multiplies WALL dt INTO the accumulator — physics always steps FIXED so
impulses/forces are identical at any speed (this was Rafael's explicit constraint); MAX_CATCHUP
3→4 (×3 needs 3 steps/frame at 60 fps — headroom); leftover acc clamped < FIXED after the while
loop or alpha>1 extrapolates the render (unbounded backlog at high scale otherwise). Verified:
frozen exactly while paused, moves on resume; drag yDrift 0; joint inherited; low-detail skin maps
512 wide. NB a mid-edit HMR race left two stale "enableContactEvents is not a function" errors in
the console history — the fresh load is clean (the tool's console log persists across navigations).
EFFICIENCY PASS (2026-07-19) — the 1000-object accretion storm went from LOCKING THE TAB (steps
measured at 480–2300 ms, one exec ran 400+ s) to mean 2.0 ms/step, worst ~110 ms, live fps pinned
at the throttled tab's 30 with one brief 17 dip; 1000→1 planet with mass EXACT (3481→3481). Three
root causes, found by phase instrumentation (world.step was 99% of a 15 s window — merge code was
~1%):
 (1) CCD. THE big one: always-on CCD in a gravity-compressed clump measured 873 ms/step vs 0.2 ms
     with CCD off — ~4000×. Even a 20 m/s adaptive threshold re-triggered it (deep-overlap ejections
     are exactly the fast bodies). CCD is now FULLY OFF (CCD_SPEED = Infinity; the adaptive toggle in
     stepPhysics stays wired for the future): safe because MAX_SPEED 60 → ≤1 m/step vs the 1 m-thick
     floor slab (can't step across), and VOID_Y catches strays. If a THIN static collider ever ships,
     lower CCD_SPEED again.
 (2) MASS-DOUBLING MERGE BUG: two merges hitting the same body in one STEP (possible since impact-
     time capture) — the second reads body.mass() before Rapier finalized the first collider
     replacement, and densities stack: a planet's mass DOUBLED per absorb, compounding to ×1000
     (measured 3.6M kg on a 175 m³ planet; the feather... no, the LEAD balloon then wrecked the sim).
     Fix: `Entity.mergedTick` + `Sandbox.tick` — ONE merge per body per physics step across BOTH
     paths (scan + drain), and density is set ONCE (common tail only; the in-place collider desc no
     longer sets it). Mass conservation re-verified exact through a full 1000-body storm.
 (3) Persistent `colliderToEntity` map maintained by registerColliders/unregisterColliders (spawn,
     finishCustomEntity, mergePair's replacements, deleteEntity, clear) — the event drain and 6 Hz
     scan no longer rebuild a 1000-entry map per call; drain aliveness checks use body.isValid()
     (O(1)) not entities.includes. Plus IMPACT_MERGES_PER_STEP=4 caps event-driven merges (uncapped,
     dozens fired per step and the growing planet enveloped its neighbours in deep overlap every
     step).
TESTING GOTCHAS learned the hard way: (a) the browser exec tool KILLS scripts at its 30 s timeout —
if that lands mid-world.step, Rapier's WASM is left mutably borrowed and EVERY later call throws
"recursive use of an object … unsafe aliasing"; only a page reload clears it. Use TIME-BUDGETED
loops (`while (performance.now()-t0 < 15000)`) that check between steps, and persist counters on
`window` so a timeout can't lose them. (b) Vite may serve dynamic `import('/src/...')` a DIFFERENT
module instance than the app's (HMR query strings) — prototype patches on classes from a console
import won't stick; patch via Object.getPrototypeOf(window.sandbox) instead. (c) PowerShell 5.1
`Get-Content`/`Set-Content` round-trips MANGLE UTF-8 (reads as ANSI → 137 mojibake sites in
sandbox.ts) — never bulk-edit sources with PS; the recovery script (reverse cp1252 round-trip) is
scratchpad/fix-mojibake.mjs if it ever happens again.
IMPACT BREAKAGE SHIPPED (2026-07-20): "💥 Breakage" World toggle, independent of accretion, riding
the same collision-event drain (drainContactMerges → renamed drainContactEvents, gated on EITHER
toggle; events.clear() when both off). THREE REGIMES per contact-started pair: capture (accretion,
post-bounce speed ≤ max(2, 0.7·vEsc)) → shatter (breakage) → bounce+crater. DAMAGE uses PRE-impact
closing speed from lastVel (the post-step drain sees post-bounce velocities — judging damage by
those would make bouncy rubber break easier than brittle ice; lastVel holds each body's velocity
from BEFORE this step, exactly the pre-impact value, no restitution guesswork). E = ½μv², per-body
Q = E/m (the smaller body of a pair takes the worse specific beating — a pebble explodes against a
planet that barely notices, for free); threshold = BREAK_Q(18)·strengthOf(e) + (selfGravityOn ?
0.15·vEsc² : 0) — `Material.strength` is NEW (ice 0.4, wood 0.7, stone 1.2, rubber 2.5, steel 3;
volume-weighted over comp). shatter(): volume split w0≈0.38-0.58 remnant + shards (crumbs < 0.12
fold back), fragments placed inside the parent radius, collider density = parent M/V (mass exact
WITHOUT trusting same-tick mass reads), comp scaled per fragment (re-accretion regrows the same
mixed planet — verified round trip: shattered planet's debris re-fused to "accreted ×36" with the
same stone/steel/wood split), velocities = parent v₀ + ω×r + energy-scaled radial kick with the
remnant absorbing counter-momentum (total momentum exact), fragments get mergedTick = tick (no
same-step re-merge). POTATO DEBRIS: fragments R ≥ 0.5 get displaced-sphere meshes (potatoGeometry:
3 random low-frequency radial sine waves, displacement a pure function of DIRECTION so UV-seam
duplicate vertices stay welded; computeVertexNormals) via finishCustomEntity + ball collider —
looks like an asteroid, rolls like a ball; TRUE irregular colliders (convex hulls + the exact
polyhedron mass path from shapes.ts) and LUMPY ACCRETED PLANETS are the agreed NEXT slice (Rafael
2026-07-20; planet lumpiness must reconcile with the equirect skin + in-place growth — displaced
unit sphere keeps UVs, so it's mesh-side feasible; collider stays ball until the hull path lands).
CRATERS: PlanetSkin.crater() = dark translucent cap + rim on the albedo layer at the impact dir
(pole-guarded); painted whenever the BIGGER body survives a > 5 m/s hit — including when the
impactor shatters against it (first cut skipped that case and looked broken); impact geometry is
captured BEFORE any shatter deletes a body (small.body.translation() after deletion = invalid
handle). Caps: BREAKS_PER_STEP 2, BREAK_MIN_R 0.3, +8-entity headroom guard vs MAX_INSTANCES.
VERIFIED LIVE: stone pair @14 m/s closing → 8 debris, mass 2.72→2.72; @6 m/s → bounce; wood pebble
vs skinned planet → pebble shatters, planet survives with an on-screen crater ring at the exact
impact point; steel slug @26 m/s → accreted planet blown into 10 potatoes (screenshot: proper
asteroid look); full lifecycle mass-exact; 500-object all-three-systems storm mean 1.89 ms/step
worst 85 ms, console clean. GOTCHA that burned 20 min: a build-the-scene loop `while (n>1 && s<cap)`
can exit on the CAP with stragglers still flying — the "planet wouldn't shatter" mystery was the
slug hitting leftover pellets en route (energy spent before arrival), not a code bug; assert n===1
before staging the next phase of a test. Honest notes: fast shards can sail below VOID_Y and get
culled (existing off-world cleanup — ~0.3% mass in one violent test; deletion, not a bug); floor
impacts don't break anything yet (the floor isn't an entity pair — future: treat static-collider
hits as infinite-mass impacts).
IRREGULAR SHAPES + 1:1 DRAG (2026-07-20): (1) DRAG anchor speed 40 → 250 m/s (the grab-anchor
clamp in stepPhysics) — the held object now tracks the cursor exactly at any human speed (measured:
20 m crossed in 5 steps vs ~50 before); still bounded so a violent flick can't teleport-fling, and
MAX_SPEED caps the released throw. (2) DEBRIS HULL COLLIDERS: makeDebris's potato path now builds
`ColliderDesc.convexHull(displaced mesh positions)` (ball fallback if degenerate) with
`.setMass(density × nominal volume)` — exact mass WITHOUT knowing the hull's volume (the earlier
setDensity approach would need it; setMass lets Rapier derive just the inertia from the shape).
The hull's defining points go into `e.support` (exact drag floor-clamp). RESULT: chunks tumble and
SETTLE like rocks — 9/9 asleep after a violent shatter+scatter, where ball colliders rolled forever
(no rolling resistance in Rapier — this closes that long-standing note for debris). (3) LUMPY
ACCRETED PLANETS: both planet-mesh sites in mergePair use `lumpyUnitSphere()` = displaceSphere(unit
sphere 64×48, amps [0.055, 0.035, 0.022]) — same direction-pure displacement as potatoes (shared
`displaceSphere` helper; potatoGeometry = amps [0.16, 0.1, 0.07] at 24×16), so UV-seam verts stay
welded and the equirect SKIN survives — verified live: wood + steel splats land exactly at their
impact points on a visibly lumpy planet. Planet colliders stay BALLS (honest at ±7%; hull planets
would need hull-vs-growth handling — only do it if Rafael asks). Verified: mass exact through a
hull-debris shatter (68.43 → 68.43), console clean. NB FEATURES.md gotcha: an insert-before edit
ate the "Pause + time scale" HEADER line (old_string was the header, new_string forgot to re-append
it) — restored; when inserting before an entry, always re-emit the displaced line.
FLOOR SLAMS + HAMMER BREAKAGE + NO-SPHERE REACCRETION (2026-07-20): (1) FLOOR BREAKAGE — the ground
collider's handle is stored (`groundHandle`, set in addGroundCollider; events already fire because
the ENTITY collider carries COLLISION_EVENTS and Rapier ORs the two colliders' flags). drainContact-
Events (renamed from drainContactMerges earlier) now collects `floorHits` = contacts where exactly
one side maps to an entity and the other handle === groundHandle. A floor slam is an infinite-mass
impact: Q = ½·v_down² (v_down = -e.lastVel.y, pre-impact; μ→m so mass cancels — a boulder and a
pebble break at the same drop speed, physically right). Threshold = BREAK_Q·strengthOf·FLOOR_BREAK_
FACTOR(2.5) — tougher than a body hit so casual drops survive (verified: stone whole at 4.4/7.7 m/s,
shatters at 12.5≈8 m drop; ice cracks at 6.3; steel survives 14). Shares the BREAKS_PER_STEP cap
with body-body (passed as a `{n}` box so both loops mutate it). (2) HAMMER BREAKAGE — the body-body
loop was restructured: MERGE still needs full `canAccrete` of both, but SHATTER is now per-TARGET
via `canBreak(e)` = `!frozen && grab?.entity !== e && size >= BREAK_MIN_R`. So a GRABBED body breaks
what it rams while staying whole (you keep your hammer) — verified: held hammer → target shattered,
hammer survived. Previously the whole pair was skipped if either side failed canAccrete (grabbed),
so a dragged body couldn't break anything. (3) NO-SPHERE REACCRETION — the big one. Pure-material
accreted bodies USED to stay perfect pool spheres (spawn('sphere') in fresh-build, or a pool-sphere
big growing in place) — so shatter→reaccrete gave back a flawless sphere. Now `applyAccretedForm(e,
R, comp, bigComp, V)` decides the visual form for every merge: wantSkin (mixed & R≥0.8) → skinned
lumpy custom; wantCustom (R ≥ DEBRIS_POTATO_R 0.5) → PURE lumpy custom (dominant material's PBR/
color via accretedMaterialFor); else a tiny pool sphere (cheap, invisible lumps). It converts UP as
R climbs (pool→pure-lumpy→skinned) and calls growLumpyMesh which REBUILDS the geometry with fainter
bumps once R grows ≥15% — `lumpyGeometry(R)` fades amplitude k = 0.13/(1+max(0,R-0.5)·0.7), so ±13%
at R≈0.5 down to ±3.5% at R≈4 (measured) — small reassembled bodies are rubble asteroids, big
naturally-grown ones round out (hydrostatic-equilibrium look). Helpers: attachLumpyMesh / disposeMesh
/ growLumpyMesh / accretedMaterialFor. In-place-grow condition changed from `big.skin` to `!big.
support` (any BALL-collider custom grows in place — pool sphere, skinned, or pure-lumpy; only boxes
& hull-debris rebuild fresh, keyed off `support` which only debris sets). New Entity field `geoR` =
radius at last geometry build. Direction-pure displacement → skin UVs survive rebuilds, splats stay
put. VERIFIED: reassembled stone = irregular ×12 asteroid (kind custom, not sphere), mass 52.55
exact; mixed skinned accretion + craters unaffected (946→946, slug survived); 600-object pure-stone
storm mean 0.52 ms/step worst 11.5, peak 95 custom meshes, one round R=4.3 planet; console clean.
NB: pure-lumpy custom bodies keep BALL colliders (grow in place); the ±13% mesh pokes slightly past
the ball at small R — acceptable (same as skinned planets always have). NB2: lumpyUnitSphere() is
GONE, replaced by lumpyGeometry(R).
DURABILITY BUMP (2026-07-20, Rafael "make everything more durable"): `BREAK_Q` 18 → 45 — the single
master knob scaling EVERY shatter threshold (body-body AND floor both compute `BREAK_Q·strengthOf·
[FLOOR_FACTOR]`), so material differences stay intact and one number tunes overall toughness. Break
speed scales with √Q, so 2.5× the energy ≈ 1.6× the impact speed everything now survives. Verified:
stone floor-survives 8 m & 13 m drops (was breaking at 8 m), shatters ~20 m; ice survives 2 m, cracks
5 m; steel survives 20 m; stone pebble pairs bounce at 14 m/s closing (was shattering), break at 22.
To make things tougher/softer later, this is the ONE lever.
RENDER-POOL MICRO-OPT (2026-07-21): syncRender rebuilt a `${kind}:${mat.id}` key + Map.get for every
box/sphere every frame to find its InstancedMesh pool. A pooled body's (kind × material) never changes
(no `e.mat =` anywhere), so the pool ref is now CACHED on the entity (`e.pool ??= getPool(...)`; new
`RenderPool` interface + `Entity.pool`). Also hoisted the per-frame `performance.now()` to ONE read
reused by every skin flush + the ghost pulse. Behavior-identical; verified live (224 objects, colors/
shadows intact, no errors). Rapier's world.step still dominates (~99%) — this is a small, safe trim.
PHASE 7 SAVE/LOAD SHIPPED (2026-07-21): first Phase-7 slice. New `systems/persistence.ts` = the JSON
scene contract (SceneData/EntityData/FieldData/JointLink/WorldData) + material-by-id lookup + file
download / file-pick / `isSceneData` validation + `QUICKSAVE_KEY`. Sandbox gained serializeScene()/
loadScene()/spawnFromData()/addFieldFromData() + an `onSceneLoad` hook. UI: a "Scene" section (World
panel) with 💾 Save file · 📂 Load file (download/upload JSON) and ⚡ Quick-save · ↺ Quick-load (one
localStorage slot, survives refresh), plus a status line. WHAT ROUND-TRIPS EXACTLY: primitives
(box/sphere w/ per-body palette color), CUSTOM SHAPES via their equations (new `Entity.spec`/`specKind`
recorded in all four create* methods — rebuilt through createRevolution/Curve/Surface/Implicit then
forced to the saved pose+velocity, since create* drop at a random height), FIELDS (path polylines
re-sampled from the saved equations/stroke, not stored — keeps files small), JOINTS (by saved entity
INDEX; rebuilt with lockJoint at the saved pose — no re-docking), and ALL world settings + camera.
onSceneLoad re-syncs the World sliders/toggles (gravity/time/pull-G/pause/mutual-gravity/accretion/
breakage) so the panel matches the loaded sim. HONEST LIMIT: emergent procedural bodies — accreted
planets (their painted canvas skins) and shatter debris — have no equation to rebuild, so they're
SKIPPED and COUNTED (a joint touching a skipped body is dropped too); serializeScene reports `skipped`.
KEY LOAD DETAIL: do NOT call insertOrbits on a loaded gravity well — the saved velocities already
encode the orbit; re-inserting would overwrite them. VERIFIED LIVE (console-driven round-trips +
real UI buttons): 25 objects incl. a revolution + a vortex field + Moon gravity → clear → restore exact
(skipped 0, specKind 'revolution' intact); spring-joint round-trip (1→0→1); UI Quick-save → Delete all
→ Quick-load restored 27 objects; gravity slider snapped to −1.62; 30 fps; no console errors. NB: a
plain (untextured) custom shape's palette tint is baked at mesh creation, so it may reload a different
palette color — cosmetic only (shape/mass/physics/pose all exact). NEXT PHASE-7 SLICES: share URLs,
record→GIF/MP4, time REWIND (ring-buffer of states), undo/redo, a named scene library.
TIER 1 SHIPPED (2026-07-21, 8 features, each its own commit+push): (1) MAGNETIC field — F=q·v×B (q/m
folded into `strength`), force ⊥ velocity so movers curve into circles/helices keeping their speed; B
along local +Y, aim arrow. (2) DRAG-ZONE field — damps velocity toward 0 (slow-mo/terminal-velocity
pocket); `strength`=damping rate, capped DRAG_MAX 50 so rate·dt<1. Both are branches in fields.ts
`fieldForce` after the inf gate; auto-wired into buttons/editor (per-kind strength label). (3) BLOW
tool — one-shot radial gust (BLOW_RADIUS 6, BLOW_SPEED 14, up-bias) at the clicked point/object; a Tool
mode. (4) DUPLICATE tool — clones primitives (size/mat/colour) and custom shapes (rebuilt from the new
`Entity.spec`) beside the original at rest; procedural bodies (no recipe) = no-op. (5) HINGE MOTORS —
Connect-tool "Hinge motor" slider drives an acceleration-based velocity motor (`configureMotorVelocity`
on the RevoluteImpulseJoint; HINGE_MOTOR_FACTOR 2) on every edge hinge; a MOTORIZED hinge drops in-pair
collision (`setContactsEnabled(false)`) so it free-spins like a wheel, motor-off restores the door.
(6) PER-OBJECT GRAVITY — inspector "Gravity ×" slider → Rapier `setGravityScale` (1 normal / 0
weightless / <0 floats up), stored on `Entity.gravityScale`, save/load round-tripped, and the well/lift
gravity-suspension now multiplies by it. (7) BUOYANCY — a "Fluid" field kind (a water tank): region top
= surface, Archimedes upward force = fluidDensity·g·submergedVolume + fluid drag, computed with the
body's volume in the Sandbox field loop (`fluidForce` export; fieldForce returns 0 for it); `strength`=
density in water-units (1=water), so wood floats / steel sinks (verified 9.91 vs 0.5). Excluded from
flow tracers. (8) MOTION TRAIL — a fading ribbon on the SELECTED object (preallocated line, per-vertex
colour fading to background, 90-pt ring), automatic on selection, Display "Trails" toggle, one object
so zero cost at scale. All 8 verified live via console physics probes + real UI (magnetic speed held
6.2 while curving; drag 8→1.2; blow scattered 8 spheres ~12 m/s; hinge span 3.82 rad/s; gravity −1→
y930 up / 0→hover / 1→floor; wood/steel float/sink; trail 90 pts). NB motor methods are on
RevoluteImpulseJoint not the base ImpulseJoint (cast needed); motor target 0 with factor 0 = free hinge.
PERF: per-step post-solve loop now reads linvel() ONCE (reused capped components for the accel readout,
no 2nd WASM call) + plain sqrt not hypot. Verified 1000 objects, cap holds (max 22<60), 30 fps.
MENU REORGANIZED (2026-07-21, research-based — IxDF/UXPin progressive disclosure, Justinmind/Eleken
toggle grouping): top-level sections 10→7 — the 4 shape creators now NEST under one "Create shapes"
(`section(createBody, …)`; creators call new `openAncestorSections(panel)` to pop both levels). World
split into labelled sub-groups via a new `.subhead` (divider label): Time (pause+scale), Simulation
(mutual gravity + G, accretion, breakage — a `row wrap`, no longer a cramped 4-in-a-row), Display
(HD skins + new Trails toggle). Separated rendering (HD skins) from physics MODES. Panel 232→244px;
`.subhead` + nested-`.sec` CSS (indent + left border). onSceneLoad resync + all handler var names
unchanged. Verified: 7 sections, Create shapes expands to 4 nested creators, clean layout, no errors.
TUNING (2026-07-21, Rafael "accrete/break too easily, mutual gravity too strong"): mutual-gravity
default `selfG` 2→1; accretion `ACCRETE_SPEED` 2→1 + new `ACCRETE_ESCAPE_FRAC` 0.5 (was 0.7, both fuse
sites); `BREAK_Q` 45→90. All monotonic in the asked direction. Verified: default G reads 1; a 2.2 m/s
head-on pair that fused before now BOUNCES (2 objects, 0 accreted); resting pair still fuses.
ACCRETION MADE REALISTIC (2026-07-21, Rafael "100 blocks shouldn't accrete; mutual gravity too strong;
better merged shape"; researched: Ohtsuki 1993 / Morbidelli 2018 sticking, hydrostatic-equilibrium
shape threshold). TWO slices: (A) TRIGGER — accretion is now GRAVITATIONAL. Removed the flat cohesion
floor (`ACCRETE_SPEED` gone); a pair fuses only when gravitationally BOUND (rebound speed <
`ACCRETE_BIND_FRAC` 0.9 · v_esc) AND the escape velocity is meaningful (≥ `MIN_BIND_VESC` 0.25 m/s),
with G counted only while `selfGravityOn` (`effG`). So a plain pile (no mutual gravity) has ~0 escape
velocity and NEVER clumps (verified: 100 blocks stayed 100), while a self-gravitating cloud still
accretes (80 spheres → 1 planet). Both fuse sites (impact drain + 6 Hz scan) updated; accretion tooltip
now says it needs Mutual gravity. NB this REVERSES the old "accretion ≠ mutual gravity" decoupling —
deliberately, for realism. (B) SHAPE (interim; Rafael picked "angular rubble now, compounds later") —
small aggregates read as jagged RUBBLE CHUNKS, not smooth balls: `displaceSphere` now takes
`[amp,freq]` wave lists; `lumpyGeometry` uses 5 waves (freqs to 18.7) + bumpier small-R amplitude
(0.16), still fading with R so big bodies round out (hydrostatic equilibrium); pure accreted bodies get
`material.flatShading=true` so lumps read as rock FACETS (skinned planets keep smooth shading; debris
unaffected — own material). Ball collider unchanged (accepted approximation). Verified faceted asteroid
look at R 1.21. Also earlier this session: mutual-gravity default selfG 2→1, BREAK_Q 45→90.
Tuning knobs live in the constants block near the top of sandbox.ts.
COMPOUND (RUBBLE-PILE) MERGES SHIPPED (2026-07-21, the "compounds later" half — DONE): a small
accreted aggregate now keeps its component SHAPES as a rigid compound (box+sphere = a box stuck to a
sphere, each with its own collider/geometry/material), rounding into a sphere only past hydrostatic
equilibrium (`HYDRO_R` 2.6 equivalent-radius, or `MAX_CHUNKS` 10 parts). New `Chunk` type +
`Entity.chunks`; `mergeCompound` gathers both bodies' shapes as WORLD-space chunks (`worldChunksOf` →
`chunkFromBody`: box→cuboid, sphere→ball, custom→convex hull of its world-scaled geometry, up to 60
sampled pts), rebases onto the c.o.m., and builds ONE body with a density-0 collider per part + an
explicit inertia tensor (per-part equivalent-sphere own-inertia + parallel axis, diagonalized via
shapes.ts `eigenSymmetric3` → `frameFromEigen`) so mass is EXACT (verified 1.524→1.524, 120.9 across
160 bodies). Union mesh = `mergeGeometries(geos, true)` with per-chunk material GROUPS + material
ARRAY; new shared `disposeMaterials` frees the array in deleteEntity/clear/disposeMesh, and syncRender
tints every element (emissive on an array would've thrown). Drag support pts gathered from part
corners. Routing lives in mergePair before the sphere paths: `R_eq ≤ HYDRO_R && chunkCount ≤
MAX_CHUNKS` → mergeCompound, else the sphere path (a compound has `support`, so it hits fresh-build and
rounds). Gotchas that worked out: worldChunksOf CLONES geometry+material so deleting the parents is
safe; a rounded planet re-entering a compound is one hull chunk (so chunk counts can drop). Verified:
box+sphere union drops & lands (y 0.5), 16-body → 6-chunk rubble, 160-body → rounded 1-collider planet,
breakage on a compound shatters clean; no console errors. HONEST NOTES: compound collider per-part is
box/ball/hull (concavity of a custom part is convex-hulled); compounds aren't save/loadable yet (no
spec, skipped like planets); mixed compounds show distinct chunk materials (no blended skin below
HYDRO_R — realistic). NEXT for accretion realism if pushed further: per-part fracture (a compound
sheds individual chunks instead of shattering to debris); Roche/tidal breakup.
DRAG WHILE PAUSED + HARDER ACCRETION (2026-07-21): (1) you can now reposition objects while PAUSED —
physics is frozen so the normal joint-pull grab (in stepPhysics) never runs; new `dragWhilePaused()`
(called from the render loop when `paused && grab`) sets the grabbed body's transform directly to keep
the grabbed spot under the cursor (clamped above floor + in bounds), zeros velocity, and moves the kin
anchor to match so unpausing resumes seamlessly. Grab record gained `grabOffset` (body centre − grab
point). Verified: box moved (0,0.5,0)→(-0.69,1.56,1.49) paused, stays put on release. (2) accretion a
little harder: `ACCRETE_BIND_FRAC` 0.9→0.7, `MIN_BIND_VESC` 0.25→0.4.
REALISTIC BREAKAGE — SLICE 1 (2026-07-21, researched: Leinhardt & Stewart universal largest-remnant
law, Grady-Kipp fragmentation, π-scaling craters): `shatter` now takes `(Q, thr)` and distributes
fragment SIZES by physics instead of a fixed split. LARGEST-REMNANT LAW: `fLr = clamp(-0.5(Q/Q*−1)+0.5,
0.08, 0.5)` — a marginal hit (Q≈Q*) leaves a ~half-mass remnant + a few pieces; a violent one (Q≥2Q*)
is super-catastrophic (pulverized, no dominant survivor). The non-remnant mass follows a POWER-LAW
rank-size distribution (`v_i ∝ i^-BREAK_FRAG_ALPHA` 1.9 — few larger, many smaller), with a finite
minimum fragment radius (`BREAK_MIN_FRAG` 0.12; crumbs fold into the remnant — no dust). Fragment COUNT
grows with severity + size (`nFrag = clamp(2+5(sup−1)+R0·1.5, 2, 13)`). Crater size now π-scales
(diameter ∝ E^¼ ∝ √v). Headroom guard +8→+14. Verified live (stone floor slams, mass EXACT): marginal
Q/Q*≈1.16 → 5 fragments / largest 42%; violent Q/Q*≈5.6 → 16 fragments / largest 24%. NEXT BREAKAGE
SLICES: cratering/spall regime (a sub-shatter hit ejects a chip + dents any body, not just skinned
planets); a COMPOUND sheds its individual chunks instead of shattering to generic debris; irregular
(hull) fragment shapes with fracture-plane faces; Roche/tidal breakup; then move on to the MUTUAL
GRAVITY and FORCES realism passes.
LIKELY NEXT (Rafael's plan): finish the BREAKAGE realism (slices above), then MUTUAL GRAVITY, then the
FORCES. Also queued: affected-object glow/tint; drawpad per-axis ortho cam; Tier-2 (rewind, share URLs,
save accreted planets/compounds). NB screenshotting a 500ms shockwave: pin `S.shocks[0].born = now-190`.
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
