// ============================================================================
// renderer, camera, clock and input
// ============================================================================
const $ = (id) => document.getElementById(id);
const canvas = $('c'), info = $('i'), body = document.body;
// a phone held upright gets the page turned on its side (see template.html)
const rot = matchMedia('(orientation:portrait) and (pointer:coarse)');
// loading bar: each stage glides it to `to` (the share done) over ~`ms` on the compositor, so it moves while this thread is busy
let loaded = 0, dead; // dead: the graphics device was lost
const say = (m, to, ms) => {
  if (!dead) $('s').textContent = m;
  const a = $('b').animate({ transform: [`scaleX(${loaded})`, `scaleX(${to})`] }, { duration: ms, fill: 'forwards', easing: 'cubic-bezier(.3,.5,.5,1)' });
  loaded = to;
  return new Promise((r) => { a.ready.then(() => setTimeout(r)); setTimeout(r, document.hidden ? 0 : 1e3); });
};
const fail = (m) => { throw new Error(m, { cause: 1 }); };
if (!navigator.gpu) fail('This scene needs WebGPU. Try a current Chrome or Edge.');
const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
if (!adapter) fail('No WebGPU adapter found.');
$('w').hidden = !!navigator.userAgentData;
const hasTS = adapter.features.has('timestamp-query');
const device = await adapter.requestDevice({ requiredFeatures: hasTS ? ['timestamp-query'] : [], requiredLimits: { maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1 << 28), maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 28) } });
device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message));
device.lost.then((l) => {
  if (l.reason === 'destroyed') return;
  if (LV < 2) { keep('a100', LV + 1); location.reload(); }
  dead = body.className = 'l e'; $('s').textContent = 'The graphics device was lost. Reload the page to try again.';
});
const ctx = canvas.getContext('webgpu'), FMT = navigator.gpu.getPreferredCanvasFormat();
const Q = device.queue, HDR = 'rgba16float', DEPTH = 'depth32float';
const TU = GPUTextureUsage, BU = GPUBufferUsage, SS = GPUShaderStage;

// shader modules: compile errors are printed with the offending line
const mod = (code, name) => {
  const m = device.createShaderModule({ code });
  m.getCompilationInfo().then((ci) => { for (const x of ci.messages) if (x.type === 'error') console.error(`WGSL ${name}:${x.lineNum}: ${x.message}\n  ${code.split('\n')[x.lineNum - 1] || ''}`); });
  return m;
};
const buf = (data, usage) => { const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | BU.COPY_DST }); Q.writeBuffer(b, 0, data.buffer || data, data.byteOffset || 0, data.byteLength); return b; };
const tex = (w, h, format, usage, o = {}) => device.createTexture({ size: [w, h, 1], format, usage, mipLevelCount: 1, sampleCount: o.samples || 1 });

// ---------------------------------------------------------------- static resources
const sClamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const UB = new Float32Array(44); // see struct G in shaders.js
const ubo = device.createBuffer({ size: 176, usage: BU.UNIFORM | BU.COPY_DST });
const VF = SS.VERTEX | SS.FRAGMENT;
const bgl0 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: {} }] });
const bg0 = device.createBindGroup({ layout: bgl0, entries: [{ binding: 0, resource: { buffer: ubo } }] });
const pl0 = device.createPipelineLayout({ bindGroupLayouts: [bgl0] });

const bglBlit = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: {} }, { binding: 1, visibility: SS.FRAGMENT, sampler: {} }] });
const plBlit = device.createPipelineLayout({ bindGroupLayouts: [bglBlit] });
const mBlit = mod(W_BLIT, 'blit');
const blitPipe = (entry, format, add) => device.createRenderPipeline({ layout: plBlit, vertex: { module: mBlit, entryPoint: 'vs' },
  fragment: { module: mBlit, entryPoint: entry, targets: [{ format, blend: add ? { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } : undefined }] } });
const pDown0 = blitPipe('fsDown0', HDR), pDown = blitPipe('fsDown', HDR), pUp = blitPipe('fsUp', HDR, true);
const blitBG = (view) => device.createBindGroup({ layout: bglBlit, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sClamp }] });
const colorAtt = (view, clear) => ({ view, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] });

// vertex layouts
const A = (shaderLocation, offset, format) => ({ shaderLocation, offset, format });
const vbSolid = { arrayStride: 16, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4')] };
const ibBlk = { arrayStride: 48, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4'), A(4, 32, 'float32x4')] };
const ibAnim = { arrayStride: 32, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4')] };
const ibWire = { arrayStride: 32, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4')] };
const ibEl = { arrayStride: 16, stepMode: 'instance', attributes: [A(0, 0, 'float32x4')] };

const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
const scenePipe = (m, vsE, fsE, buffers, o = {}) => device.createRenderPipeline({ layout: pl0,
  vertex: { module: m, entryPoint: vsE, buffers },
  fragment: { module: m, entryPoint: fsE, targets: [{ format: HDR, blend: o.blend }] },
  primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: !o.blend, depthCompare: 'greater' }, multisample: { count: AA } });

await say('Compiling shaders…', 0.05, 300);
const mTerr = mod(W_TERR, 'terrain'), mBlk = mod(W_BLK, 'blocks'), mWire = mod(W_WIRE, 'wires'), mDart = mod(W_DART, 'warps'), mPkt = mod(W_PKT, 'packets'), mCeil = mod(W_CEIL, 'lid'), mSpr = mod(W_SPR, 'sprites');
const pTerr = scenePipe(mTerr, 'vs', 'fs', [vbSolid], { cull: 'back' });
const pBlk = scenePipe(mBlk, 'vs', 'fs', [vbSolid, ibBlk], { cull: 'back' });
const pDart = scenePipe(mDart, 'vs', 'fs', [vbSolid, ibAnim]);
const pPkt = scenePipe(mPkt, 'vs', 'fs', [vbSolid, ibAnim], { cull: 'back' });
const pCeil = scenePipe(mCeil, 'vs', 'fs', [], { strip: true });
const pWire = scenePipe(mWire, 'vs', 'fs', [ibWire], { strip: true, blend: ADD });
const pHeat = scenePipe(mSpr, 'vsHeat', 'fsHeat', [ibWire], { strip: true, blend: ADD });
const pEl = scenePipe(mSpr, 'vsEl', 'fsEl', [ibEl], { strip: true, blend: ADD });

const mRays = mod(W_RAYS, 'rays'), mPost = mod(W_POST, 'post'), mRB = mod(W_RBLUR, 'rblur');
const fsPipe = (m, format) => device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format }] } });
const pRB = fsPipe(mRB, HDR), pRays = fsPipe(mRays, HDR), pPost = fsPipe(mPost, FMT);

