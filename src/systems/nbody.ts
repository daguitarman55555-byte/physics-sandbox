/**
 * Self gravity (mutual N-body attraction) — every object pulls every other, so a cloud of rubble
 * under a star's well can clump, accrete, and orbit itself into planets and moons. Barnes-Hut
 * octree: far-away groups collapse to their centre of mass (opening angle THETA), giving
 * O(n log n) per step — ~1000 bodies is comfortable at 60 Hz where the direct O(n²) pair loop
 * (500k pair evaluations per step) is not.
 *
 * Deliberately dependency-free (no three/rapier imports) and allocation-free after warm-up:
 * flat typed arrays for bodies and tree nodes, an explicit traversal stack — benchmarkable
 * headless in node, and never stutters the frame loop with GC.
 */

const THETA = 0.7; // opening angle: a node of side s at distance d is a point mass when s < θ·d
const THETA2 = THETA * THETA;
// Plummer softening (m): caps the 1/r² blow-up for touching/overlapping bodies so close encounters
// slingshot smoothly instead of detonating (the collision solver handles the actual contact). It
// also makes self-force exactly zero: a body alone in its leaf sees d=0 → force 0, no special case.
const SOFT2 = 0.6 * 0.6;
const MAX_DEPTH = 24; // subdivision floor — near-coincident points stop splitting and pool into one leaf

export class NBody {
  n = 0;
  // bodies
  px = new Float64Array(0);
  py = new Float64Array(0);
  pz = new Float64Array(0);
  m = new Float64Array(0);
  ax = new Float64Array(0);
  ay = new Float64Array(0);
  az = new Float64Array(0);

  // tree nodes (struct-of-arrays): cube centre + half-size; Σmass; Σm·pos during build, divided
  // into the true centre of mass by finalize; leaf body index (-1 = internal/empty); subtree body
  // count; 8 child indices per node (-1 = absent)
  private cx = new Float64Array(0);
  private cy = new Float64Array(0);
  private cz = new Float64Array(0);
  private hh = new Float64Array(0);
  private nm = new Float64Array(0);
  private sx = new Float64Array(0);
  private sy = new Float64Array(0);
  private sz = new Float64Array(0);
  private leaf = new Int32Array(0);
  private cnt = new Int32Array(0);
  private child = new Int32Array(0);
  private used = 0;
  private stack = new Int32Array(4096);

  /** Grow body arrays to hold at least n (contents preserved; only ever called between steps). */
  ensure(n: number) {
    if (this.px.length >= n) return;
    const cap = Math.max(256, 1 << Math.ceil(Math.log2(n)));
    const grow = (old: Float64Array) => { const a = new Float64Array(cap); a.set(old); return a; };
    this.px = grow(this.px); this.py = grow(this.py); this.pz = grow(this.pz);
    this.m = grow(this.m);
    this.ax = grow(this.ax); this.ay = grow(this.ay); this.az = grow(this.az);
  }

  set(i: number, x: number, y: number, z: number, mass: number) {
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.m[i] = mass;
  }

  private growNodes() {
    const cap = Math.max(1024, this.cx.length * 2);
    const growF = (old: Float64Array) => { const a = new Float64Array(cap); a.set(old); return a; };
    const growI = (old: Int32Array, k: number) => { const a = new Int32Array(cap * k); a.set(old); return a; };
    this.cx = growF(this.cx); this.cy = growF(this.cy); this.cz = growF(this.cz);
    this.hh = growF(this.hh);
    this.nm = growF(this.nm); this.sx = growF(this.sx); this.sy = growF(this.sy); this.sz = growF(this.sz);
    this.leaf = growI(this.leaf, 1); this.cnt = growI(this.cnt, 1); this.child = growI(this.child, 8);
  }

  private newNode(x: number, y: number, z: number, half: number): number {
    if (this.used >= this.cx.length) this.growNodes();
    const k = this.used++;
    this.cx[k] = x; this.cy[k] = y; this.cz[k] = z; this.hh[k] = half;
    this.nm[k] = 0; this.sx[k] = 0; this.sy[k] = 0; this.sz[k] = 0;
    this.leaf[k] = -1; this.cnt[k] = 0;
    this.child.fill(-1, k * 8, k * 8 + 8);
    return k;
  }

