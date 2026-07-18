# Forces, Fields & Drawing — Upgrade Research

A living research dossier for making the sandbox's forces/fields and force-drawing **more powerful,
more interactive, and more fun**. Compiled 2026-07-17/18. Sources collected at the end. Each idea
notes rough **effort** (S/M/L) and how it fits the existing engine (`systems/fields.ts`
velocity-target model, `fieldForce`, `systems/fieldviz.ts` tracers, `drawpad.ts`).

Status legend: ✅ already built · 🔜 proposed · 🧪 experimental/uncertain.

---

## 0. What we already have (baseline)

- Fields: attractor, repeller, wind, vortex (flat Rankine), **tornado** (wall-updraft recirculator),
  gravity well (pure Newtonian + orbital insertion), path/flow (any curve, auto-flat, lift),
  turbulence (curl-noise, gentle), explosion (one-shot + shockwave + shake).
- Region shapes (sphere/box/cylinder), smoothstep boundary, per-field + global strength, ⇄ reverse.
- Live glowing flow **tracers** advected by the real `fieldForce`; dimmed ghost previews.
- **Force brush** (push/pull/swirl); **Draw-a-flow** mini 3D editor (Chaikin-smoothed, glowing).
- Quick scenes (Tornado / Wind tunnel / Black hole). Fit-to-objects. Camera shake on blasts.

---

## 1. New field kinds (physics that earns its place)

| Idea | What it does | Fit / notes | Effort |
|---|---|---|---|
| 🔜 **Magnetic field** | F = q·v×B — force ⊥ velocity, so movers curve into circles/helices. Distinct from vortex (position-driven): a magnetic zone only affects *moving* bodies, and faster ones curve harder. Give each body a "charge" (± by material or per-object toggle) so red/blue objects split apart in the same field — the classic mass-spectrometer demo, and a genuinely new *interaction* (charge as a new object property). | `fieldForce` already receives `vel`; add per-entity `charge`. The old Coriolis-well bug is actually the correct physics HERE (cyclotron circles are what magnets do). | M |
| 🔜 **Drag zone / slow-mo bubble** | Damps velocity toward zero inside the region — terminal-velocity pockets, "bullet-time" bubbles you can throw things through. Fun inverse of every other field: it *removes* energy. Also the missing piece for orbits: a thin drag shell makes captured debris settle into clean rings (how accretion discs actually form). | Trivial in the model: target velocity = 0, response = strength. | S |
| 🔜 **Harmonic trap (spring well)** | F = −k·x toward the centre — bodies oscillate forever through the middle (all periods equal, regardless of amplitude: the isochronism demo). Reads as "bouncy magnet". | One line in `fieldForce`; conservative like the well, so no damping term. | S |
| 🧪 **Time-dilation zone** | Scale each body's *effective dt* inside the region (slow-motion field). Real crowd-pleaser in sandbox videos. Rapier can't step bodies at different rates, but a good fake: inside the region, scale velocity down on entry and up on exit (store a per-entity factor). Honest limitation: contacts across the boundary look odd. | M/L, needs per-entity state + careful enter/exit bookkeeping. | L |
| 🧪 **Repulsor floor / force platform** | A flat box field pushing +Y with strength ≈ g — a hover zone; objects float and bob on it. Trivially a wind pointed up, but a dedicated preset with tuned strength = g reads as a new toy. | Quick-scene preset, zero new code. | S |

## 2. Interaction upgrades (the GMod lesson)

Garry's Mod's enduring loves are the **physics gun** (grab/rotate/freeze — we have grab + freeze;
missing: *rotate while held* and *distance reel*) and the **tool gun** (motors, winches, thrusters
attached to objects). The pattern: **attach forces to OBJECTS, not just regions.**

| Idea | What it does | Fit / notes | Effort |
|---|---|---|---|
| 🔜 **Thruster (per-object)** | Click an object → attach a small rocket (constant body-local force + flame sprite). Suddenly every object is a vehicle; combined with joints you build steerable contraptions. The single most-requested "tool gun" feature. | New per-entity list applied in `stepPhysics`; marker = cone + flame sprite. | M |
| 🔜 **Grab upgrades** | Scroll while grabbing = reel the object closer/farther; R while grabbing = rotate it. Straight from the physics gun. | Extend existing grab (kinematic anchor already exists). | S |
| 🔜 **Motor joint** | The joints system already docks hinges — add `configureMotorVelocity` on the revolute so hinges SPIN (fans, wheels, windmills). Rapier supports it natively. | S — `joint.configureMotorVelocity(v, factor)`. | S |
| 🔜 **Slingshot / launcher tool** | Drag an object back like a slingshot (shows predicted trajectory arc), release to fire. The aim-arc preview is the juice. | Ballistic arc = pure math over gravity; reuse drag infra. | M |

## 3. Field UX & visualization