// ---------------------------------------------------------------- world generation
await say('Etching the die…', 0.25, 1200);
keep('a100Load', 1); // marks a load in progress (quality.js); leaving the page before it ends is not a crash
addEventListener('pagehide', () => keep('a100Load', ''));
let D;
{
  const m = mod(W_DENS, 'density'), p = device.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
  const size = NX * NY * NZ * 4;
  const u = new ArrayBuffer(32), uu = new Uint32Array(u), uf = new Float32Array(u);
  uu[0] = NX; uu[1] = NY; uu[2] = NZ; uf[4] = OX; uf[5] = OY; uf[6] = OZ; uf[7] = VS;
  const bu = buf(new Uint8Array(u), BU.UNIFORM);
  const bd = device.createBuffer({ size, usage: BU.STORAGE | BU.COPY_SRC }), br = device.createBuffer({ size, usage: BU.MAP_READ | BU.COPY_DST });
  const bg = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: bu } }, { binding: 1, resource: { buffer: bd } }] });
  const e = device.createCommandEncoder(), c = e.beginComputePass();
  c.setPipeline(p); c.setBindGroup(0, bg); c.dispatchWorkgroups(NX / 4, NY / 4, NZ / 4); c.end();
  e.copyBufferToBuffer(bd, 0, br, 0, size);
  Q.submit([e.finish()]);
  await br.mapAsync(GPUMapMode.READ);
  D = new Float32Array(br.getMappedRange().slice(0));
  br.unmap(); br.destroy(); bd.destroy();
}
// Distance to the solid for collide(), in 1/127 m (> 0 inside, clamped to +-1 m), kept only in the 4x4x4-voxel bricks near
// the surface within the camera's reach. CI per brick: 0 all air, 1 all solid, n: brick n-2 in CG.
const CO = 32, CN = 96, CI = new Uint16Array(CN * CN * NY / 4);
let CG = new Int8Array(64 * 65534);
{
  let n = 0;
  for (let bz = 0; bz < CN; bz++) for (let by = 1; by < NY / 4 - 1; by++) for (let bx = 0; bx < CN; bx++) {
    let lo = 127, hi = -127;
    for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const i = CO + bx * 4 + x + NX * (by * 4 + y + NY * (CO + bz * 4 + z)), gz = D[i + NX * NY] - D[i - NX * NY];
      const gx = D[i + 1] - D[i - 1], g = D[i + NX] - D[i - NX], l = sqrt(gx * gx + g * g + gz * gz) / 1.8;
      const q = round(clamp(D[i] / max(l, 0.05), -1, 1) * 127);
      CG[n * 64 + x + 4 * y + 16 * z] = q; if (q < lo) lo = q; if (q > hi) hi = q;
    }
    CI[bx + CN * (by + NY / 4 * bz)] = lo === hi && lo * lo === 16129 ? +(lo > 0) : (n++, n + 1);
  }
  CG = CG.slice(0, n * 64);
  if (n > 65000) console.warn('collision bricks: ' + n + ' (limit 65534)');
}
await say('Routing the metal layers…', 0.32, 400);
const T = buildTerrain(D);

// preset viewpoints (position, look-at), keys 1-6
const POSES = [
  [-62, 9, 8, -10, 13, -2],
  [-30, 17, -48, -30, 4, -84],
  [-30, 13, 61, -30, 13, 84],
  [46, 3.2, -30, 12, 8, -28],
  [118, 15, 38, 150, 16, 2],
  [-40, 7, 126, 0, 7.5, 150],
];
const POSE_NAMES = ['Crossbar', 'Streaming Multiprocessor', 'Tensor Core', 'L2 Cache', 'HBM2e Memory', 'NVLink'];
// per-frame float state lives in one preallocated array, so the frame loop allocates no heap numbers
const F = new Float64Array(32), P6 = new Float64Array(6);
const CX = 0, CY = 1, CZ = 2, YAW = 3, PIT = 4, FX = 5, FY = 6, FZ = 7, RX = 8, RZ = 9, UX = 10, UY = 11, UZ = 12, VX = 13, VY = 14, VZ = 15, TIME = 16, LAST = 18, GPU = 19, HUDT = 20, MX = 22, MY = 23, MZ = 24, CLK = 25, FREQ = 26, FRZ = 27, CTG = 28, DIV = 29, POIT = 30;
F[FREQ] = 1.2;
function aim() {
  const dx = P6[3] - P6[0], dy = P6[4] - P6[1], dz = P6[5] - P6[2];
  F[CX] = P6[0]; F[CY] = P6[1]; F[CZ] = P6[2];
  F[YAW] = atan2(dx, -dz); F[PIT] = atan2(dy, sqrt(dx * dx + dz * dz));
}
const lookAt = (x, y, z, tx, ty, tz) => { P6[0] = x; P6[1] = y; P6[2] = z; P6[3] = tx; P6[4] = ty; P6[5] = tz; aim(); F[VX] = F[VY] = F[VZ] = 0; };

await say('Wiring the chip…', 0.7, 2500);
const W = makeWorld(D, T);
D = T.smp = null;

