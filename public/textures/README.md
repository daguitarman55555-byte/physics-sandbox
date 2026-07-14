# PBR texture maps

Downloaded 2026-07-14 from [ambientCG](https://ambientcg.com) — **CC0 1.0** (public domain, no
attribution required). 1K JPG variants; `normal.jpg` is the OpenGL-convention normal map
(what Three.js expects). Higher resolutions (2K/4K/8K) of the same assets are available at the
source pages if we ever want them.

| Folder    | Source asset | Page                                    | Maps |
|-----------|--------------|-----------------------------------------|------|
| `wood/`   | Wood092      | https://ambientcg.com/a/Wood092         | albedo · normal · roughness |
| `steel/`  | Metal009     | https://ambientcg.com/a/Metal009        | albedo · normal · roughness · metalness |
| `rubber/` | Rubber004    | https://ambientcg.com/a/Rubber004       | albedo · normal · roughness |
| `ice/`    | Ice003       | https://ambientcg.com/a/Ice003          | albedo · normal · roughness |
| `stone/`  | Rock058      | https://ambientcg.com/a/Rock058         | albedo · normal · roughness |

Folder names match the `Material.id` values in `src/systems/materials.ts`; files are served by
Vite from `/textures/<id>/<map>.jpg`.