| Idea | What it does | Fit / notes | Effort |
|---|---|---|---|
| 🔜 **Motion streaks for tracers** | Replace/augment tracer dots with short line segments along their velocity (prev→curr). Flow *direction* becomes readable in a still frame and screenshots. | `fieldviz` already stores positions each frame; LineSegments buffer. | S |
| 🔜 **Affected-object tint** | Objects currently inside any field get a faint emissive tint in the field's color — you instantly see *who* is being acted on. | `syncRender` already does per-instance color (frozen tint exists). | S |
| 🔜 **Field strength heat-shell** | Optional translucent shells at 25/50/75% influence radii (like the magnetic-field line interactives) so the soft edge is *visible*. | Marker add-on; three more wireframe hulls. | S |
| 🔜 **Per-object trails** | Toggleable ribbon trails on objects (orbit paths! tornado helixes!). The Universe-Sandbox signature look; makes the well's ellipses undeniable. | Ring buffer per entity + one Line per tracked object; cap to selection or ~20 nearest. | M |

## 4. Drawing (the drawpad's next steps)

| Idea | What it does | Fit / notes | Effort |
|---|---|---|---|
| 🔜 **Ortho views done right** | X/Y/Z buttons already snap the view; add a visible "plane lock" chip so it's obvious which plane strokes land on. | UI only. | S |
| 🔜 **Symmetry / mirror mode** | Draw half, get the mirrored whole (2-fold or radial N-fold, spirograph-style). Cheap and *delightful* — most people can't draw a clean loop freehand. | Mirror the point list live in `updateLine`. | S |
| 🔜 **Draw = tube region option** | A drawn stroke can become a **drag zone / wind tube** instead of a flow path (pick the field kind at Place time). One drawing UI, every region-ish force. | `createDrawnPath` already builds the tube; branch on kind. | M |
| 🧪 **Stroke → revolution solid** | Feed the drawpad stroke into the f(x) revolution creator (draw a vase profile, get the vase). Bridges drawing into the SHAPES half of the sandbox. | The creators take point lists after parse — needs a profile-fit pass. | M/L |

## 5. Presets & scenes

- 🔜 **More quick scenes** (each = one pre-tuned ghost, S each): **🪐 Orbit dance** (two wells,
  binary-star), **🌊 Whirlpool** (wide flat vortex at floor level), **⛲ Fountain** (small repeller
  under a drag dome), **🎪 Juggler** (harmonic trap + slow drag — perpetual gentle juggling).
- 🔜 **Scene randomizer** ("Surprise me"): plausible random field combo + spawn burst. Powder-Toy
  players report this is how they discover mechanics.
- 🧪 **Save/share a field setup** as JSON (precursor to Phase 7 save/load — fields serialize
  trivially except `path.pts`, which re-samples from `spec`).

## 6. Prioritized shortlist (if Rafael asks "what next")

1. **Motor joint** (S) — one Rapier call, unlocks machines with existing joints.
2. **Drag zone** (S) — trivial, doubles as the orbit-ring maker.
3. **Motion streaks + affected tint** (S+S) — the two cheapest readability wins.
4. **Thruster** (M) — the tool-gun pattern; biggest "new toy" per line of code.
5. **Magnetic field + charge** (M) — new physics dimension (per-object property), real science demo.
6. **Symmetry drawing** (S) — delight for the drawpad.

## Sources

- [Garry's Mod — Wikipedia](https://en.wikipedia.org/wiki/Garry%27s_Mod) · [gmod.facepunch.com](https://gmod.facepunch.com/) — physics gun, tool gun, motors/winches, spawn-menu culture
- [The "Juice" Factor: Designing Game Feel](https://hackread.com/the-juice-factor-designing-game-feel/) — screen shake, hit-stop, squash/stretch
- [Impulse Ball](https://plays.org/impulse-ball/) — a whole game on one-shot shockwaves
- [Powder Game](https://artsology.com/powder-game.php) · [PhysSandbox](https://physandbox.com/) · [Particle Sandbox](http://particlesandbox.com/) — element/field variety, discovery-driven play
- [Sandbox Physics Simulator (Google Play)](https://play.google.com/store/apps/details?id=com.tgame.sand.box&hl=en_US) — black hole as a headline material
- [Physics Classroom: Magnetic Field interactive](https://www.physicsclassroom.com/Physics-Interactives/Magnetism/Magnetic-Field) · [Magnet Mania 3D](https://store.steampowered.com/app/2298650/Magnet_Mania_3D/) — field-line visualization, magnetism as play
- [Time Dilation Simulation](https://physics-simulations.org/simulation/time-dilation/) · [Time Dilation Visualizer](https://timedilationsvelocity.netlify.app/) — relativity zones as interactive toys
- [Math for Programmers ch. 11: Simulating Force Fields](https://livebook.manning.com/book/math-for-programmers/chapter-11/v-9) — vector-field force modeling reference