await say('Building the GPU blocks…', 0.94, 1200);
// mesh ids: see M_* in world.js
const meshes = [meshBox(), meshCyl(14, 0.5), meshCyl(14, 0), meshSphere(), meshTree(), meshRing(), meshDart(), meshCyl(12, 0.5, true)];
let nV = 0, nI = 0;
for (const m of meshes) { m.v0 = nV; m.i0 = nI; nV += m.nv; nI += m.ib.length; }
const allV = new Uint8Array(nV * 16), allI = new Uint32Array(nI);
for (const m of meshes) { allV.set(new Uint8Array(m.vb), m.v0 * 16); allI.set(m.ib, m.i0); }
const vbMesh = buf(allV, BU.VERTEX), ibMesh = buf(allI, BU.INDEX);
const vbTerrain = buf(new Uint8Array(T.vb), BU.VERTEX), ibTerrain = buf(T.ib, BU.INDEX);
const ibInst = W.inst.map((c) => buf(c.n ? c.data : new Float32Array(12), BU.VERTEX));
const ibWires = buf(W.wires.n ? W.wires.data : new Float32Array(8), BU.VERTEX);
const ibDarts = buf(W.darts, BU.VERTEX), ibPkts = buf(W.pkts, BU.VERTEX), ibHeats = buf(W.heats, BU.VERTEX), ibEls = buf(W.electrons, BU.VERTEX);
const nDart = W.darts.length / 8, nPkt = W.pkts.length / 8, nHeat = W.heats.length / 8, nEl = W.electrons.length / 4;
const DART = meshes[M_DART], BOX = meshes[M_BOX];
// the GPU has its own copies now: let go of the generator's
for (const o of [...W.inst, W.wires]) o.data = 0;
T.vb = T.ib = T.wp = 0;

// ---------------------------------------------------------------- render targets (rebuilt on resize)
// The scene is drawn at `pix` pixels and scaled up to the window. frame() tunes it and the draw distance scale `det`
// for 60 fps; both start where the last visit left them.
const PIXMAX = 2560 * 1440, PIXMIN = mob ? 25e4 : 5e5, DETMIN = 0.4;
let Wd = 0, Ht = 0, DW = 0, DH = 0, pix = +SV[1] || (LV > 1 ? 41e4 : mob ? 1280 * 720 : 1920 * 1080), det = +SV[2] || 1, dynN = 0, dynT = 0, dynG = 0, dynGN = 0, dynBad = 0, dynOk = 0, dynWait = 3;
let passScene, passRays, passBlur, bgBlur, passPost, bgRays, bgPost, bloomPass = [], bloomBG = [], targets = [];
const NB = 6;
function resize() {
  DW = max(2, round(canvas.clientWidth * devicePixelRatio)); DH = max(2, round(canvas.clientHeight * devicePixelRatio));
  const s = min(1, sqrt(pix / (DW * DH)));
  const w = max(2, round(DW * s) & ~1), h = max(2, round(DH * s) & ~1);
  if (w === Wd && h === Ht) return;
  dynN = dynG = dynGN = 0; dynT = -300;
  Wd = w; Ht = h; canvas.width = Wd; canvas.height = Ht;
  ctx.configure({ device, format: FMT, alphaMode: 'opaque' });
  for (const t of targets) t.destroy();
  const tMS = tex(AA > 1 ? Wd : 1, Ht, HDR, TU.RENDER_ATTACHMENT, { samples: AA }), tDp = tex(Wd, Ht, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { samples: AA });
  const tRes = tex(Wd, Ht, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING), tRay = tex(Wd / 2, Ht / 2, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING), tRay2 = tex(Wd / 2, Ht / 2, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
  targets = [tMS, tDp, tRes, tRay, tRay2];
  const bl = [];
  for (let i = 0; i < NB; i++) { const t = tex(max(1, Wd >> (i + 1)), max(1, Ht >> (i + 1)), HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING); bl.push(t); targets.push(t); }
  const vDp = tDp.createView(), vRes = tRes.createView(), vRay = tRay.createView(), vRay2 = tRay2.createView(), vBl = bl.map((t) => t.createView());
  passScene = { colorAttachments: [{ view: AA > 1 ? tMS.createView() : vRes, resolveTarget: AA > 1 ? vRes : undefined, loadOp: 'clear', storeOp: AA > 1 ? 'discard' : 'store', clearValue: [0.012, 0.015, 0.028, 1] }],
    depthStencilAttachment: { view: vDp, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } };
  passRays = { colorAttachments: [colorAtt(vRay, true)] };
  passBlur = { colorAttachments: [colorAtt(vRay2, true)] };
  bgBlur = device.createBindGroup({ layout: pRB.getBindGroupLayout(0), entries: [{ binding: 0, resource: vRay }] });
  passPost = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
  bgRays = device.createBindGroup({ layout: pRays.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: vDp }] });
  bgPost = device.createBindGroup({ layout: pPost.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: sClamp }, { binding: 2, resource: vRes },
    { binding: 3, resource: vRay2 }, { binding: 4, resource: vBl[0] }, { binding: 5, resource: vDp }] });
  bloomPass = []; bloomBG = [];
  // down: res -> b0 -> ... -> b5 ; up: b5 -> b4 (additive) ... -> b0
  for (let i = 0; i < NB; i++) { bloomPass.push({ colorAttachments: [colorAtt(vBl[i], true)] }); bloomBG.push(blitBG(i ? vBl[i - 1] : vRes)); }
  for (let i = NB - 1; i > 0; i--) { bloomPass.push({ colorAttachments: [colorAtt(vBl[i - 1], false)] }); bloomBG.push(blitBG(vBl[i])); }
  UB[32] = Wd; UB[33] = Ht; UB[34] = 1 / Wd; UB[35] = 1 / Ht;
}
resize();
addEventListener('resize', resize);
new ResizeObserver(() => resize()).observe(canvas); // also catches the canvas getting its size late (hidden frames, tabs)

