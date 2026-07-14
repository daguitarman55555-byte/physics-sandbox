# Physics Sandbox — Handoff

Paste this whole file as the first message in a new chat to continue the project with full context.

## What this is

A real-time, browser-based **physics sandbox** for play & learning (build things, break things, and
eventually zoom from a tabletop out to a solar system or down to atoms). It is a **separate project**
from `RealisticPhysicsEngine` (a from-scratch verified Python engine) — this one is play-focused and
built on a mature real-time engine.

- **Location:** `C:\Users\rafae\OneDrive\Projects\physics-sandbox`
- **Stack:** Vite + TypeScript · Three.js (rendering) · Rapier `@dimforge/rapier3d-compat` (physics, Rust→WASM)
- **Run:** `cd` into the folder, `npm install` (first time), `npm run dev` → open the printed URL (http://localhost:5173)

## Current state — Phase 1 DONE and verified

Verified working: **800+ objects holding a solid 60 fps**, real shadows, no console errors.

Works now: fixed-timestep loop + render interpolation · `InstancedMesh` rendering (one draw call per
shape) · spawn box/sphere/+100 · drag & throw (clamped, no teleport/fling) · OrbitControls camera ·
gravity slider + Earth/Moon/Zero-G · reset · click-to-select **object inspector** (live speed, angular
velocity, mass, kinetic energy, sleep state) · FPS/object/awake HUD.

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

Recommended next build: **Phase 2 — shape creation** (the differentiator): `f(x)` solids of revolution
and **parametric** curves/surfaces, with correct mass/inertia. Or pick any item from `docs/FEATURES.md`.

## Working loop for each task

Design briefly → implement one system → `npx tsc --noEmit` (type-check) → ensure `npm run dev` is up →
**open in the Claude browser + screenshot + check console** (the standing rule) → tick it off in
`docs/FEATURES.md` → report with the screenshot. Ship one coherent thing at a time; stop and let Rafael
try it. Rafael writes no code — propose decisions as specific questions.