  /** The child octant of `node` containing (x,y,z), created on first visit. */
  private childFor(node: number, x: number, y: number, z: number): number {
    const o = (x >= this.cx[node] ? 1 : 0) | (y >= this.cy[node] ? 2 : 0) | (z >= this.cz[node] ? 4 : 0);
    const slot = node * 8 + o;
    let c = this.child[slot];
    if (c < 0) {
      const h = this.hh[node] / 2;
      c = this.newNode(
        this.cx[node] + ((o & 1) ? h : -h),
        this.cy[node] + ((o & 2) ? h : -h),
        this.cz[node] + ((o & 4) ? h : -h),
        h,
      );
      this.child[slot] = c; // set AFTER newNode — it may have swapped the arrays out to grow them
    }
    return c;
  }

  private insert(i: number) {
    const x = this.px[i], y = this.py[i], z = this.pz[i], mi = this.m[i];
    if (!(mi > 0)) return; // a body created this very tick reads mass 0 — it neither pulls nor needs a slot
    let node = 0;
    let depth = 0;
    for (;;) {
      this.nm[node] += mi;
      this.sx[node] += mi * x; this.sy[node] += mi * y; this.sz[node] += mi * z;
      this.cnt[node]++;
      if (this.cnt[node] === 1) { this.leaf[node] = i; return; } // empty → now a 1-body leaf
      const resident = this.leaf[node];
      if (resident >= 0) {
        if (depth >= MAX_DEPTH) return; // coincident-point pool: fold into aggregates only
        // leaf → internal: push the resident one level down, then keep descending with i
        this.leaf[node] = -1;
        const rm = this.m[resident];
        const c = this.childFor(node, this.px[resident], this.py[resident], this.pz[resident]);
        this.nm[c] += rm;
        this.sx[c] += rm * this.px[resident]; this.sy[c] += rm * this.py[resident]; this.sz[c] += rm * this.pz[resident];
        this.cnt[c] = 1; this.leaf[c] = resident;
      }
      node = this.childFor(node, x, y, z);
      depth++;
    }
  }

  /** Rebuild the octree over bodies [0, n). Call after set()ing every body, before accel(). */
  build(n: number) {
    this.n = n;
    this.used = 0;
    if (n === 0) return;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = this.px[i], y = this.py[i], z = this.pz[i];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const half = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.5001 + 1e-6;
    this.newNode((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2, half);
    for (let i = 0; i < n; i++) this.insert(i);
    // finalize: Σm·pos → centre of mass
    for (let k = 0; k < this.used; k++) {
      const mk = this.nm[k];
      if (mk > 0) { this.sx[k] /= mk; this.sy[k] /= mk; this.sz[k] /= mk; }
    }
  }

  /** Fill ax/ay/az with the gravitational acceleration on every body (independent of its own mass). */
  accel(G: number) {
    const n = this.n;
    this.ax.fill(0, 0, n); this.ay.fill(0, 0, n); this.az.fill(0, 0, n);
    if (this.used === 0 || G === 0) return;
    const px = this.px, py = this.py, pz = this.pz;
    const nm = this.nm, sx = this.sx, sy = this.sy, sz = this.sz;
    const hh = this.hh, leaf = this.leaf, child = this.child;
    let stack = this.stack;
    for (let i = 0; i < n; i++) {
      const x = px[i], y = py[i], z = pz[i];
      let axi = 0, ayi = 0, azi = 0;
      let sp = 0;
      stack[sp++] = 0;
      while (sp > 0) {
        const nd = stack[--sp];
        const mass = nm[nd];
        if (mass <= 0) continue;
        const dx = sx[nd] - x, dy = sy[nd] - y, dz = sz[nd] - z;
        const d2 = dx * dx + dy * dy + dz * dz;
        const s = hh[nd] * 2;
        // accept as a point mass: any leaf (incl. depth-capped pools — softening zeroes the
        // self-term), or a far-enough internal node by the opening criterion
        if (leaf[nd] >= 0 || s * s < THETA2 * d2) {
          const dr = d2 + SOFT2;
          const w = (G * mass) / (dr * Math.sqrt(dr));
          axi += dx * w; ayi += dy * w; azi += dz * w;
        } else {
          if (sp + 8 > stack.length) { const g = new Int32Array(stack.length * 2); g.set(stack); this.stack = stack = g; }
          const base = nd * 8;
          for (let o = 0; o < 8; o++) { const c = child[base + o]; if (c >= 0) stack[sp++] = c; }
        }
      }
      this.ax[i] = axi; this.ay[i] = ayi; this.az[i] = azi;
    }
  }
}