// ---------------------------------------------------------------- timing (GPU timestamp queries)
let qs, qResolve, qRead = [], tsBegin, tsEnd;
if (hasTS) {
  qs = device.createQuerySet({ type: 'timestamp', count: 2 });
  qResolve = device.createBuffer({ size: 16, usage: BU.QUERY_RESOLVE | BU.COPY_SRC });
  for (let i = 0; i < 6; i++) {
    const b = device.createBuffer({ size: 16, usage: BU.MAP_READ | BU.COPY_DST });
    const o = { b, busy: false, done: null };
    o.done = () => {
      const a = new BigInt64Array(b.getMappedRange());
      const ms = Number(a[1] - a[0]) / 1e6; F[GPU] = ms; b.unmap(); o.busy = false;
      if (dynT > 0 && ms > 0 && ms < 1e3) { dynG += ms; dynGN++; }
    };
    qRead.push(o);
  }
  tsBegin = { querySet: qs, beginningOfPassWriteIndex: 0 }; tsEnd = { querySet: qs, endOfPassWriteIndex: 1 };
}

// ---------------------------------------------------------------- frame
let hud = false, infoOn = true;
let kf = 0, kb = 0, kl = 0, kr = 0, ku = 0, kd = 0, ks = 0, mdx = 0, mdy = 0, lkx = 0, lky = 0, l2x = 0, l2y = 0, hN = 0, hMax = 0, hMin = 1e9, hPer = 1e9, hLate = 0, hTot = 0, tId = -1, tN = 0, tx0 = 0, ty0 = 0, tx = 0, ty = 0;
const TANH = 0.6, NEAR = 0.1, EXPO = 0.8, RAYS = 2.2;
const submitList = [null];
let SKIP = 0; // profiling: bits skip terrain 1, blocks 2, lid 8, wires 16, shafts 64, store i: 256 << i (index.html#debug: dbg.skip(n))
const rowOrd = new Uint8Array(CELLS);
// Draws the cells of a cell-sorted buffer that are in view and within [minD, maxD) (scaled by `det`, but not for the
// terrain) as merged runs, nearest rows first.
function drawCells(r, start, lo, hi, mar, indexed, verts, minD, maxD) {
  const cx = F[CX], cy = F[CY], cz = F[CZ], fx = F[FX], fy = F[FY], fz = F[FZ], rx = F[RX], rz = F[RZ], ux = F[UX], uy = F[UY], uz = F[UZ];
  const ds = indexed === 1 ? 1 : det * det;
  const tx = TANH * Wd / Ht, hw = CELLW * 0.5, ex = hw + mar, min2 = minD * minD * ds, max2 = maxD * maxD * ds;
  for (let k = 0; k < CELLS; k++) {
    const rw = rowOrd[k], row = rw * CELLS, pz = OZ + (rw + 0.5) * CELLW - cz, hz = max(abs(pz) - hw, 0);
    let run = -1;
    for (let x = 0; x <= CELLS; x++) {
      const c = row + x; let v = false;
      if (x < CELLS) {
        const l = lo[c], h = hi[c];
        if (l <= h) {
          const px = OX + (x + 0.5) * CELLW - cx, py = (l + h) * 0.5 - cy, ey = (h - l) * 0.5 + mar, hx = max(abs(px) - hw, 0), h2 = hx * hx + hz * hz;
          if (h2 < max2 && h2 >= min2) {
            const lim = px * fx + py * fy + pz * fz + ex * abs(fx) + ey * abs(fy) + ex * abs(fz);
            if (lim >= 0 && abs(px * rx + pz * rz) - ex * (abs(rx) + abs(rz)) <= lim * tx) v = abs(px * ux + py * uy + pz * uz) - ex * (abs(ux) + abs(uz)) - ey * abs(uy) <= lim * TANH;
          }
        }
      }
      if (v) { if (run < 0) run = c; } else if (run >= 0) {
        const a = start[run], n = start[c] - a;
        if (n > 0) { if (indexed === 1) r.drawIndexed(n * 6, 1, a * 6, 0, 0); else if (indexed) r.drawIndexed(indexed.ib.length, n, indexed.i0, indexed.v0, a); else r.draw(verts, n, 0, a); }
        run = -1;
      }
    }
  }
}
function render() {
  // camera basis (right vector is horizontal)
  const cx = F[CX], cy = F[CY], cz = F[CZ], pitch = F[PIT], yaw = F[YAW];
  const cp = cos(pitch), fy = sin(pitch), rx = cos(yaw), rz = sin(yaw), fx = cp * rz, fz = -cp * rx;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  F[FX] = fx; F[FY] = fy; F[FZ] = fz; F[RX] = rx; F[RZ] = rz; F[UX] = ux; F[UY] = uy; F[UZ] = uz;
  const asp = Wd / Ht, sx = 1 / (TANH * asp), sy = 1 / TANH, m = UB;
  // reversed-Z infinite-far projection: clear depth 0, test 'greater'
  m[0] = rx * sx; m[4] = 0; m[8] = rz * sx; m[12] = -(rx * cx + rz * cz) * sx;
  m[1] = ux * sy; m[5] = uy * sy; m[9] = uz * sy; m[13] = -(ux * cx + uy * cy + uz * cz) * sy;
  m[2] = 0; m[6] = 0; m[10] = 0; m[14] = NEAR;
  m[3] = fx; m[7] = fy; m[11] = fz; m[15] = -(fx * cx + fy * cy + fz * cz);
  m[16] = cx; m[17] = cy; m[18] = cz; m[19] = F[TIME];
  m[20] = rx; m[21] = 0; m[22] = rz; m[23] = TANH * asp;
  m[24] = ux; m[25] = uy; m[26] = uz; m[27] = TANH;
  m[28] = fx; m[29] = fy; m[30] = fz; m[31] = NEAR;
  m[36] = F[CLK]; m[37] = 0; m[38] = F[DIV]; m[39] = det;
  m[40] = EXPO; m[41] = RAYS;
  Q.writeBuffer(ubo, 0, UB);

  { let cr = floor((cz - OZ) / CELLW) | 0; cr = cr < 0 ? 0 : cr > CELLS - 1 ? CELLS - 1 : cr; let n = 0; rowOrd[n++] = cr; for (let d = 1; d < CELLS; d++) { if (cr - d >= 0) rowOrd[n++] = cr - d; if (cr + d < CELLS) rowOrd[n++] = cr + d; } }
  const e = device.createCommandEncoder();
  let slot = null;
  if (hasTS) { for (let i = 0; i < qRead.length; i++) if (!qRead[i].busy) { slot = qRead[i]; break; } }
  passScene.timestampWrites = slot ? tsBegin : undefined;
  passPost.timestampWrites = slot ? tsEnd : undefined;
  let r = e.beginRenderPass(passScene);
  r.setBindGroup(0, bg0);
  if (!(SKIP & 1)) { r.setPipeline(pTerr); r.setVertexBuffer(0, vbTerrain); r.setIndexBuffer(ibTerrain, 'uint32'); drawCells(r, T.start, T.lo, T.hi, 1.5, 1, 0, 0, 260); }
  r.setPipeline(pBlk); r.setVertexBuffer(0, vbMesh); r.setIndexBuffer(ibMesh, 'uint32');
  if (!(SKIP & 2)) for (let i = 0; i < STORES.length; i++) {
    const c = W.inst[i], S = STORES[i], me = meshes[S[0]]; if (!c.n || (SKIP >> (8 + i)) & 1) continue;
    r.setVertexBuffer(1, ibInst[i]);
    if (S[2]) drawCells(r, c.start, c.lo, c.hi, 3, me, 0, 0, S[1]); else r.drawIndexed(me.ib.length, c.n, me.i0, me.v0, 0);
  }
  if (nDart) { r.setPipeline(pDart); r.setVertexBuffer(1, ibDarts); r.drawIndexed(DART.ib.length, nDart, DART.i0, DART.v0, 0); }
  if (nPkt) { r.setPipeline(pPkt); r.setVertexBuffer(1, ibPkts); r.drawIndexed(BOX.ib.length, nPkt, BOX.i0, BOX.v0, 0); }
  if (!(SKIP & 8)) { r.setPipeline(pCeil); r.draw(4); }
  if (W.wires.n && !(SKIP & 16)) { r.setPipeline(pWire); r.setVertexBuffer(0, ibWires); drawCells(r, W.wires.start, W.wires.lo, W.wires.hi, 5, false, 4, 0, 190); }
  if (nHeat) { r.setPipeline(pHeat); r.setVertexBuffer(0, ibHeats); r.draw(4, nHeat); }
  r.setPipeline(pEl); r.setVertexBuffer(0, ibEls); r.draw(4, nEl);
  r.end();
  // light shafts
  r = e.beginRenderPass(passRays); if (!(SKIP & 64)) { r.setPipeline(pRays); r.setBindGroup(0, bgRays); r.draw(3); } r.end();
  r = e.beginRenderPass(passBlur); r.setPipeline(pRB); r.setBindGroup(0, bgBlur); r.draw(3); r.end();
  // bloom
  for (let i = 0; i < bloomPass.length; i++) {
    r = e.beginRenderPass(bloomPass[i]); r.setPipeline(i === 0 ? pDown0 : i < NB ? pDown : pUp); r.setBindGroup(0, bloomBG[i]); r.draw(3); r.end();
  }
  // composite
  passPost.colorAttachments[0].view = ctx.getCurrentTexture().createView();
  r = e.beginRenderPass(passPost); r.setPipeline(pPost); r.setBindGroup(0, bgPost); r.draw(3); r.end();
  if (slot) { e.resolveQuerySet(qs, 0, 2, qResolve, 0); e.copyBufferToBuffer(qResolve, 0, slot.b, 0, 16); }
  submitList[0] = e.finish();
  Q.submit(submitList);
  if (slot) { slot.busy = true; slot.b.mapAsync(GPUMapMode.READ).then(slot.done); }
}

