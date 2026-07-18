# Forces, Fields & Drawing — Upgrade Research

A living research dossier for making the sandbox's forces/fields and force-drawing **more powerful,
more interactive, and more fun**. Compiled 2026-07-17/18. Sources are linked inline and collected at
the end. Each idea notes rough **effort** (S/M/L) and how it fits the existing engine
(`systems/fields.ts` velocity-target model, `fieldForce`, `systems/fieldviz.ts` tracers, `drawpad.ts`).

Status legend: ✅ already built · 🔜 proposed · 🧪 experimental/uncertain.

---

## 0. What we already have (baseline)

- Fields: attractor, repeller, wind, vortex (Rankine + updraft), gravity well (1/r² + Coriolis + gravity
  suspension), path/flow (any curve, auto-flat, lift), turbulence (curl-noise, gentle), explosion (one-shot).
- Region shapes (sphere/box/cylinder), smoothstep boundary, per-field + global strength.
- Live glowing flow **tracers** advected by the real `fieldForce`; ghost preview dimmed.
- **Force brush** (push/pull/swirl); **Draw-a-flow** mini 3D editor (Chaikin-smoothed, glowing).
- Quick scenes (Tornado / Wind tunnel / Black hole). Fit-to-objects. Camera shake on blasts.

---
<!-- Sections below are filled in progressively; see git history. -->
