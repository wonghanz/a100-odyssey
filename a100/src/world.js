// ============================================================================
// world layout + procedural content generation (load-time only)
// ============================================================================
// Scale: 1 unit ~ 1 m in the stylised world. See the plan at the top of shaders.js.
const PAL = { sm: [.42, 1, .12], l2: [.5, .2, 1], xb: [.1, .78, 1], hb: [1, .52, .08], ph: [1, .16, .62], wh: [1, .95, .8] };
// wire colour ids (shaders.js W_WIRE): 0 SM green, 1 cyan, 2 violet, 3 amber, 4 magenta, 5 white
// packet colour ids (W_PKT): 0 cyan, 1 green, 2 violet, 3 amber, 4 magenta, 5 white
const CEIL = 58; // y of the lid (same as CEIL in the WGSL)
const SMX = -30, SMZ = -84; // the enlarged SM (north row, 2nd GPC)
const TCX = -30, TCZ = 84;  // the tensor core atrium (south row, 2nd GPC)
const GPCS = []; for (let i = 0; i < 8; i++) GPCS.push([-90 + (i % 4) * 60, i < 4 ? -84 : 84, i]);
// M_* mesh ids
const M_BOX = 0, M_CYL = 1, M_CONE = 2, M_SPH = 3, M_TREE = 4, M_RING = 5, M_DART = 6, M_CYLX = 7;
// instance stores: [mesh, draw distance (scaled by the detail level), culled by cell]. Small parts get their own store
// with a short draw distance; the orbiting thread blocks move between cells, so they are drawn without culling.
const STORES = [[M_BOX, 190, 1], [M_CYL, 150, 1], [M_CONE, 200, 1], [M_SPH, 160, 1], [M_TREE, 260, 1], [M_RING, 260, 1], [M_BOX, 88, 1], [M_CYLX, 200, 1], [M_CYL, 70, 1], [M_BOX, 0, 0]];
const S_BOX = 0, S_CYL = 1, S_CONE = 2, S_SPH = 3, S_TREE = 4, S_RING = 5, S_DET = 6, S_PIPE = 7, S_BUMP = 8, S_ORB = 9;

// ---------------------------------------------------------------- terrain mesh from the density grid
function buildTerrain(D) {
  const sn = surfaceNets(D, NX, NY, NZ), nv = sn.nv, gp = sn.pos;
  const smp = sampler3(D, NX, NY, NZ);
  const vb = new ArrayBuffer(nv * 16), vf = new Float32Array(vb), v8 = new Int8Array(vb);
  const wp = new Float32Array(nv * 3);
  for (let k = 0; k < nv; k++) {
    const x = gp[k * 3], y = gp[k * 3 + 1], z = gp[k * 3 + 2], e = 0.8;
    let nx = smp(x - e, y, z) - smp(x + e, y, z), ny = smp(x, y - e, z) - smp(x, y + e, z), nz = smp(x, y, z - e) - smp(x, y, z + e);
    const l = hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const X = OX + x * VS, Y = OY + y * VS, Z = OZ + z * VS;
    wp[k * 3] = vf[k * 4] = X; wp[k * 3 + 1] = vf[k * 4 + 1] = Y; wp[k * 3 + 2] = vf[k * 4 + 2] = Z;
    v8[k * 16 + 12] = round(nx * 127); v8[k * 16 + 13] = round(ny * 127); v8[k * 16 + 14] = round(nz * 127); v8[k * 16 + 15] = 127;
  }
  // bucket quads into the XZ culling grid
  const nq = sn.ni / 6, key = new Uint16Array(nq), cnt = new Uint32Array(CELLS * CELLS + 1);
  const lo = new Float32Array(CELLS * CELLS).fill(1e9), hi = new Float32Array(CELLS * CELLS).fill(-1e9);
  for (let q = 0; q < nq; q++) {
    const a = sn.idx[q * 6] * 3;
    const c = clamp(floor((wp[a] - OX) / CELLW), 0, CELLS - 1) + CELLS * clamp(floor((wp[a + 2] - OZ) / CELLW), 0, CELLS - 1);
    key[q] = c; cnt[c + 1]++;
    for (let j = 0; j < 6; j++) { const y = wp[sn.idx[q * 6 + j] * 3 + 1]; if (y < lo[c]) lo[c] = y; if (y > hi[c]) hi[c] = y; }
  }
  for (let c = 0; c < CELLS * CELLS; c++) cnt[c + 1] += cnt[c];
  const ib = new Uint32Array(sn.ni), fill = cnt.slice();
  for (let q = 0; q < nq; q++) { const o = fill[key[q]]++ * 6; for (let j = 0; j < 6; j++) ib[o + j] = sn.idx[q * 6 + j]; }
  return { vb, ib, nv, wp, smp, start: cnt, lo, hi };
}