// CS[j] = distance to the solid (metres, < 0 in air) at the camera + CE[3j..3j+2]: the camera, then +-0.375 m on each axis for the gradient
const CE = new Float64Array([0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375]), CS = new Float64Array(7);
const cv = (x, y, z) => { const b = CI[(x >> 2) + CN * ((y >> 2) + NY / 4 * (z >> 2))]; return b > 1 ? CG[b * 64 - 128 + (x & 3) + 4 * (y & 3) + 16 * (z & 3)] : b * 254 - 127; };
function sd(j) {
  const x = (F[CX] + CE[j * 3] - OX) / VS - CO, y = (F[CY] + CE[j * 3 + 1] - OY) / VS, z = (F[CZ] + CE[j * 3 + 2] - OZ) / VS - CO;
  const ix = x | 0, iy = y | 0, iz = z | 0, u = x - ix, v = y - iy, a = cv(ix, iy, iz), b = cv(ix, iy + 1, iz), c = cv(ix, iy, iz + 1), d = cv(ix, iy + 1, iz + 1);
  const p = a + (cv(ix + 1, iy, iz) - a) * u, q = b + (cv(ix + 1, iy + 1, iz) - b) * u, r = c + (cv(ix + 1, iy, iz + 1) - c) * u, s = d + (cv(ix + 1, iy + 1, iz + 1) - d) * u;
  const e = p + (q - p) * v; CS[j] = (e + (r + (s - r) * v - e) * (z - iz)) / 127;
}
// Moves the camera by F[MX..MZ] in steps shorter than its radius CR (so it can't pass through thin walls), pushing it
// back out after each step and dropping velocity into the solid, so it slides along.
const CR = 0.5;
function collide() {
  const n = floor(sqrt(F[MX] * F[MX] + F[MY] * F[MY] + F[MZ] * F[MZ]) / 0.4) + 1;
  for (let i = 0; i < n; i++) {
    F[CX] += F[MX] / n; F[CY] += F[MY] / n; F[CZ] += F[MZ] / n;
    for (let k = 0; k < 2; k++) {
      sd(0); const s = CS[0] + CR; if (s <= 0) break;
      for (let j = 1; j < 7; j++) sd(j);
      let gx = CS[1] - CS[2], gy = CS[3] - CS[4], gz = CS[5] - CS[6]; const l = sqrt(gx * gx + gy * gy + gz * gz);
      if (l < 0.075) break;
      gx /= l; gy /= l; gz /= l; const vn = F[VX] * gx + F[VY] * gy + F[VZ] * gz;
      F[CX] -= gx * s; F[CY] -= gy * s; F[CZ] -= gz * s;
      if (vn > 0) { F[VX] -= gx * vn; F[VY] -= gy * vn; F[VZ] -= gz * vn; }
    }
  }
}

// ---------------------------------------------------------------- what the camera is looking at: info panel + clock readout
const INFO = {
  die: ['NVIDIA A100 · GA100', 'Ampere architecture · TSMC 7 nm', '54.2 billion transistors on 826 mm² of silicon, and you are flying inside it: transistors and metal wiring below, the package lid above, light falling through its openings.\nColours mark the function: green = compute (SMs), violet = L2 cache, cyan = data buses, amber = memory, magenta = clock and tensor math.\nEverything moves with the chip clock: Space freezes it, N steps one cycle, [ ] changes its speed.'],
  giga: ['GigaThread Engine', 'Global thread-block scheduler', 'The chip\'s dispatcher: it hands out thousands of thread blocks to whichever SMs have room. The rings running up the tower are dispatch pulses; the small cubes circling out of it are thread blocks on their way.\nIt also drives MIG, which splits one A100 into up to 7 isolated GPU instances.'],
  xbar: ['Crossbar', 'The highway between SMs and L2', 'All data between the SMs and the L2 cache slices crosses this canyon. The racing blocks of light are packets, coloured by bus; the floating cubes are cache lines.\nThe copper barrels along the walls are decoupling capacitors that smooth the power supply; the pipes on top carry power and signals.'],
  gpc: ['GPC · Graphics Processing Cluster', '8 GPCs, up to 16 SMs each', 'Each tower is a miniature SM. The dark ones with a red beacon are fused off: a full GA100 has 128 SMs, the A100 enables 108 of them (a trade-off between yield and cost).\nThe pink tree overhead is a clock tree (H-tree) that delivers the same clock edge to every corner at once.\nThe flocks of green arrows are warps: 32 threads moving in lockstep.'],
  sm: ['SM · Streaming Multiprocessor', 'Shown about 50x larger', 'The SM is the A100\'s basic compute unit: four processing partitions sharing 192 KB of L1 cache / shared memory (the layered cross in the middle).\nAn SM keeps up to 64 warps = 2,048 threads in flight. Fly close to any part and this panel explains it.'],
  sched: ['Warp Scheduler', 'One per partition', 'Every cycle it picks a ready warp (32 threads) and issues one instruction. The 32 arrows circling overhead are one warp, moving in lockstep (SIMT).\nPress G to force branch divergence: when threads of one warp take different branches, they run in turns (the orange group) and then reconverge.'],
  rf: ['Register File', '64 KB per partition · 256 KB per SM', 'The height of each pillar is the value held in a register, changing every cycle. Thread variables live here; it is the fastest storage on the chip.\n256 KB x 108 SMs ≈ 27 MB.'],
  int32: ['INT32 Cores', '16 per partition', 'Integer maths and address calculation. Since Volta, INT32 and FP32 instructions issue and execute concurrently. A lit core is busy this cycle.'],
  fp32: ['FP32 CUDA Cores', '16 per partition · 64 per SM', 'Each does one fused multiply-add per cycle (FMA = 2 floating-point operations).\n108 x 64 = 6,912 cores x 2 x 1.41 GHz ≈ 19.5 TFLOPS.'],
  fp64: ['FP64 Cores', '8 per partition · 32 per SM', 'Double precision, the workhorse of scientific computing: 3,456 across the chip, about 9.7 TFLOPS (19.5 TFLOPS through the Tensor Cores).'],
  tensor: ['Tensor Core · 3rd generation', 'One per partition · 432 on the chip', 'Built for matrix multiply-accumulate, D = A x B + C. Each Tensor Core completes 256 FP16 FMAs per cycle, which is how the A100 reaches 312 TFLOPS of dense FP16.\nThe cube lattice is a sketch: the lit wavefront moving along the diagonal is how a systolic array works.'],
  l1: ['L1 Cache / Shared Memory', '192 KB per SM', 'The on-chip memory closest to the cores. The A100 combines L1 and shared memory in one SRAM block, of which up to 164 KB can be set aside as programmer-managed shared memory.'],
  tc: ['Tensor Core · enlarged sketch', '4x4x4 multiply-accumulate lattice', 'Matrix A flows in from the west, B from the south; every cube does one multiply-add and the results flow out to the east.\nReal Tensor Cores work on larger tiles; this is simplified to 4x4x4 so it can be read. Press N to step and watch the wavefront advance one cell at a time.'],
  l2: ['L2 Cache', '40 MB (6.7x the V100)', 'Shared by every SM. Each pillar stands for one SRAM bit: tall = 1, short = 0; a sweep of light is a read.\nThe ridge in the middle splits L2 into two partitions. Its bandwidth is far above the HBM\'s, so it shields memory from repeated accesses.'],
  hbm: ['HBM2e Memory', '5 stacks · 5,120-bit bus · ~1.6–2.0 TB/s', 'Each tower is a stack of 8 DRAM dies joined vertically by TSVs (through-silicon vias); the glowing vertical lines are data moving through them. The stacks sit next to the GPU on a silicon interposer.\nThe 40 GB model = 5 x 8 GB.'],
  hbmx: ['Disabled HBM Stack', 'GA100 has 6, the A100 enables 5', 'The sixth stack is fused off, which is why this one stays dark.'],
  interp: ['Silicon Interposer · CoWoS', 'The foundation under GPU and HBM', 'The GPU die and the HBM stacks sit side by side on one silicon interposer, tied together by thousands of micron-scale wires (the orange dots on the floor are micro-bumps). This is what makes terabytes per second possible.'],
  nvlink: ['NVLink 3.0', '12 links · 600 GB/s in total', 'Each link carries 50 GB/s (both directions), 600 GB/s for all 12. It lets several GPUs read each other\'s memory as if they were one big GPU. The blocks of light passing through the rings are link packets.'],
  pcie: ['PCIe 4.0 x16', 'Talking to the CPU and the outside world', 'About 32 GB/s each way (64 GB/s both directions), far slower than NVLink, so data is usually copied into HBM once and then reused on the GPU.'],
  wall: ['Package Edge', 'Beyond this lies the outside world', 'The copper ceiling stands for the package lid that carries the heat away: an A100 (SXM) draws about 400 W at full load, a lot of heat for 826 mm² of silicon.'],
};
const zoneOf = (x, z) => {
  const ax = abs(x), az = abs(z), m = max(ax, az);
  if (m > 168) return 'wall';
  if (m > 122) return ax > az ? 'interp' : z > 0 ? 'nvlink' : 'pcie';
  return az < 16 ? 'xbar' : az < 53 ? 'l2' : 'gpc';
};
let poiId = '', frozenShown = -1, freqShown = -1;
const pt = $('pt'), ps = $('ps'), pb = $('pb'), ck = $('clk');
function updateHud() {
  let best = null, bs = 1;
  for (const p of W.pois) { const s = hypot(F[CX] - p.x, F[CZ] - p.z) / p.r; if (s < bs) { bs = s; best = p.id; } }
  const id = best || zoneOf(F[CX], F[CZ]);
  if (id !== poiId) { poiId = id; const t = INFO[id] || INFO.die; pt.textContent = t[0]; ps.textContent = t[1]; pb.textContent = t[2]; }
  ck.textContent = `CLK ${F[FREQ].toFixed(2)} Hz  ${F[FRZ] ? '❚❚ frozen' : '▶'}  cycle ${floor(F[CLK])}${F[DIV] ? '  ⑂ divergence' : ''}`;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dtr = now - F[LAST]; F[LAST] = now;
  let dt = dtr / 1000; if (dt > 0.1) dt = 0.1;
  // Dynamic resolution for 60 fps: every second (0.4 s behind the menu) scale the load by k
  // (skipped while the canvas has no real size, e.g. in a hidden frame, which would otherwise shrink `pix` to a few pixels)
  if (dtr < 1e3 && DW * DH >= PIXMIN && (dynT += dtr) > 0 && (dynN++, dynT > (menu ? 400 : 1000))) {
    const a = dynT / dynN, g = dynGN ? dynG / dynGN : 0; let k = 1;
    if (g) { if (g > 13.6 || g < 9.8) k = 11.7 / g; }
    else if (a > 17.6) { dynOk = 0; if (++dynBad > 1) { k = 15 / a; dynBad = 0; dynWait = min(dynWait * 2, 60); } }
    else { dynBad = 0; if (a < 12.5) k = 15 / a; else if (++dynOk > dynWait) { k = 1.17; dynOk = 0; } }
    k = k < 0.5 ? 0.5 : k > 1.7 ? 1.7 : k; const top = max(min(PIXMAX, DW * DH), PIXMIN), mid = max(top / 2, PIXMIN), was = pix + det;
    // too slow: pixels down to `mid` first, then draw distance, then the remaining pixels; faster goes back the same way
    if (k < 1 ? pix > mid || det <= DETMIN : pix < mid || det >= 1) {
      const end = k < 1 ? (det > DETMIN ? mid : PIXMIN) : det < 1 ? mid : top;
      pix *= k; if (k < 1 ? pix < end : pix > end) pix = end;
    } else { det *= sqrt(k); det = det < DETMIN ? DETMIN : det > 1 ? 1 : det; }
    if (was !== pix + det) keep('a100', [LV, pix < top ? pix | 0 : '', det]);
    dynN = dynT = dynG = dynGN = 0; resize();
  }
  F[TIME] += dt;
  // the clock: free-running, frozen, or stepped one cycle at a time
  if (!F[FRZ]) { F[CLK] += dt * F[FREQ]; F[CTG] = F[CLK]; } else if (F[CTG] > F[CLK]) F[CLK] = min(F[CTG], F[CLK] + dt * 3);
  {
    if (tId >= 0) {
      const tr = 4 / (innerWidth < innerHeight ? innerWidth : innerHeight); let jx = (tx - tx0) * tr, jy = (ty - ty0) * tr;
      jx = jx > 1 ? 1 : jx < -1 ? -1 : jx; jy = jy > 1 ? 1 : jy < -1 ? -1 : jy;
      lkx += jx * 1.5 * dt; lky += jy * dt;
    }
    // mouse look through two cascaded low-pass stages
    const kq = 1 - exp(-dt * 30); lkx += mdx * 0.0022; lky += mdy * 0.0022; mdx = 0; mdy = 0;
    const ax = lkx * kq, ay = lky * kq; lkx -= ax; lky -= ay; l2x += ax; l2y += ay;
    const dyw = l2x * kq, dpt = l2y * kq; l2x -= dyw; l2y -= dpt;
    const yaw = F[YAW] + dyw; let pitch = F[PIT] - dpt; pitch = pitch < -1.55 ? -1.55 : pitch > 1.55 ? 1.55 : pitch;
    const sp = ks || tN > 1 ? 26 : 8, k = 1 - exp(-dt * 4.5), mf = tId >= 0 ? 0.7 : kf - kb, mr = kr - kl, mu = ku - kd, cp = cos(pitch), sy = sin(yaw), cw = cos(yaw);
    const vx = F[VX] + ((sy * cp * mf + cw * mr) * sp - F[VX]) * k, vy = F[VY] + ((sin(pitch) * mf + mu) * sp - F[VY]) * k, vz = F[VZ] + ((-cw * cp * mf + sy * mr) * sp - F[VZ]) * k;
    let x = F[CX] + vx * dt, y = F[CY] + vy * dt, z = F[CZ] + vz * dt;
    x = x < -170 ? -170 : x > 170 ? 170 : x; z = z < -170 ? -170 : z > 170 ? 170 : z;
    y = y < 1.2 ? 1.2 : y > 54 ? 54 : y;
    F[YAW] = yaw; F[PIT] = pitch; F[VX] = vx; F[VY] = vy; F[VZ] = vz; F[MX] = x - F[CX]; F[MY] = y - F[CY]; F[MZ] = z - F[CZ];
    collide();
  }
  render();
  if ((F[POIT] += dtr) > 200) { F[POIT] = 0; updateHud(); }
  if (hud) {
    hN++; if (dtr > hMax) hMax = dtr; if (dtr < hMin) hMin = dtr; if (dtr > hPer * 1.5) { hLate++; hTot++; }
    F[HUDT] += dtr / 1000;
    if (F[HUDT] > 0.5) { info.textContent = `${(hN / F[HUDT]).toFixed(0)} fps  ·  worst frame ${hMax.toFixed(1)} ms  ·  late frames ${hLate} (total ${hTot})  ·  GPU ${F[GPU].toFixed(2)} ms  ·  ${Wd}x${Ht} (${Wd * 100 / DW | 0}%)`; F[HUDT] = 0; hPer = hMin; hN = 0; hMax = 0; hMin = 1e9; hLate = 0; }
  }
}