// ---------------------------------------------------------------- procedural meshes (unit size, base at y = 0)
// quad with the winding fixed so that its normal points along (rx, ry, rz)
function quadO(m, a, b, c, d, rx, ry, rz) {
  const P = m.p, ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
  const vx = P[c * 3] - P[a * 3], vy = P[c * 3 + 1] - P[a * 3 + 1], vz = P[c * 3 + 2] - P[a * 3 + 2];
  const d0 = (uy * vz - uz * vy) * rx + (uz * vx - ux * vz) * ry + (ux * vy - uy * vx) * rz;
  if (d0 >= 0) m.quad(a, b, c, d); else m.quad(a, d, c, b);
}
function meshBox() {
  const m = new Mesh();
  const face = (n, u, v) => {
    const c = [n[0] * 0.5, n[1] * 0.5 + 0.5, n[2] * 0.5];
    const P = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => m.v(c[0] + (u[0] * a + v[0] * b) * 0.5, c[1] + (u[1] * a + v[1] * b) * 0.5, c[2] + (u[2] * a + v[2] * b) * 0.5));
    quadO(m, P[0], P[1], P[2], P[3], n[0], n[1], n[2]);
  };
  face([1, 0, 0], [0, 1, 0], [0, 0, 1]); face([-1, 0, 0], [0, 1, 0], [0, 0, 1]);
  face([0, 1, 0], [1, 0, 0], [0, 0, 1]); face([0, -1, 0], [1, 0, 0], [0, 0, 1]);
  face([0, 0, 1], [1, 0, 0], [0, 1, 0]); face([0, 0, -1], [1, 0, 0], [0, 1, 0]);
  return m.build();
}
// cylinder (tip = .5) or cone (tip = 0), radius .5 at the bottom, height 1; lying = turned to lie along x (pipes),
// still filling y 0..1
function meshCyl(seg, tip, lying) {
  const m = new Mesh(), bot = [], top = [];
  for (let s = 0; s < seg; s++) { const a = s / seg * TAU; bot.push(m.v(cos(a) * 0.5, 0, sin(a) * 0.5)); top.push(m.v(cos(a) * tip, 1, sin(a) * tip)); }
  for (let s = 0; s < seg; s++) { const s2 = (s + 1) % seg, a = (s + 0.5) / seg * TAU; quadO(m, bot[s], bot[s2], top[s2], top[s], cos(a), 0, sin(a)); }
  if (tip > 0) {
    const c = m.v(0, 1, 0), ring = []; for (let s = 0; s < seg; s++) { const a = s / seg * TAU; ring.push(m.v(cos(a) * tip, 1, sin(a) * tip)); }
    for (let s = 0; s < seg; s++) m.tri(c, ring[(s + 1) % seg], ring[s]); // angle grows from +x towards +z: this order faces up
    if (lying) { const b = m.v(0, 0, 0), r2 = []; for (let s = 0; s < seg; s++) { const a = s / seg * TAU; r2.push(m.v(cos(a) * 0.5, 0, sin(a) * 0.5)); } for (let s = 0; s < seg; s++) m.tri(b, r2[s], r2[(s + 1) % seg]); }
  }
  if (lying) for (let i = 0; i < m.p.length; i += 3) { const x = m.p[i], y = m.p[i + 1]; m.p[i] = y - 0.5; m.p[i + 1] = 0.5 - x; } // a rotation: windings stay outward
  return m.build();
}
function meshSphere() { return icosphere(2, (x, y, z) => [x * 0.5, y * 0.5 + 0.5, z * 0.5]).build(); }
// flat ring: outer radius .5, inner .4, height 1
function meshRing(seg = 32) {
  const m = new Mesh(), o0 = [], o1 = [], i0 = [], i1 = [], t0 = [], t1 = [];
  for (let s = 0; s < seg; s++) { const a = s / seg * TAU, c = cos(a), n = sin(a); o0.push(m.v(c * 0.5, 0, n * 0.5)); o1.push(m.v(c * 0.5, 1, n * 0.5)); i0.push(m.v(c * 0.4, 0, n * 0.4)); i1.push(m.v(c * 0.4, 1, n * 0.4)); t0.push(m.v(c * 0.5, 1, n * 0.5)); t1.push(m.v(c * 0.4, 1, n * 0.4)); }
  for (let s = 0; s < seg; s++) {
    const s2 = (s + 1) % seg, a = (s + 0.5) / seg * TAU, c = cos(a), n = sin(a);
    quadO(m, o0[s], o0[s2], o1[s2], o1[s], c, 0, n);
    quadO(m, i0[s], i0[s2], i1[s2], i1[s], -c, 0, -n);
    quadO(m, t0[s], t0[s2], t1[s2], t1[s], 0, 1, 0);
  }
  return m.build();
}
// a thread: small elongated dart pointing along +x
function meshDart() {
  const m = new Mesh();
  const a = m.v(0.5, 0, 0), b = m.v(-0.4, 0.2, 0), c = m.v(-0.4, -0.12, 0.2), d = m.v(-0.4, -0.12, -0.2);
  m.tri(a, b, c); m.tri(a, c, d); m.tri(a, d, b); m.tri(b, d, c);
  return m.build();
}
// H-tree clock distribution: trunk, then alternating x / z splits; aux = distance from the root (0..1)
function meshTree() {
  const m = new Mesh(); rseed(300);
  const TOT = 1.55;
  const seg = (p0, p1, r0, r1, d0, d1) => m.tube([p0, p1], (k) => (k ? r1 : r0), 5, false, (k) => (k ? d1 : d0) / TOT);
  const grow = (p, d, level) => {
    const len = [0.62, 0.36, 0.26, 0.18, 0.12][level], rad = [0.034, 0.026, 0.019, 0.014, 0.01][level];
    if (level === 0) { const e = [p[0], p[1] + len, p[2]]; seg(p, e, rad, rad * 0.8, d, d + len); grow(e, d + len, 1); return; }
    for (const sgn of [-1, 1]) {
      const ax = level % 2 ? [1, 0, 0] : [0, 0, 1];
      const e = [p[0] + ax[0] * sgn * len, p[1] + 0.07, p[2] + ax[2] * sgn * len];
      seg(p, e, rad, rad * 0.8, d, d + len);
      if (level < 4) grow(e, d + len, level + 1);
      else { const t = [e[0], e[1] + 0.05, e[2]]; seg(e, t, rad * 0.8, rad * 1.6, d + len, d + len + 0.03); }
    }
  };
  grow([0, 0, 0], 0, 0);
  return m.build();
}