// ---------------------------------------------------------------- input
const key = (e, v) => {
  switch (e.code) {
    case 'KeyW': kf = v; break; case 'KeyS': kb = v; break; case 'KeyA': kl = v; break; case 'KeyD': kr = v; break;
    case 'KeyE': ku = v; break; case 'KeyQ': kd = v; break; case 'ShiftLeft': case 'ShiftRight': ks = v; break;
    default: if (v && !e.repeat) {
      if (e.code === 'KeyH') { hud = !hud; hTot = 0; hPer = 1e9; info.textContent = ''; }
      else if (e.code === 'KeyM') mute();
      else if (e.code === 'Escape') ui(true);
      else if (e.code === 'Space') { F[FRZ] = F[FRZ] ? 0 : 1; F[CTG] = F[CLK]; e.preventDefault(); }
      else if (e.code === 'KeyN') { F[FRZ] = 1; F[CTG] = floor(max(F[CTG], F[CLK])) + 1; }
      else if (e.code === 'BracketLeft') F[FREQ] = max(0.15, F[FREQ] / 1.5);
      else if (e.code === 'BracketRight') F[FREQ] = min(9.6, F[FREQ] * 1.5);
      else if (e.code === 'KeyG') F[DIV] = F[DIV] ? 0 : 1;
      else if (e.code === 'KeyI') { infoOn = !infoOn; $('poi').style.display = infoOn ? '' : 'none'; }
      else if (e.code >= 'Digit1' && e.code <= 'Digit6') { const n = e.code.charCodeAt(5) - 49; lookAt(...POSES[n]); poiId = ''; updateHud(); toast(POSE_NAMES[n]); }
    }
  }
};
let toastT = 0;
const toast = (t) => { const o = $('t'); o.textContent = t; o.style.opacity = 1; clearTimeout(toastT); toastT = setTimeout(() => (o.style.opacity = 0), 1600); };
// behind the menu only the stats and mute keys work
addEventListener('keydown', (e) => { if (menu && e.code !== 'KeyH' && e.code !== 'KeyM') return; sound(); key(e, 1); });
addEventListener('keyup', (e) => key(e, 0));
const release = () => { kf = kb = kl = kr = ku = kd = ks = 0; tId = -1; tN = 0; };
const capture = () => { sound(); const p = canvas.requestPointerLock({ unadjustedMovement: true }); if (p && p.catch) p.catch(() => canvas.requestPointerLock()).catch(() => 0); };
canvas.addEventListener('click', capture);
addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { mdx += e.movementX; mdy += e.movementY; } });
addEventListener('blur', release);
const touch = (e) => {
  e.preventDefault(); sound(); tN = e.touches.length;
  let f = null, first = false; for (let i = 0; i < tN; i++) if (e.touches[i].identifier === tId) f = e.touches[i];
  if (!f) { tId = -1; if (tN) { f = e.touches[0]; tId = f.identifier; first = true; } }
  if (f) {
    const x = rot.matches ? f.clientY : f.clientX, y = rot.matches ? -f.clientX : f.clientY, s = 1100 / min(innerWidth, innerHeight);
    if (first) { tx0 = x; ty0 = y; } else { mdx += (x - tx) * s; mdy += (y - ty) * s; }
    tx = x; ty = y;
  }
};
for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(n, touch, { passive: false });

// ---------------------------------------------------------------- menu
// The scene keeps rendering (blurred by CSS) behind the menu. Esc, losing the mouse or the corner button open it.
let menu = true;
const bDive = $('d');
const ui = (m) => {
  if (dead) return;
  menu = m; body.className = m ? 'm' : document.pointerLockElement ? 'g p' : 'g';
  if (m) { release(); setTimeout(() => menu && bDive.focus(), 100); } else document.activeElement.blur();
};
const go = () => {
  sound(); ui(false); bDive.textContent = 'Resume';
  if (mob) document.documentElement.requestFullscreen?.()?.then(() => screen.orientation.lock('landscape')).catch(() => 0);
  if (!mob) capture();
};
bDive.onclick = go; $('o').onclick = () => ui(true);
$('q').querySelectorAll('button').forEach((b, i) => { if (i === 2 - LV) b.className = 'on'; else b.onclick = () => { keep('a100', 2 - i); location.reload(); }; });
document.addEventListener('pointerlockchange', () => ui(!document.pointerLockElement));

// debugging aid: index.html#debug exposes the camera state and the collision functions
if (location.hash === '#debug') window.dbg = { F, sd, CS, collide, render, frame, lookAt, CI, CG, POSES, skip: (n) => (SKIP = n) };

// draw the first frame and wait for the GPU to finish it (pipelines get compiled on first use) before the reveal
lookAt(...POSES[0]);
await say('Powering on…', 1, 400);
render(); await Q.onSubmittedWorkDone();
setTimeout(keep, 15e3, 'a100Load', '');
updateHud();
ui(true);
requestAnimationFrame((t) => { F[LAST] = t; requestAnimationFrame(frame); });