// ---------------------------------------------------------------- instance stores
function makeWorld(D, T) {
  const smp = T.smp;
  const Dw = (x, y, z) => smp((x - OX) / VS, (y - OY) / VS, (z - OZ) / VS);
  const solidAt = (x, y, z) => Dw(x, y, z) > -0.7;
  const nCells = CELLS * CELLS;
  const cellOf = (x, z) => clamp(floor((x - OX) / CELLW), 0, CELLS - 1) + CELLS * clamp(floor((z - OZ) / CELLW), 0, CELLS - 1);
  const inst = STORES.map(() => Array.from({ length: nCells }, () => []));
  const wires = Array.from({ length: nCells }, () => []);
  const darts = [], pkts = [], heats = [], pois = [];
  let nth = 0;
  // block: store, position (base centre), yaw, size, material, colour, mode, seed
  const blk = (mesh, x, y, z, yaw, sx, sy, sz, mat, c, mode, seed) => inst[mesh][cellOf(x, z)].push(x, y, z, yaw, sx, sy, sz, mat, c[0], c[1], c[2], mode + seed * 0.99);
  const floorY = (x, z) => (max(abs(x), abs(z)) > 121 ? -1.6 : 0);
  const wire = (x, y0, z, h, col, spd, wd, force) => {
    if (!force && nth++ % THIN) return;
    if (solidAt(x, y0 + 0.6, z)) return;
    wires[cellOf(x, z)].push(x, y0, z, h, rnd(), col, spd * (rnd() < 0.7 ? 1 : -1), wd);
  };
  const pkt = (x, y, z, L, axis, speed, size, col, n) => { for (let i = 0; i < n; i++) pkts.push(x, y, z, L, axis, speed * rr(0.85, 1.15), size, col + (i / n + rr(0, 0.5 / n)) * 0.99); };
  const heat = (x, y, z, n, H = 14) => { for (let i = 0; i < n; i++) heats.push(x + rr(-1.5, 1.5), y, z + rr(-1.5, 1.5), rr(0.12, 0.34), rnd(), rr(1.2, 2.6), H * rr(0.6, 1.2), rr(0.08, 0.3)); };
  const poi = (id, x, z, r) => pois.push({ id, x, z, r });

  // --- GigaThread engine: rings pulsing upward
  rseed(1);
  for (let k = 0; k < 6; k++) blk(M_RING, 0, 3 + k * 4.2, 0, 0, 13.8, 0.45, 13.8, 1, PAL.xb, 6, k * 0.03);
  blk(M_SPH, 0, 36.2, 0, 0, 3, 3, 3, 1, PAL.wh, 5, 0.3);
  heat(0, 37, 0, 120, 16);
  poi('giga', 0, 0, 16);

  // --- the enlarged SM: four processing partitions around a shared L1 / shared-memory cross
  rseed(2);
  blk(M_BOX, SMX, 0, SMZ, 0, 52, 0.5, 52, 0, PAL.sm, 5, 0.5);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = SMX + sx * 14.5, pz = SMZ + sz * 14.5, L = (lx, lz) => [px + sx * lx, pz + sz * lz];
    blk(M_BOX, px, 0.5, pz, 0, 20, 0.3, 20, 0, PAL.xb, 0, rnd());
    // warp scheduler + dispatch: a spire with a beacon, next to the L0 instruction cache
    let [x, z] = L(-7.5, -7.5); blk(M_CONE, x, 0.8, z, 0, 3.2, 10, 3.2, 0, PAL.sm, 5, rnd()); blk(M_SPH, x, 10.4, z, 0, 1.7, 1.7, 1.7, 1, PAL.wh, 5, rnd());
    heat(x, 11, z, 24, 8);
    [x, z] = L(-7.5, -2.6); blk(M_BOX, x, 0.8, z, 0, 4, 0.9, 3, 1, PAL.hb, 5, rnd());
    // register file: 64 KB of pillars that hold values
    for (let a = 0; a < 9; a++) for (let b = 0; b < 5; b++) { [x, z] = L(-0.5 + a * 1.15, -9 + b * 1.15); blk(S_DET, x, 0.8, z, 0, 0.8, 3.4, 0.8, 2, PAL.l2, 1, rnd()); }
    // INT32 x16, FP32 x16, FP64 x8, LD/ST x8
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      [x, z] = L(-9.2 + a * 1.45, -1.8 + b * 1.45); blk(M_BOX, x, 0.8, z, 0, 1.05, 0.9, 1.05, 1, PAL.xb, 2, rnd());
      [x, z] = L(-3.4 + a * 1.45, -1.8 + b * 1.45); blk(M_BOX, x, 0.8, z, 0, 1.05, 0.9, 1.05, 1, PAL.sm, 2, rnd());
    }
    for (let a = 0; a < 2; a++) for (let b = 0; b < 4; b++) {
      [x, z] = L(2.6 + a * 1.8, -1.8 + b * 1.8); blk(M_BOX, x, 0.8, z, 0, 1.35, 1.2, 1.35, 1, PAL.hb, 2, rnd());
      [x, z] = L(7.2 + a * 1.5, -1.8 + b * 1.5); blk(M_BOX, x, 0.8, z, 0, 0.9, 0.5, 0.9, 1, PAL.xb, 2, rnd());
    }
    // tensor core: a 3x3x3 MAC lattice
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let k = 0; k < 3; k++) {
      [x, z] = L(-2.1 + a * 2.1, 4.3 + b * 2.1); blk(M_BOX, x, 1.2 + k * 2.1, z, 0, 1.45, 1.45, 1.45, 3, PAL.ph, 3, (a + b + k) / 16);
    }
    [x, z] = L(0, 6.4); heat(x, 8, z, 60, 12);
    for (let i = 0; i < 6; i++) { [x, z] = L(rr(-8, 8), rr(-9, 9)); wire(x, 0.8, z, rr(8, 36), 2, rr(0.6, 1.4), rr(0.05, 0.09), true); }
    for (let i = 0; i < 6; i++) { [x, z] = L(rr(-3, 3), rr(3, 9)); wire(x, 0.8, z, rr(8, 40), 4, rr(0.6, 1.6), rr(0.05, 0.1), true); }
    for (const [id, lx, lz, r] of [['sched', -7.5, -7.5, 6], ['rf', 4, -6.5, 7], ['int32', -7, 0.6, 5], ['fp32', -1.2, 0.6, 5], ['fp64', 3.5, 1, 4], ['tensor', 0, 6.4, 6]]) { const q = L(lx, lz); poi(id, q[0], q[1], r); }
  }
  // shared L1 / shared memory: layered cross-shaped slabs
  for (let k = 0; k < 5; k++) {
    blk(M_BOX, SMX, 0.5 + k * 0.75, SMZ, 0, 5.4 - k * 0.5, 0.42, 44, 1, PAL.hb, 5, k * 0.2);
    blk(M_BOX, SMX, 0.96 + k * 0.75, SMZ, 0, 44, 0.28, 5.4 - k * 0.5, 1, PAL.hb, 5, 0.1 + k * 0.2);
  }
  poi('l1', SMX, SMZ, 7); poi('sm', SMX, SMZ, 38);

  // --- the tensor core atrium: a 4x4x4 MAC lattice with operand walls
  rseed(3);
  blk(M_BOX, TCX, 0, TCZ, 0, 52, 0.5, 52, 0, PAL.ph, 5, 0.2);
  const TP = 6.2, TY = 4.5, tx0 = TCX - 1.5 * TP, tz0 = TCZ - 1.5 * TP;
  for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let k = 0; k < 4; k++) {
    const x = tx0 + a * TP, z = tz0 + b * TP, y = TY + k * TP;
    blk(M_BOX, x, y, z, 0, 3.4, 3.4, 3.4, 3, PAL.ph, 3, (a + b + k) / 16);
    if (a < 3) blk(M_BOX, x + TP / 2, y + 1.52, z, 0, 2.8, 0.36, 0.36, 7, PAL.xb, 0, rnd());
    if (b < 3) blk(M_BOX, x, y + 1.52, z + TP / 2, 0, 0.36, 0.36, 2.8, 7, PAL.sm, 0, rnd());
    if (k < 3) blk(M_BOX, x, y + 3.4 + 0.04, z, 0, 0.36, 2.72, 0.36, 7, PAL.hb, 0, rnd());
  }
  const tx1 = tx0 + 3 * TP, tz1 = tz0 + 3 * TP;
  for (let b = 0; b < 4; b++) for (let k = 0; k < 4; k++) {
    blk(M_BOX, tx0 - 10, TY + k * TP, tz0 + b * TP, 0, 0.9, 3.4, 3.4, 1, PAL.xb, 2, rnd());   // operand A
    blk(M_BOX, tx1 + 10, TY + k * TP, tz0 + b * TP, 0, 0.9, 3.4, 3.4, 1, PAL.hb, 5, rnd());   // result D
    blk(M_BOX, tx0 + b * TP, TY + k * TP, tz1 + 10, 0, 3.4, 3.4, 0.9, 1, PAL.sm, 2, rnd());   // operand B
    pkt(tx0 - 9, TY + k * TP + 1.7, tz0 + b * TP, tx1 - tx0 + 18, 0, 5, 0.5, 0, 2);
    pkt(tx0 + b * TP, TY + k * TP + 1.7, tz1 + 9, tz1 - tz0 + 18, 3, 5, 0.5, 1, 2);
  }
  heat(TCX, 3, TCZ, 260, 26);
  poi('tc', TCX, TCZ, 30);

  // --- L2: a forest of SRAM bit pillars, banks separated by aisles, two partitions split at x = 0
  rseed(4);
  const st = LV ? 0.62 * sqrt(THIN) : 0.62;
  for (const sgn of [-1, 1]) for (let x = -111; x < 111; x += st) {
    if (abs(x) < 2.2 || (x + 111) % 14 > 12.4) continue;
    for (let z = 17.4; z < 50.2; z += st) {
      if ((z - 17.4) % 11 > 9.4) continue;
      blk(S_DET, x + rr(-0.03, 0.03), 0, sgn * z, 0, 0.42, 2.6, 0.42, 2, rnd() < 0.05 ? PAL.xb : PAL.l2, 1, rnd());
    }
  }
  for (const p of [[-56, -33], [56, -33], [-56, 33], [56, 33]]) blk(M_TREE, p[0], 0, p[1], 0, 20, 20, 20, 6, PAL.ph, 0, rnd());

  // --- crossbar canyon: decoupling capacitors along the walls, floating cache lines overhead
  rseed(5);
  for (let x = -108; x <= 108; x += 3.4) for (const s of [-1, 1]) { if (nth++ % (THIN > 2 ? 2 : 1) === 0) blk(M_CYL, x, 0, s * 12.4, 0, 1.3, 1.9, 1.3, 4, PAL.hb, 5, rnd()); }
  for (let i = 0; i < 160; i++) {
    const x = rr(-110, 110), z = rr(-12, 12), c = rnd();
    blk(M_BOX, x, rr(3.5, 14), z, 0, 1.3, 1.3, 1.3, 5, c < 0.5 ? PAL.xb : c < 0.8 ? PAL.sm : PAL.ph, 4, rnd());
  }
  for (let i = 0; i < 90; i++) blk(M_BOX, rr(-110, 110), rr(3, 10), rr(18, 49) * (rnd() < 0.5 ? -1 : 1), 0, 1.2, 1.2, 1.2, 5, PAL.l2, 4, rnd());

  // --- clock trees over the GPC centres
  for (const [cx, cz, i] of GPCS) if (i !== 1 && i !== 5) blk(M_TREE, cx, 0, cz, 0, 20, 20, 20, 6, PAL.ph, 0, rnd());
  for (const [cx, cz, i] of GPCS) if (i !== 1 && i !== 5) poi('gpc', cx, cz, 30);

  // --- HBM stacks: through-silicon vias glow on the face turned to the die; the sixth stack is fused off
  rseed(6);
  for (const sx of [-1, 1]) for (const cz of [-80, 0, 80]) {
    const dead = sx > 0 && cz > 40;
    for (let i = 0; i < (dead ? 6 : 40); i++) wire(sx * 132.35, 1, cz + rr(-20, 20), rr(30, 38), 3, rr(0.6, 1.6), rr(0.07, 0.12), true);
    if (!dead) heat(sx * 150, 41, cz, 60, 12);
    for (let i = 0; i < 4; i++) pkt(sx * 119, 0.9 + i * 0.7, cz - 7 + i * 4.5, 14, sx > 0 ? 0 : 1, 7, 0.4, 3, 2);
    poi(dead ? 'hbmx' : 'hbm', sx * 150, cz, 52);
  }

  // --- NVLink rings (SDF) with traffic through them, PCIe lanes at the north edge
  for (let i = 0; i < 12; i++) pkt(-66 + i * 12, 7.2 + rr(-1.5, 1.5), 124, 46, 2, 9, 0.6, 0, 3);
  poi('nvlink', 0, 146, 42);
  for (let i = 0; i < 16; i++) {
    const x = -24 + i * 3.2;
    blk(M_BOX, x, -1.6, -146, 0, 2.2, 0.5, 40, 4, PAL.hb, 5, rnd());
    pkt(x, -0.6, -170, 50, 2, 7, 0.45, i % 2 ? 5 : 0, 2);
  }
  poi('pcie', 0, -146, 36);

  // --- buses: crossbar lanes, N-S avenues between the GPC columns
  rseed(7);
  for (let i = 0; i < 12; i++) { const z = -10 + i * 1.8; pkt(-112, 1 + (i % 3) * 1.3, z, 224, i % 2 ? 0 : 1, rr(7, 14), 0.5, i % 4 === 3 ? 4 : i % 2 ? 0 : 1, 3); }
  for (const ax of [-60, 0, 60]) for (let i = 0; i < 4; i++) pkt(ax - 1.6 + i * 1.07, 0.9, i % 2 ? 114 : -114, 228, i % 2 ? 3 : 2, rr(6, 11), 0.42, i % 2 ? 0 : 1, 3);
  for (let i = 0; i < 4; i++) { pkt(SMX + (i - 1.5) * 1.3, 1.2, SMZ - 23, 46, 2, 6, 0.4, 3, 2); pkt(SMX - 23, 1.2, SMZ + (i - 1.5) * 1.3, 46, 0, 6, 0.4, 3, 2); }

  // --- signal wires: the forest. L2, canyon, GPC streets, interposer, power rails from the lid
  rseed(8);
  const rail = (x, z, col, lo, hi, spd) => { const y0 = floorY(x, z); const h = rnd() < 0.4 ? CEIL - y0 : rr(lo, hi); wire(x, y0, z, h, col, spd, rr(0.05, 0.11)); };
  for (let i = 0; i < 16000; i++) { const x = rr(-110, 110); if (abs(x) < 2) continue; rail(x, rr(17, 50) * (rnd() < 0.5 ? -1 : 1), rnd() < 0.7 ? 2 : 1, 10, 50, rr(0.5, 1.4)); }
  for (let i = 0; i < 3500; i++) rail(rr(-112, 112), rr(-13, 13), rnd() < 0.8 ? 1 : 5, 8, 50, rr(0.6, 1.6));
  for (let i = 0; i < 5000; i++) { const g = GPCS[(rnd() * 8) | 0]; rail(g[0] + rr(-27, 27), g[1] + rr(-27, 27), g[2] === 1 ? 2 : 0, 6, 30, rr(0.5, 1.4)); }
  for (let i = 0; i < 2000; i++) rail(pick([-60, 0, 60]) + rr(-2.6, 2.6), rr(-112, 112), 0, 6, 26, rr(0.5, 1.2));
  for (let i = 0; i < 1500; i++) { const a = rr(122, 172) * (rnd() < 0.5 ? -1 : 1), b = rr(-172, 172); const x = rnd() < 0.5 ? a : b, z = x === a ? b : a; rail(x, z, 3, 3, 14, rr(0.5, 1)); }
  for (let i = 0; i < 1400; i++) rail(TCX + rr(-26, 26), TCZ + rr(-26, 26), rnd() < 0.7 ? 4 : 5, 6, 44, rr(0.6, 1.6));
  for (let i = 0; i < 900; i++) { const x = rr(-116, 116), z = rr(-116, 116), y0 = 0; wire(x, y0, z, CEIL - y0, 5, -rr(0.4, 0.9), rr(0.07, 0.13)); }

  // --- warps: 32 threads each, in lockstep
  rseed(9);
  const warp = (cx, cy, cz, R, spd, size) => { const ws = rnd() * 0.97; for (let t = 0; t < 32; t++) darts.push(cx, cy, cz, R, ws, spd, size, t); };
  for (let i = 0; i < 4; i++) warp(SMX, 11 + i * 2, SMZ, 12 + i * 5, (i % 2 ? -1 : 1) * rr(0.25, 0.4), 0.3);
  for (let i = 0; i < 3; i++) warp(TCX, 16 + i * 4, TCZ, 17 + i * 5, (i % 2 ? -1 : 1) * rr(0.25, 0.4), 0.32);
  for (let i = 0; i < 6; i++) warp(-90 + i * 36, 6.5, 0, 14, (i % 2 ? -1 : 1) * rr(0.3, 0.5), 0.34);
  for (const [cx, cz, i] of GPCS) if (i !== 1 && i !== 5) warp(cx, 15, cz, rr(14, 20), (i % 2 ? -1 : 1) * rr(0.25, 0.4), 0.32);
  for (const p of [[-55, -33], [55, -33], [-55, 33], [55, 33]]) warp(p[0], 6, p[1], 20, rr(0.25, 0.4), 0.3);
  warp(-30, 9, 146, 16, 0.35, 0.34); warp(30, 9, 146, 16, -0.35, 0.34);

  // ================================================================ details
  const RED = [1, 0.12, 0.08], DARK = [0.08, 0.09, 0.1];
  // --- SM tower rooftops: same hash as towerAt() in the WGSL, so dark towers get dark roofs
  rseed(20);
  for (const [cx, cz, gi] of GPCS) if (gi !== 1 && gi !== 5) for (let iz = 0; iz < 4; iz++) for (let ix = 0; ix < 4; ix++) {
    const k = gi * 16 + ix + 4 * iz, H = 4.6 + 4.4 * hf(k), on = hf(k + 977) > 0.16;
    const x = cx + (ix + 0.5) * 13 - 26, z = cz + (iz + 0.5) * 13 - 26, T2 = H + 2.4;
    // the ledge around the upper tier: a ring of execution units
    for (let sd = 0; sd < 4; sd++) for (let j = -3; j <= 3; j++) {
      const a = j * 0.95, r = 3.35, q = [[r, a], [-r, a], [a, r], [a, -r]][sd];
      blk(S_DET, x + q[0], H - 0.05, z + q[1], 0, 0.55, 0.38, 0.55, on ? 1 : 0, on ? (j % 3 ? PAL.sm : PAL.xb) : DARK, on ? 2 : 0, rnd());
    }
    // the roof: heat-sink fins, a status beacon (red on fused-off SMs), an antenna
    for (let f = -2; f <= 2; f++) blk(S_DET, x, T2 - 0.05, z + f * 0.62, 0, 3, 0.5, 0.12, 4, PAL.hb, 0, rnd());
    blk(S_SPH, x + 1.6, T2, z + 1.6, 0, 0.7, 0.7, 0.7, 1, on ? PAL.wh : RED, on ? 5 : 2, rnd());
    blk(S_DET, x - 1.7, T2 - 0.05, z - 1.7, 0, 0.12, 2.2, 0.12, 1, on ? PAL.sm : DARK, on ? 6 : 0, rnd());
  }

  // --- GigaThread: dispatch spokes on the base, a crown of lamps, thread blocks orbiting out towards the SMs
  rseed(21);
  for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; blk(S_BOX, cos(a) * 11, 0, sin(a) * 11, -a, 4, 0.22, 0.35, 7, PAL.xb, 0, rnd()); }
  for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; blk(S_SPH, cos(a) * 6.3, 27.5, sin(a) * 6.3, 0, 0.8, 0.8, 0.8, 1, PAL.xb, 6, i / 8); }
  for (let i = 0; i < 44; i++) { const a = rnd() * TAU, r = rr(8.6, 12), c = rnd(); blk(S_ORB, cos(a) * r, rr(3.5, 30), sin(a) * r, rnd() * TAU, 1, 1, 1, 5, c < 0.6 ? PAL.sm : c < 0.85 ? PAL.xb : PAL.wh, 7, rnd()); }

  // --- crossbar canyon: copper conduits on the wall tops, lit window jambs, lamps along the arches, cable trays
  rseed(22);
  for (let k = 0; k < 16; k++) for (const zz of [14.2, 15.4]) for (const sg of [-1, 1]) blk(S_PIPE, -105 + k * 14, 7, sg * zz, 0, 14, 0.9, 0.9, 4, zz < 15 ? PAL.xb : PAL.hb, 5, rnd());
  for (const wx of [-98, -70, -42, -14, 14, 42, 70, 98]) for (const j of [-4.6, 4.6]) for (const sg of [-1, 1]) blk(S_BOX, wx + j, 0, sg * 14.8, 0, 0.35, 7.2, 2.1, 1, PAL.xb, 5, rnd());
  for (const ax of [-84, -28, 28, 84]) for (const th of [-1.05, -0.52, 0, 0.52, 1.05]) blk(S_SPH, ax, 15.1 * cos(th) - 0.35, 15.1 * sin(th), 0, 0.7, 0.7, 0.7, 1, PAL.xb, 6, th * 0.1 + 0.2);
  for (let k = 0; k < 16; k++) for (const sg of [-1, 1]) blk(S_BOX, -105 + k * 14, 0, sg * 10.6, 0, 13.6, 0.18, 1.1, 0, PAL.xb, 0, rnd());

  // --- L2: bank controllers at the aisle crossings, sense-amplifier strips along each bank, tag arrays on the ridge
  rseed(23);
  for (const sg of [-1, 1]) for (let i = 0; i < 16; i++) {
    const x0 = -111 + i * 14;
    for (let j = 0; j < 3; j++) {
      const z0 = 17.4 + j * 11;
      if (abs(x0 + 13.2) > 2.5 && j < 2) blk(S_BOX, x0 + 13.2, 0, sg * (z0 + 10.2), 0, 1, 1.7, 1, 1, PAL.xb, 2, rnd());
      blk(S_DET, x0 + 6.2, 0, sg * (z0 - 0.4), 0, 12.4, 0.14, 0.3, 1, PAL.l2, 5, rnd());
    }
  }
  for (const sg of [-1, 1]) for (let z = 18.5; z < 50; z += 4) blk(S_BOX, 0, 2.6, sg * z, 0, 1.6, 0.7, 2.6, 1, PAL.xb, 2, rnd());

  // --- the enlarged SM: partition rails, texture units, dispatch buses, register-file bed
  rseed(24);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const px = SMX + sx * 14.5, pz = SMZ + sz * 14.5, L = (lx, lz) => [px + sx * lx, pz + sz * lz];
    for (const e of [-10, 10]) { blk(S_BOX, px + e, 0.8, pz, 0, 0.18, 0.12, 20, 1, PAL.sm, 5, rnd()); blk(S_BOX, px, 0.8, pz + e, 0, 20, 0.12, 0.18, 1, PAL.sm, 5, rnd()); }
    let [x, z] = L(-7.5, -1.2); blk(S_BOX, x, 0.82, z, 0, 0.22, 0.18, 8.8, 7, PAL.sm, 0, rnd());
    [x, z] = L(0, -2.9); blk(S_BOX, x, 0.82, z, 0, 19, 0.18, 0.22, 7, PAL.sm, 0, rnd());
    [x, z] = L(4.1, -6.7); blk(S_BOX, x, 0.78, z, 0, 11, 0.1, 6.5, 0, PAL.l2, 0, rnd());
    blk(S_CYL, SMX + sx * 3.6, 0.5, SMZ + sz * 3.6, 0, 1.4, 1.8, 1.4, 1, PAL.xb, 2, rnd());
  }

  // --- tensor atrium: a cage outlining the lattice
  rseed(25);
  {
    const a0 = tx0 - 2.3, a1 = tx1 + 2.3, b0 = tz0 - 2.3, b1 = tz1 + 2.3, y0 = TY - 0.6, y1 = TY + 3 * TP + 3.4 + 0.6, mx = (a0 + a1) / 2, mz = (b0 + b1) / 2;
    for (const x of [a0, a1]) for (const z of [b0, b1]) blk(S_BOX, x, y0, z, 0, 0.3, y1 - y0, 0.3, 7, PAL.wh, 0, rnd());
    for (const y of [y0, y1]) { for (const z of [b0, b1]) blk(S_BOX, mx, y, z, 0, a1 - a0, 0.3, 0.3, 7, PAL.wh, 0, rnd()); for (const x of [a0, a1]) blk(S_BOX, x, y, mz, 0, 0.3, 0.3, b1 - b0, 7, PAL.wh, 0, rnd()); }
  }

  // --- HBM: heat-spreader caps, micro-bump rows in the gap under each stack, status lamps, PHYs at the die edge
  rseed(26);
  for (const sx of [-1, 1]) for (const cz of [-80, 0, 80]) {
    const dead = sx > 0 && cz > 40, cx = sx * 150;
    blk(S_BOX, cx, 39.9, cz, 0, 36.5, 0.7, 46.5, 4, PAL.hb, 5, rnd());
    for (let x = -16.5; x <= 16.5; x += 1.4) for (const z of [-22.4, -21, 21, 22.4]) blk(S_BUMP, cx + x, -1.6, cz + z, 0, 0.5, 1.62, 0.5, 1, dead ? DARK : PAL.hb, dead ? 0 : 2, rnd());
    for (let z = -19.6; z <= 19.6; z += 1.4) for (const x of [-16.6, -15.2, 15.2, 16.6]) blk(S_BUMP, cx + x, -1.6, cz + z, 0, 0.5, 1.62, 0.5, 1, dead ? DARK : PAL.hb, dead ? 0 : 2, rnd());
    if (!dead) for (let z = -9.8; z <= 9.8; z += 2.8) blk(S_SPH, sx * 132.2, 37, cz + z, 0, 0.6, 0.6, 0.6, 1, PAL.hb, 2, rnd());
    blk(S_BOX, sx * 124.5, -1.6, cz, 0, 3, 1.1, 18, 1, dead ? DARK : PAL.hb, dead ? 0 : 2, rnd());
  }

  // --- NVLink: pedestals under the rings, SerDes PHYs along the south die edge; PCIe PHYs on the north edge
  rseed(27);
  for (let i = 0; i < 12; i++) {
    const x = -66 + i * 12;
    blk(S_BOX, x, -1.6, 146, 0, 2.6, 1.85, 2.6, 0, PAL.xb, 5, rnd());
    blk(S_BOX, x, 0, 114.2, 0, 8, 1.3, 3.2, 1, PAL.xb, 2, rnd());
  }
  for (let i = 0; i < 4; i++) blk(S_BOX, -18 + i * 12, 0, -114.2, 0, 8, 1.3, 3.2, 1, PAL.hb, 2, rnd());

  // --- electrons
  const electrons = new Float32Array(9000 * 4); for (let i = 0; i < electrons.length; i++) electrons[i] = rnd();

  // --- pack
  const packC = (L) => {
    let n = 0; const start = new Uint32Array(nCells + 1);
    for (let c = 0; c < nCells; c++) { start[c] = n; n += L[c].length / 12; }
    start[nCells] = n;
    const data = new Float32Array(n * 12), lo = new Float32Array(nCells).fill(1e9), hi = new Float32Array(nCells).fill(-1e9);
    let k = 0;
    for (let c = 0; c < nCells; c++) { const a = L[c]; for (let i = 0; i < a.length; i += 12) { for (let j = 0; j < 12; j++) data[k++] = a[i + j]; lo[c] = min(lo[c], a[i + 1] - 1.5); hi[c] = max(hi[c], a[i + 1] + max(a[i + 5], a[i + 4]) + 3.5); } }
    return { data, n, start, lo, hi };
  };
  const packW = (L) => {
    let n = 0; const start = new Uint32Array(nCells + 1);
    for (let c = 0; c < nCells; c++) { start[c] = n; n += L[c].length / 8; }
    start[nCells] = n;
    const data = new Float32Array(n * 8), lo = new Float32Array(nCells).fill(1e9), hi = new Float32Array(nCells).fill(-1e9);
    let k = 0;
    for (let c = 0; c < nCells; c++) { const a = L[c]; for (let i = 0; i < a.length; i += 8) { for (let j = 0; j < 8; j++) data[k++] = a[i + j]; lo[c] = min(lo[c], a[i + 1]); hi[c] = max(hi[c], a[i + 1] + a[i + 3]); } }
    return { data, n, start, lo, hi };
  };
  return { inst: inst.map(packC), wires: packW(wires), darts: new Float32Array(darts), pkts: new Float32Array(pkts), heats: new Float32Array(heats), electrons, pois };
}
const pick = (a) => a[(rnd() * a.length) | 0];
