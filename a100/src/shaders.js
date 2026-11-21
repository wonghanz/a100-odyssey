// ============================================================================
// WGSL sources
// ============================================================================
// World plan (x east, z south, y up, 1 unit ~ 1 m of the stylised world):
//   die            |x|,|z| < 120      GPC rows at |z| 57..111 (4 GPCs each, 4x4 SM towers per GPC)
//   crossbar       |z| < 16           the east-west canyon, GigaThread tower at the origin
//   L2 cache       16 < |z| < 52      SRAM pillar forest, two partitions split at x = 0
//   interposer     |x| or |z| > 120   HBM stacks at x = +-150, NVLink rings at z = 146, PCIe at z = -146
//   package wall   |x| or |z| > 177   the boundary, with the lid (ceiling) at y = CEIL

// ---------------------------------------------------------------- shared helpers (no bindings)
const S_BASE = /*wgsl*/`
const TAU = 6.2831853;
const CEIL = 58.;
const PITCH = 24.;
const C_SM = vec3f(.42, 1., .12);
const C_L2 = vec3f(.62, .36, 1.);
const C_XB = vec3f(.10, .78, 1.);
const C_HB = vec3f(1., .52, .08);
const C_PH = vec3f(1., .16, .62);
fn sat(x: f32) -> f32 { return clamp(x, 0., 1.); }
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(.06711056, .00583715)))); }
fn ih(x: u32) -> u32 { var h = x * 747796405u + 2891336453u; h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u; return (h >> 22u) ^ h; }
fn hf(x: u32) -> f32 { return f32(ih(x) >> 8u) / 16777216.; }
fn h21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn zw(p: vec2f) -> vec4f {
  let ax = abs(p.x); let az = abs(p.y);
  let die = ss(122., 116., ax) * ss(122., 116., az);
  return vec4f(die * ss(50., 56., az), die * ss(10., 16., az) * ss(56., 50., az), die * ss(19., 12., az), ss(122., 128., ax) * ss(174., 168., ax));
}
fn zcol(p: vec2f) -> vec3f {
  let w = zw(p); let s = w.x + w.y + w.z + w.w;
  return (C_SM * w.x + C_L2 * w.y + C_XB * w.z + C_HB * w.w + vec3f(.55, .62, .8) * max(1. - s, 0.)) / max(s, 1.);
}
// GPC grid: xy = position relative to the GPC centre, z = GPC index (0-3 north row, 4-7 south row)
fn gpcAt(p: vec2f) -> vec3f {
  let cxi = clamp(floor((p.x + 120.) / 60.), 0., 3.);
  let south = p.y > 0.;
  return vec3f(p.x - (-90. + cxi * 60.), p.y - select(-84., 84., south), cxi + select(0., 4., south));
}
struct TW { id: f32, ld: vec2f, H: f32, on: f32, ok: f32 };
fn towerAt(p: vec2f) -> TW {
  var t: TW;
  let gp = gpcAt(p);
  t.ok = f32(abs(gp.x) < 26. && abs(gp.y) < 26. && gp.z != 1. && gp.z != 5.);
  let id = clamp(floor((gp.xy + 26.) / 13.), vec2f(0.), vec2f(3.));
  t.ld = gp.xy - ((id + .5) * 13. - 26.);
  t.id = gp.z * 16. + id.x + 4. * id.y;
  let k = u32(t.id);
  t.H = 4.6 + 4.4 * hf(k);
  t.on = f32(hf(k + 977u) > .16);
  return t;
}
`;

const W_NOISE = /*wgsl*/`
fn h31(p: vec3f) -> f32 { var q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn vn(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(mix(h31(i), h31(i + vec3f(1., 0., 0.)), u.x), mix(h31(i + vec3f(0., 1., 0.)), h31(i + vec3f(1., 1., 0.)), u.x), u.y),
             mix(mix(h31(i + vec3f(0., 0., 1.)), h31(i + vec3f(1., 0., 1.)), u.x), mix(h31(i + vec3f(0., 1., 1.)), h31(i + vec3f(1., 1., 1.)), u.x), u.y), u.z);
}
fn fbm(p: vec3f, n: i32) -> f32 {
  var a = .5; var s = 0.; var q = p;
  for (var i = 0; i < n; i++) { s += a * vn(q); q = q * 2.03 + vec3f(17.1, 31.7, 5.3); a *= .5; }
  return s / (1. - 2. * a);
}
`;

// ---------------------------------------------------------------- terrain density (compute): > 0 inside solid
const W_DENS = S_BASE + W_NOISE + /*wgsl*/`
struct U { n: vec4u, o: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> D: array<f32>;
fn smax(a: f32, b: f32, k: f32) -> f32 { let h = max(k - abs(a - b), 0.) / k; return max(a, b) + h * h * k * .25; }
fn sdBox(p: vec3f, b: vec3f) -> f32 { let q = abs(p) - b; return length(max(q, vec3f(0.))) + min(max(q.x, max(q.y, q.z)), 0.); }
fn sdCyl(p: vec3f, r: f32, h: f32) -> f32 { let d = abs(vec2f(length(p.xz), p.y - h * .5)) - vec2f(r, h * .5); return min(max(d.x, d.y), 0.) + length(max(d, vec2f(0.))); }
const ARX = array<f32, 4>(-84., -28., 28., 84.);
fn dens(p: vec3f) -> f32 {
  let ax = abs(p.x); let az = abs(p.z); let m = max(ax, az);
  let nz = fbm(vec3f(p.xz * .06, 3.), 2) - .5;
  // ground: die at 0 with a raised seal ring, interposer 1.6 lower
  let seal = ss(116.6, 117.4, m) * ss(120.2, 119.4, m);
  var d = (-1.6 * ss(120., 121.6, m) + 1.1 * seal) - p.y;
  // package wall (boundary)
  d = smax(d, m - (177. + 3. * nz), 1.5);
  // SM towers
  let tw = towerAt(p.xz);
  if (tw.ok > .5) {
    let s1 = sdBox(vec3f(tw.ld.x, p.y - tw.H * .5, tw.ld.y), vec3f(3.7, tw.H * .5 - .6, 3.7)) - .6;
    let s2 = sdBox(vec3f(tw.ld.x, p.y - (tw.H + .6), tw.ld.y), vec3f(2.2, 1.4, 2.2)) - .4;
    d = smax(d, -min(s1, s2), .5);
  }
  // low wall around each GPC, open in the middle of every side
  let gp = gpcAt(p.xz);
  if (abs(gp.x) < 29. && abs(gp.y) < 29.) {
    let rim = abs(max(abs(gp.x), abs(gp.y)) - 27.) - .6;
    let along = select(abs(gp.x), abs(gp.y), abs(gp.x) > abs(gp.y));
    d = smax(d, -max(max(rim, p.y - 2.4), 5. - along), .4);
  }
  // crossbar canyon walls with windows, arches across it
  if (m < 118. && az > 12. && az < 17.5) {
    let dw = abs(fract(p.x / 28.) - .5) * 28.;
    d = smax(d, -max(max(abs(az - 14.8) - .9, p.y - 7.), 4.5 - dw), .4);
  }
  if (az < 17. && ax < 118.) {
    for (var k = 0; k < 4; k++) {
      if (abs(p.x - ARX[k]) < 3.) { d = smax(d, -(length(vec2f(length(p.yz) - 13.6, p.x - ARX[k])) - 1.3), .5); }
    }
  }
  // L2 partition ridge
  if (ax < 2. && az > 16. && az < 52.) { d = smax(d, -max(max(ax - 1., p.y - 2.6), 0.), .3); }
  // GigaThread tower
  if (m < 12.) {
    let base = sdCyl(p, 9., 2.6);
    let body = sdCyl(p, 5.6 + .5 * ss(.35, .55, fract(p.y * .38)), 27.);
    let cap = sdCyl(p - vec3f(0., 26., 0.), 7.2, 1.6);
    let spire = max(length(p.xz) - (3.2 - (p.y - 27.) * .32), max(p.y - 36., 26.5 - p.y));
    d = smax(d, -min(min(base, body), min(cap, spire)), .6);
  }
  // HBM stacks: dies separated by narrow gaps
  if (ax > 124. && ax < 176.) {
    let cz = clamp(round(p.z / 80.) * 80., -80., 80.);
    let fy = fract(p.y / 5.);
    let ins = 1.5 * ss(.58, .72, fy) * ss(.98, .86, fy) * step(6., p.y);
    let b = sdBox(vec3f(ax - 150., p.y - 20., p.z - cz), vec3f(17. - ins, 19.5, 22.5 - ins)) - .5;
    d = smax(d, -b, .3);
  }
  // NVLink rings
  if (p.z > 138. && p.z < 154. && m < 176.) {
    let ix = clamp(round((p.x + 66.) / 12.), 0., 11.);
    let r = length(p.xy - vec2f(-66. + ix * 12., 7.2)) - 6.;
    d = smax(d, -(length(vec2f(r, p.z - 146.)) - .85), .3);
  }
  return d;
}
@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (any(id >= u.n.xyz)) { return; }
  var d = dens(u.o.xyz + vec3f(id) * u.o.w);
  if (id.x == 0u || id.z == 0u || id.x == u.n.x - 1u || id.z == u.n.z - 1u || id.y == u.n.y - 1u) { d = -1.; }
  D[id.x + u.n.x * (id.y + u.n.y * id.z)] = d;
}
`;

// ---------------------------------------------------------------- fullscreen helpers
const W_FS = /*wgsl*/`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0., 1.); }
`;

// blit / mip / bloom chain
const W_BLIT = W_FS + /*wgsl*/`
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
fn uvOf(fc: vec4f, k: f32) -> vec2f { return fc.xy * k / vec2f(textureDimensions(t)); }
fn kar(c: vec3f) -> vec4f { let w = 1. / (1. + max(c.r, max(c.g, c.b))); return vec4f(c * w, w); }
@fragment fn fsDown0(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  let a = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.).rgb, vec3f(24.)));
  let b = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.).rgb, vec3f(24.)));
  let c = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.).rgb, vec3f(24.)));
  let d = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.).rgb, vec3f(24.)));
  let m = a + b + c + d;
  return vec4f(m.rgb / m.a, 1.);
}
@fragment fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
@fragment fn fsUp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, .5); let e = .75 / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
`;

// ---------------------------------------------------------------- shared scene code (uniforms, lights, fog, circuits)
const S_G = S_BASE + W_NOISE + /*wgsl*/`
struct G { vp: mat4x4f, cam: vec4f, right: vec4f, up: vec4f, fwd: vec4f, res: vec4f, clk: vec4f, mis: vec4f };
@group(0) @binding(0) var<uniform> g: G;
const LD = vec3f(.139, -.985, .089);
const LCOL = vec3f(1., .95, .84);
fn apOn(c: vec2f) -> f32 { return mix(.22, 1., step(.3, h21(c + 5.1))); }
// skylight pool: the shafts fall from circular apertures in the lid, slightly slanted
fn ap(p: vec3f) -> f32 {
  let q = p.xz - LD.xz * ((CEIL - p.y) / -LD.y);
  let c = round(q / PITCH) * PITCH;
  let r = 2.2 + (CEIL - p.y) * .05;
  let d = length(q - c) / r;
  return exp(-d * d * 1.4) * apOn(c) * (.8 + .2 * sin(g.cam.w * .35 + h21(c) * 30.));
}
fn lighting(alb: vec3f, N: vec3f, wp: vec3f, rough: f32, metal: f32, zc: vec3f) -> vec3f {
  let V = normalize(g.cam.xyz - wp);
  let a = ap(wp);
  let ndl = sat(dot(N, -LD));
  let H = normalize(V - LD);
  var c = alb * (vec3f(.010, .013, .024) + zc * .016) * (.55 + .45 * sat(N.y)) * (.6 + .4 * ss(-1., 6., wp.y));
  c += alb * LCOL * 1.9 * a * ndl;
  c += LCOL * pow(sat(dot(N, H)), mix(140., 10., rough)) * a * (1. - rough) * 3. * mix(vec3f(.05), alb * 3. + .1, metal);
  let R = reflect(-V, N);
  var env = (vec3f(.014, .018, .030) + zc * .035) * (.35 + .65 * ss(-.3, .6, R.y));
  if (R.y > .02) {
    let t = (CEIL - wp.y) / R.y;
    let hp = wp.xz + R.xz * t;
    let c2 = round(hp / PITCH) * PITCH;
    let dd = length(hp - c2) / (2.4 + t * (.02 + rough * .12));
    env += LCOL * exp(-dd * dd * 1.6) * apOn(c2) * 3.5 * exp(-t * .006);
  }
  let fr = pow(1. - sat(dot(N, V)), 4.);
  c += env * mix(vec3f(.05 + fr * .5), alb * 2.2 + .15, metal) * (1. - rough * .6);
  return c;
}
fn fogC(c: vec3f, wp: vec3f) -> vec3f {
  let d = length(wp - g.cam.xyz);
  let T = exp(-d * .0072);
  let hz = (vec3f(.012, .015, .028) + zcol(wp.xz) * .02) * (.55 + .45 * exp(-max(wp.y, 0.) * .06));
  return c * T + hz * (1. - T);
}
fn footOf(dist: f32, n: vec3f, V: vec3f) -> f32 { return dist * 1.4 * g.res.w / max(abs(dot(n, V)), .25); }
// cheaper lighting for small, numerous parts (no reflections)
fn lightingLite(alb: vec3f, N: vec3f, wp: vec3f, zc: vec3f) -> vec3f {
  return alb * ((vec3f(.010, .013, .024) + zc * .016) * (.55 + .45 * sat(N.y)) + LCOL * 1.9 * ap(wp) * sat(dot(N, -LD)));
}
fn fin(c: vec3f) -> vec4f { return vec4f(min(max(c, vec3f(0.)), vec3f(40.)), 1.); }
// Manhattan-routed metal lanes along x (call with swapped coordinates for the other direction)
// returns (lane mask, travelling pulse)
fn lanes(q: vec2f, seed: f32, spd: f32, fw: f32) -> vec2f {
  let row = floor(q.y); let fy = fract(q.y) - .5;
  let hr = h21(vec2f(row, seed));
  let L = 3. + 10. * hr;
  let segq = (q.x + hr * 53.) / L; let seg = floor(segq);
  let hs_ = h21(vec2f(seg + row * 17.3, seed + 3.1));
  let on = step(.40, hs_);
  let wd = mix(.05, .15, step(.82, hr));
  let m = ss(wd + fw, wd - fw, abs(fy - (hr - .5) * .34));
  let fx = fract(segq);
  let w = m * on * ss(0., .03, fx) * ss(1., .97, fx);
  let dir = select(-1., 1., hs_ > .7);
  let pf = fract(q.x * .11 * dir - g.clk.x * spd + hs_ * 5.);
  return vec2f(w, w * exp(-pf * 6.) * ss(0., .06, pf));
}
// foot: world size of one pixel at this point (see footOf); no derivatives, so this can sit inside branches
fn circuit(p: vec2f, sc: f32, seed: f32, spd: f32, foot: f32) -> vec2f {
  let q = p * sc;
  let fw = foot * sc * .7 + .004;
  let a = lanes(q, seed, spd, fw);
  let b = lanes(q.yx + 31.7, seed + 11., spd, fw);
  return vec2f(max(a.x, b.x), max(a.y, b.y));
}
`;

// ---------------------------------------------------------------- terrain
const W_TERR = S_G + /*wgsl*/`
struct VI { @location(0) p: vec3f, @location(1) n: vec4f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f };
@vertex fn vs(i: VI) -> VO {
  var o: VO;
  o.cp = g.vp * vec4f(i.p, 1.); o.wp = i.p; o.n = i.n.xyz;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let n = normalize(i.n); let wp = i.wp;
  let vv = g.cam.xyz - wp; let dist = length(vv); let V = vv / dist;
  let foot = footOf(dist, n, V);
  let zv = zw(wp.xz); var zc = zcol(wp.xz);
  let ax = abs(wp.x); let az = abs(wp.z); let m = max(ax, az);
  let an = abs(n);
  let axy = an.y >= max(an.x, an.z); let axx = an.x >= an.z;
  let uv = select(select(vec2f(wp.x, wp.y), vec2f(wp.z, wp.y), axx), wp.xz, axy);
  let top = ss(.72, .9, n.y);
  let fineF = 1. - ss(35., 95., dist);
  let bigF = 1. - ss(110., 230., dist);
  let sa = select(select(3., 5., axx), 1., axy);
  var c1 = vec2f(0.); var c2 = vec2f(0.);
  if (dist < 95.) { c1 = circuit(uv, 2.1, sa, .35, foot); }
  if (dist < 230.) { c2 = circuit(uv + 17., .42, sa + 9., .6, foot); }
  // standard-cell rows: each cell a slightly different shade, gate fins up close
  let row = floor(uv.y * 1.3); let cid = floor(uv.x * 1.1 + h21(vec2f(row, 3.)) * 7.);
  var alb = vec3f(.016, .019, .028) * (.72 + .56 * h21(vec2f(cid, row)));
  let finK = (1. - ss(.12, .35, foot * 7.)) * top;
  alb *= 1. - .35 * finK * ss(.28, .4, abs(fract(uv.x * 7.) - .5)) * step(.3, h21(vec2f(cid + 9., row)));
  alb *= 1. - .5 * ss(.05, .0, abs(fract(uv.y * 1.3) - .5) - .45) * top;
  var rough = .34; var metal = .55;
  var k1 = .09; var k2 = .14; var p1 = 1.5; var p2 = 2.6;
  let tw = towerAt(wp.xz);
  let inT = tw.ok > .5 && wp.y > .3;
  let inHB = step(130., ax) * step(ax, 169.) * step(1.5, wp.y);
  var extra = vec3f(0.);
  // contact shadows: distance to the nearest big structure plus height above the floor
  var cd = 99.;
  let fy0 = max(wp.y + select(0., 1.6, m > 121.), 0.);
  if (tw.ok > .5) { cd = min(cd, max(max(abs(tw.ld.x), abs(tw.ld.y)) - 4.3, 0.) + fy0); }
  if (ax < 114. && az < 18.) { let dw = abs(fract(wp.x / 28.) - .5) * 28.; if (dw > 4.5) { cd = min(cd, max(abs(az - 14.8) - .9, 0.) + fy0); } }
  let gp = gpcAt(wp.xz);
  if (abs(gp.x) < 29. && abs(gp.y) < 29.) { let al = select(abs(gp.x), abs(gp.y), abs(gp.x) > abs(gp.y)); if (al > 5.) { cd = min(cd, max(abs(max(abs(gp.x), abs(gp.y)) - 27.) - .6, 0.) + fy0); } }
  if (ax > 124.) { let hz = abs(wp.z - clamp(round(wp.z / 80.) * 80., -80., 80.)); cd = min(cd, max(max(abs(ax - 150.) - 17.5, hz - 23.), 0.) + max(wp.y, 0.)); }
  if (m < 14.) { cd = min(cd, max(length(wp.xz) - 9., 0.) + fy0); }
  cd = min(cd, max(176. - m, 0.) + fy0 * 2.);
  let ao = mix(.3, 1., ss(0., 3.2, cd));
  if (m > 175.) { // package wall: dark copper strata
    zc = vec3f(1., .42, .12); alb = vec3f(.05, .028, .02); k1 = .05; p1 = .6; k2 = .09; p2 = 1.2; metal = .8;
  } else if (inHB > .5) { // HBM stack: dies, with glowing micro-bumps in the gaps between them
    let fy = fract(wp.y / 5.);
    let gap = ss(.58, .68, fy) * ss(.98, .9, fy);
    let dead = f32(wp.x > 0. && wp.z > 40.);
    let live = 1. - dead * .9;
    zc = C_HB; alb = vec3f(.03, .024, .02) * (1. - gap * .6);
    let bq = select(vec2f(wp.x, wp.y), vec2f(wp.z, wp.y), axx) * 3.4;
    let dt = ss(.3, .2, length(fract(bq) - .5));
    extra = C_HB * dt * gap * (1.2 + 2.2 * exp(-fract(g.clk.x * .5 + h21(floor(bq)) * 3.) * 5.)) * live;
    // each die: DRAM banks as a faint grid, a bright lip where it meets the gap
    let bank = ss(.06, .0, min(abs(fract(bq.x / 9.) - .5), abs(fract(fy * 1.6) - .5)) - .44);
    extra += C_HB * (1. - gap) * live * (.05 * (.5 + .5 * sin(wp.y * 2.4 - g.clk.x * 2.)) + bank * .25 + ss(.5, .58, fy) * .6);
    k1 = .05 * live; k2 = .08 * live; p1 *= live; p2 *= live;
  } else if (m > 121. && top > .5) { // interposer: micro-bump grid + amber traces
    zc = mix(zc, C_HB * .8, .6);
    let bq = wp.xz * 1.15;
    extra = C_HB * ss(.24, .16, length(fract(bq) - .5)) * .5 * (.6 + .4 * sin(g.clk.x * 3. + h21(floor(bq)) * 40.)) * fineF;
  } else if (m > 116.4 && top > .5) { // seal ring: guard-ring stripes
    extra = vec3f(.9, .75, .5) * ss(.1, .0, abs(fract(m * 2.2) - .5) - .38) * .5;
  } else if (inT) { // SM tower
    let dis = tw.on < .5;
    if (dis) { zc = vec3f(.5, .55, .6); k1 = .012; k2 = .02; p1 = .1; p2 = .2; alb *= .6; }
    if (n.y > .9 && top > .5) {
      let q = wp.xz * 1.45; let id = floor(q); let f = fract(q) - .5;
      let sq = ss(.36, .3, max(abs(f.x), abs(f.y)));
      let act = step(.35, h21(id + floor(g.clk.x * .5 + h21(id) * 5.) * 13.7)) * (.4 + .6 * exp(-fract(g.clk.x) * 3.5)) + .08;
      extra = C_SM * sq * act * select(2.4, .12, dis) * fineF;
    } else if (!dis) { // IO pads in a row along the foot of each face
      let pq = (uv.x + 100.) * 1.6; let pf = fract(pq) - .5;
      extra = C_SM * ss(.3, .2, abs(pf)) * ss(.45, .3, abs(wp.y - .55)) * (.4 + .6 * exp(-fract(g.clk.x + h21(vec2f(floor(pq), 1.))) * 3.)) * 1.4;
    }
  } else if (top > .5 && zv.y > .5) { // L2: bank borders; past the pillars' draw distance their tops become a glow
    let bl = min(abs(fract(wp.x / 14. + .5) - .5) * 14., abs(fract(abs(wp.z) / 11. + .5) - .5) * 11.);
    extra = C_L2 * ss(.14, .04, bl) * (.5 + .5 * sin(g.clk.x * 2. - wp.x * .05)) * .9;
    let inBank = f32((wp.x + 111.) % 14. < 12.4 && (az - 17.4) % 11. < 9.4 && az > 17.2 && az < 50.3 && ax > 2.2);
    let q = (fract(wp.x * .006 + g.clk.x * .035) - .5) * 14.;
    extra += C_L2 * (.16 + .6 * exp(-q * q)) * inBank * ss(66. * g.clk.w, 88. * g.clk.w, dist) * 1.6;
  } else if (top > .5 && zv.z > .5) { // crossbar canyon: bus lanes down the middle
    let dash = ss(.5, .35, abs(wp.z)) * step(.5, fract(wp.x * .12 - g.clk.x * .12));
    extra = C_XB * dash * 1.3;
    k2 = .22; p2 = 4.2;
  }
  let strata = .55 + .45 * h21(vec2f(floor(wp.y * 2.1), 7.)) * (1. - top);
  var emi = zc * (c1.x * k1 + c1.y * p1) * fineF * strata + zc * (c2.x * k2 + c2.y * p2) * bigF * strata + extra * fineF;
  emi *= mix(.5, 1., top);
  let c = lighting(alb, n, wp, rough, metal, zc) * ao + emi * (.55 + .45 * ao);
  return fin(fogC(c, wp));
}
`;

// ---------------------------------------------------------------- instanced blocks (cores, pillars, MAC cubes, caps, tiles, clock tree)
// instance: a = (x, y, z, yaw)  b = (sx, sy, sz, mat)  c = (r, g, b, mode + seed * .99)
const W_BLK = S_G + /*wgsl*/`
struct VI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) b: vec4f, @location(4) c: vec4f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) lp: vec3f,
  @location(3) @interpolate(flat) sz: vec3f, @location(4) @interpolate(flat) col: vec4f, @location(5) @interpolate(flat) mm: vec4f, @location(6) ax: f32 };
@vertex fn vs(i: VI) -> VO {
  var o: VO;
  let mode = floor(i.c.w); let seed = (i.c.w - mode) / .99;
  let t = g.cam.w; let clk = g.clk.x;
  var sc = i.b.xyz; var pos = i.a.xyz; var yaw = i.a.w;
  let ks = u32(seed * 65535.);
  var act = .3;
  if (mode < .5) { act = .3; }
  else if (mode < 1.5) { // SRAM bit pillar: height + glow follow the stored bit; a read wave sweeps the array
    let cy = clk + seed * 3.7; let cf = floor(cy); let fr = fract(cy);
    let b0 = step(.5, hf(ks + u32(cf) * 2654435u)); let b1 = step(.5, hf(ks + u32(cf + 1.) * 2654435u));
    let bt = mix(b0, b1, ss(.55, .95, fr));
    sc.y *= .42 + .58 * bt;
    let q = (fract(pos.x * .006 + clk * .035) - .5) * 14.;
    act = .12 + .55 * bt + exp(-q * q) * 1.4;
  } else if (mode < 2.5) { // execution core: busy or idle each cycle, flash on the clock edge
    let e = hf(ks + u32(floor(clk * .5 + seed * 5.)) * 7919u);
    act = step(.32, e) * (.35 + .65 * exp(-fract(clk) * 3.5)) + .05;
  } else if (mode < 3.5) { // tensor MAC: diagonal systolic wavefront
    let wf = fract((clk - seed * 16.) / 12.);
    act = .1 + 1.9 * exp(-wf * 9.);
  } else if (mode < 4.5) { // floating cache line
    pos.y += sin(t * .6 + seed * 31.) * .6; yaw += t * (seed - .5) * .8;
    act = .25 + .6 * exp(-fract(clk + seed) * 3.);
  } else if (mode < 5.5) { // breathing
    act = .35 + .3 * sin(t * .8 + seed * 40.) + .35 * exp(-fract(clk * .5 + seed) * 4.);
  } else if (mode < 6.5) { // wave travelling up
    act = .12 + 1.8 * exp(-fract(clk * .2 - pos.y * .045 + seed) * 6.);
  } else { // orbit around the vertical axis through the origin (thread blocks leaving the GigaThread engine)
    let a = t * (.1 + seed * .2) * select(1., -1., seed > .5);
    let ca = cos(a); let sa = sin(a);
    pos = vec3f(ca * pos.x - sa * pos.z, pos.y + sin(t * .7 + seed * 20.) * .5, sa * pos.x + ca * pos.z);
    yaw -= a;
    act = .3 + 1.1 * exp(-fract(clk * .5 + seed) * 4.);
  }
  let cy_ = cos(yaw); let sy_ = sin(yaw);
  let lv = i.p * sc;
  let w = pos + vec3f(cy_ * lv.x + sy_ * lv.z, lv.y, -sy_ * lv.x + cy_ * lv.z);
  o.cp = g.vp * vec4f(w, 1.); o.wp = w;
  o.n = vec3f(cy_ * i.n.x + sy_ * i.n.z, i.n.y, -sy_ * i.n.x + cy_ * i.n.z);
  o.lp = i.p + vec3f(.5, 0., .5); o.sz = sc;
  o.col = vec4f(i.c.rgb, act); o.mm = vec4f(i.b.w, mode, seed, 0.); o.ax = i.n.w;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let N = normalize(i.n); let wp = i.wp;
  let m = i32(i.mm.x + .5); let act = i.col.a; let col = i.col.rgb; let seed = i.mm.z;
  let zc = zcol(wp.xz);
  let vv = g.cam.xyz - wp; let dist = length(vv);
  var alb = vec3f(.02, .024, .034); var emi = vec3f(0.); var rough = .35; var metal = .4; var lite = false;
  let e = vec3f(min(i.lp.x, 1. - i.lp.x), min(i.lp.y, 1. - i.lp.y), min(i.lp.z, 1. - i.lp.z)) * i.sz;
  let ew = .05 + dist * .0012;
  let ex = ss(ew * 2., ew, e.x); let ey = ss(ew * 2., ew, e.y); let ez = ss(ew * 2., ew, e.z);
  let edge = sat(ex * ey + ey * ez + ex * ez);
  let topg = ss(.8, .97, N.y);
  let big = max(i.sz.x, i.sz.z) > 2.5;
  var c1 = vec2f(0.);
  if ((m == 0 || (m == 1 && big)) && dist < 80.) {
    let an = abs(N);
    let uv = select(select(vec2f(wp.x, wp.y), vec2f(wp.z, wp.y), an.x >= an.z), wp.xz, an.y >= max(an.x, an.z));
    c1 = circuit(uv, 1.6, seed * 9., .5, footOf(dist, N, vv / dist)) * (1. - ss(30., 80., dist));
  }
  if (m == 0) { // plate / body with routed traces
    emi = col * (c1.x * .12 + c1.y * 1.6 * (.4 + act)) + col * edge * act * .7;
  } else if (m == 1) { // core cell, slab, lamp
    let lane = select(1., .25 + .75 * sat(c1.x * 1.5 + c1.y * 3.), big);
    emi = col * (act * (.08 + 1.25 * topg * lane) + edge * act * 1.8 + .012);
    metal = .7; rough = .3; lite = !big && dist > 30.;
  } else if (m == 2) { // SRAM pillar
    emi = col * act * (.05 + 1.0 * ss(.78, 1., i.lp.y) * (1. - .55 * edge * topg)) + col * .008 * (1. - i.lp.y);
    lite = true;
  } else if (m == 3) { // MAC cube
    let gl = ss(.08, .0, abs(fract(i.lp.y * i.sz.y * 1.6) - .5) - .4) * .5;
    emi = col * (act * (.16 + edge * 2.8 + gl * .5 + .5 * topg) + .04);
    alb *= .5; rough = .2;
  } else if (m == 4) { // copper part (capacitor, pipe, fin, cap)
    alb = vec3f(.5, .21, .08); metal = 1.; rough = .3;
    emi = col * ss(.07, .0, abs(i.lp.y - .78)) * act * 2. * f32(i.sz.y > .6);
  } else if (m == 5) { // floating cache line: bright frame
    emi = col * (edge * (1.4 + act * 3.) + act * .05);
    alb *= .4; rough = .2;
  } else if (m == 6) { // clock tree: pulse travels from the trunk to the leaves
    emi = col * (.3 + 3. * exp(-fract(i.ax * 1.4 - g.clk.x * .22) * 6.));
    alb = vec3f(.05, .02, .04); metal = .8; rough = .3;
  } else { // data rod: pulses along its long axis
    let lax = select(select(i.lp.z * i.sz.z, i.lp.y * i.sz.y, i.sz.y >= i.sz.z), i.lp.x * i.sz.x, i.sz.x >= max(i.sz.y, i.sz.z));
    emi = col * (.25 + 3. * exp(-fract(lax * .35 - g.clk.x * .6 + seed) * 5.));
    alb *= .3; lite = true;
  }
  // contact shadow close to the floor for parts standing on it
  let h = i.lp.y * i.sz.y + max(wp.y - i.lp.y * i.sz.y - .9, 0.) * 4.;
  let ao = mix(.4, 1., ss(0., .9, h));
  var c: vec3f;
  if (lite) { c = lightingLite(alb, N, wp, zc); } else { c = lighting(alb, N, wp, rough, metal, zc); }
  c = c * ao + emi * (.6 + .4 * ao);
  return fin(fogC(c, wp));
}
`;

// ---------------------------------------------------------------- signal wires (the "kelp"): camera-facing ribbons, additive
// instance: a = (x, y0, z, height)  b = (seed, colour, speed (signed), width)
const W_WIRE = S_G + /*wgsl*/`
struct WO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) col: vec3f, @location(2) @interpolate(flat) pr: vec4f, @location(3) h: f32 };
fn pal(i: f32) -> vec3f {
  if (i < .5) { return C_SM; } if (i < 1.5) { return C_XB; } if (i < 2.5) { return C_L2; } if (i < 3.5) { return C_HB; } if (i < 4.5) { return C_PH; }
  return vec3f(1., .95, .8);
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> WO {
  var o: WO;
  let u = f32(vi & 1u) * 2. - 1.; let v = f32(vi >> 1u);
  let mid = vec3f(a.x, a.y + a.w * .5, a.z);
  let d = length(mid - g.cam.xyz);
  if (d > 190.) { o.cp = vec4f(0., 0., 2., 1.); return o; }
  let wd = max(b.w, d * .0014);
  let p = vec3f(a.x, a.y + v * a.w, a.z) + g.right.xyz * u * wd;
  o.cp = g.vp * vec4f(p, 1.); o.uv = vec2f(u, v);
  o.col = pal(b.y); o.pr = vec4f(b.x, b.z, a.w, min(1., b.w / wd)); o.h = d;
  return o;
}
@fragment fn fs(i: WO) -> @location(0) vec4f {
  let core = exp(-i.uv.x * i.uv.x * 3.2);
  let s = i.uv.y * i.pr.z;
  let pf = fract(s * .06 * sign(i.pr.y) - g.clk.x * abs(i.pr.y) * .35 + i.pr.x * 7.);
  let pu = exp(-pf * 8.) * ss(0., .05, pf);
  let pf2 = fract(s * .035 * sign(i.pr.y) - g.clk.x * abs(i.pr.y) * .22 + i.pr.x * 13.);
  let pu2 = exp(-pf2 * 12.) * .6;
  let base = .22 + .12 * sin(g.cam.w * .7 + i.pr.x * 40.);
  let e = base * (1. - ss(0., 6., s) * .4) + pu * 3.4 + pu2 * 1.4;
  let fade = ss(0., .02, i.uv.y) * ss(1., .985, i.uv.y);
  let c = i.col * core * e * fade * i.pr.w * exp(-i.h * .006) * 1.5;
  return vec4f(min(c, vec3f(10.)), 0.);
}
`;

// ---------------------------------------------------------------- warps: 32 threads flying in lockstep, sometimes diverging
// instance: a = (cx, cy, cz, R)  b = (warp seed, speed (signed), size, thread id)
const W_DART = S_G + /*wgsl*/`
struct VI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) b: vec4f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) @interpolate(flat) col: vec3f, @location(3) lx: f32 };
@vertex fn vs(i: VI) -> VO {
  var o: VO;
  let ws = i.b.x; let tid = i.b.w; let R = i.a.w; let clk = g.clk.x;
  let ta = clk * i.b.y * .55 + ws * TAU;
  let ph = ws * 17.;
  let P = i.a.xyz + vec3f(R * cos(ta), 2.5 * sin(3. * ta + ph), R * .6 * sin(ta));
  let T = normalize(vec3f(-R * sin(ta), 7.5 * cos(3. * ta + ph), R * .6 * cos(ta))) * sign(i.b.y);
  let S = normalize(cross(vec3f(0., 1., 0.), T)); let Up = cross(T, S);
  let col = tid % 8.; let row = floor(tid / 8.);
  let off = S * ((col - 3.5) * 1.2) + Up * ((row - 1.5) * 1.2);
  // branch divergence: every 6 cycles a warp may split into two groups, then reconverge
  let ev = floor(clk / 6.); let phs = fract(clk / 6.);
  let wk = u32(ws * 65535.);
  let doit = max(step(.5, hf(wk + u32(ev) * 2246822519u)), g.clk.z);
  let dv = mix(ss(.05, .25, phs) * ss(.8, .6, phs) * doit, 1., g.clk.z);
  let bit = step(.5, hf(u32(tid) * 7919u + u32(ev) * 131u + wk));
  let dsp = (S * 4.5 + Up * 2.6 - T * 4.) * dv * bit;
  var l = i.p * i.b.z * 2.8;
  l.z += sin(clk * 6. + tid * 3.) * .05;
  let w = P + off + dsp + T * l.x + Up * l.y + S * l.z;
  o.cp = g.vp * vec4f(w, 1.); o.wp = w;
  o.n = T * i.n.x + Up * i.n.y + S * i.n.z;
  o.col = mix(C_SM, C_HB * 1.2, dv * bit); o.lx = i.p.x;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let n = normalize(i.n);
  let V = normalize(g.cam.xyz - i.wp);
  let rim = pow(1. - abs(dot(n, V)), 2.);
  let c = i.col * (.9 + 2.2 * ss(-.1, .5, i.lx) + rim * 1.4) + lighting(vec3f(.05), n, i.wp, .3, .5, i.col) * .5;
  return fin(fogC(c, i.wp));
}
`;

// ---------------------------------------------------------------- data packets gliding along buses
// instance: a = (x0, y0, z0, L)  b = (axis 0 +x 1 -x 2 +z 3 -z, speed (m per cycle), size, colour + seed * .99)
const W_PKT = S_G + /*wgsl*/`
struct VI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) b: vec4f };
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f, @location(1) lp: vec3f, @location(2) @interpolate(flat) col: vec3f, @location(3) @interpolate(flat) fade: f32 };
fn pal(i: f32) -> vec3f {
  if (i < .5) { return C_XB; } if (i < 1.5) { return C_SM; } if (i < 2.5) { return C_L2 * 1.3; } if (i < 3.5) { return C_HB; } if (i < 4.5) { return C_PH; }
  return vec3f(1., .95, .8);
}
@vertex fn vs(i: VI) -> VO {
  var o: VO;
  let ci = floor(i.b.w); let seed = (i.b.w - ci) / .99;
  let axis = i32(i.b.x + .5);
  let L = i.a.w;
  let s = fract(g.clk.x * i.b.y / L + seed) * L;
  let sgn = select(1., -1., axis == 1 || axis == 3);
  let alongX = axis < 2;
  let dirv = select(vec3f(0., 0., sgn), vec3f(sgn, 0., 0.), alongX);
  let c = i.a.xyz + dirv * s;
  let sc = select(vec3f(1., .45, 3.4), vec3f(3.4, .45, 1.), alongX) * i.b.z;
  let w = c + vec3f(i.p.x * sc.x, i.p.y * sc.y, i.p.z * sc.z);
  o.cp = g.vp * vec4f(w, 1.); o.wp = w;
  o.lp = vec3f(select(i.p.z, i.p.x, alongX) * sgn + .5, i.p.y, 0.);
  o.col = pal(ci); o.fade = ss(0., 4., s) * ss(L, L - 4., s);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let head = ss(.1, 1., i.lp.x);
  let c = i.col * (.5 + 3.8 * head * head) * i.fade * (.7 + .3 * ss(0., .5, i.lp.y));
  return fin(fogC(c, i.wp));
}
`;

// ---------------------------------------------------------------- the lid (ceiling): copper underside with glowing apertures
const W_CEIL = S_G + /*wgsl*/`
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let p = vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.;
  o.wp = vec3f(g.cam.x + p.x * 700., CEIL, g.cam.z + p.y * 700.);
  o.cp = g.vp * vec4f(o.wp, 1.);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let wp = i.wp;
  let c = round(wp.xz / PITCH) * PITCH;
  let dd = length(wp.xz - c);
  let r = 2.7;
  let on = apOn(c) * (.8 + .2 * sin(g.cam.w * .35 + h21(c) * 30.));
  let hole = ss(r + .15, r - .15, dd);
  let rim = ss(r + 1.1, r + .2, dd) * (1. - hole);
  let pad = ss(.5, .38, length(fract(wp.xz / 3.2) - .5) * 1.5);
  var alb = vec3f(.12, .05, .025) * (.7 + .5 * pad) * (.6 + .4 * h21(floor(wp.xz / 3.2)));
  let V = normalize(g.cam.xyz - wp);
  let gq = abs(fract(wp.xz / PITCH) - .5) * PITCH;
  let bd = min(gq.x, gq.y);
  let beam = ss(1.1, .8, bd);
  let along = select(wp.z, wp.x, gq.y < gq.x);
  let lamp = beam * ss(.22, .1, length(vec2f((fract(along / 3.) - .5) * 3., bd)));
  alb = mix(alb, vec3f(.2, .09, .04), beam) * (1. - .6 * ss(.95, .8, bd) * ss(.65, .8, bd));
  var col = alb * (.08 + ap(vec3f(wp.x, CEIL - 3., wp.z)) * 3.) + vec3f(1., .6, .25) * lamp * 1.6;
  col += LCOL * hole * on * 9. + LCOL * rim * on * .5 + vec3f(.4, .2, .1) * rim * on;
  let dist = length(wp - g.cam.xyz);
  col *= exp(-dist * .0072);
  col += (vec3f(.012, .015, .028) + zcol(wp.xz) * .02) * (1. - exp(-dist * .0072)) * .8;
  return fin(col);
}
`;

// ---------------------------------------------------------------- sprites: rising heat motes (additive) and drifting electrons (additive)
const W_SPR = S_G + /*wgsl*/`
struct VO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) pr: vec4f, @location(2) @interpolate(flat) col: vec3f };
fn quad(i: u32) -> vec2f { return vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.; }
@vertex fn vsHeat(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> VO {
  var o: VO; let q = quad(vi); let t = g.cam.w;
  let life = fract(t * b.y / b.z + b.x);
  let h = life * b.z;
  var p = a.xyz + vec3f(0., h, 0.);
  p.x += sin(t * 1.3 + b.x * 50. + h * .5) * b.w * (.3 + h * .05);
  p.z += cos(t * 1.1 + b.x * 33. + h * .4) * b.w * (.3 + h * .05);
  let d = length(p - g.cam.xyz);
  if (d > 150.) { o.cp = vec4f(0., 0., 2., 1.); return o; }
  let sz = a.w * (.6 + .6 * life);
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * max(sz, d * .0022);
  o.cp = g.vp * vec4f(w, 1.); o.uv = q;
  o.pr = vec4f(ss(0., .08, life) * (1. - ss(.5, 1., life)) * min(1., sz / (d * .0022)), d, 0., 0.);
  o.col = mix(vec3f(1., .34, .05), vec3f(1., .72, .3), b.x);
  return o;
}
@fragment fn fsHeat(i: VO) -> @location(0) vec4f {
  let r = dot(i.uv, i.uv);
  let c = i.col * exp(-r * 4.) * (1. - ss(.7, 1., r)) * i.pr.x * 2.4 * exp(-i.pr.y * .01);
  return vec4f(min(c, vec3f(8.)), 0.);
}
@vertex fn vsEl(@builtin(vertex_index) vi: u32, @location(0) a: vec4f) -> VO {
  var o: VO; let q = quad(vi); let t = g.cam.w;
  let B = 48.;
  var p = a.xyz * B + vec3f(t * .35, t * .12, t * .2) + .5 * vec3f(sin(t * .3 + a.x * 60.), sin(t * .23 + a.y * 50.), cos(t * .27 + a.z * 70.));
  p = g.cam.xyz + (fract((p - g.cam.xyz) / B + .5) - .5) * B;
  let d = length(p - g.cam.xyz);
  let sz = .014 + .04 * a.w * a.w * a.w;
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * max(sz, d * .0011);
  o.cp = g.vp * vec4f(w, 1.); o.uv = q;
  let tw = .5 + .5 * sin(t * (1. + a.w * 2.5) + a.x * 100.);
  o.pr = vec4f(ss(B * .5, B * .3, d) * ss(.6, 2.5, d) * min(1., sz / (d * .0011)) * tw, d, 0., 0.);
  o.col = mix(C_XB, vec3f(.9, 1., .9), a.w) * (.5 + a.w);
  return o;
}
@fragment fn fsEl(i: VO) -> @location(0) vec4f {
  let r = length(i.uv);
  let m = ss(1., .15, r);
  return vec4f(min(i.col * m * m * i.pr.x * 1.1, vec3f(6.)), 0.);
}
`;

// ---------------------------------------------------------------- volumetric light shafts through the lid apertures (half res)
const W_RAYS = S_G + W_FS + /*wgsl*/`
@group(0) @binding(1) var tDp: texture_depth${AA > 1 ? '_multisampled' : ''}_2d;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dp = textureLoad(tDp, vec2i(fc.xy) * 2, 0);
  let uv = fc.xy * 2. * g.res.zw;
  let nd = vec2f(uv.x * 2. - 1., 1. - uv.y * 2.);
  let rv = g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w);
  let rl = length(rv); let rd = rv / rl;
  let zl = g.fwd.w / max(dp, 1e-6);
  var tm = min(zl * rl, 130.);
  if (rd.y > 1e-4) { tm = min(tm, (CEIL - g.cam.y) / rd.y); }
  let ro = g.cam.xyz;
  let dt = tm / ${RAYN}.;
  let j = ign(fc.xy);
  var acc = vec3f(0.);
  for (var n = 0; n < ${RAYN}; n++) {
    let t = (f32(n) + j) * dt;
    let p = ro + rd * t;
    let q = p.xz - LD.xz * ((CEIL - p.y) / -LD.y);
    let c = round(q / PITCH) * PITCH;
    let r = 2.2 + (CEIL - p.y) * .05;
    let d = length(q - c) / (r * 1.1);
    let dens = exp(-d * d * 1.8) * apOn(c) * (.8 + .2 * sin(g.cam.w * .35 + h21(c) * 30.));
    let mist = .018 * exp(-max(p.y, 0.) * .09);
    acc += vec3f((dens * (.55 + .45 * ss(0., 30., CEIL - p.y)) + mist) * exp(-t * .006));
  }
  acc *= mix(vec3f(1.), zcol((ro + rd * tm * .5).xz) * 1.5, .5);
  let mu = max(dot(rd, -LD), 0.);
  let ph = .3 + 1.6 * mu * mu * mu;
  return vec4f(min(acc * dt * .028 * LCOL * ph * g.mis.y, vec3f(20.)), zl);
}
`;
// depth-aware 3x3 blur of the half-res shafts (hides the sampling dither)
const W_RBLUR = W_FS + /*wgsl*/`
@group(0) @binding(0) var tR: texture_2d<f32>;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = vec2i(fc.xy); let mx = vec2i(textureDimensions(tR)) - 1;
  let c = textureLoad(tR, p, 0);
  var acc = vec3f(0.); var ws = 0.;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let r = textureLoad(tR, clamp(p + vec2i(x, y), vec2i(0), mx), 0);
    let w = 1. / (.03 + abs(r.a - c.a) / c.a);
    acc += r.rgb * w; ws += w;
  } }
  return vec4f(acc / ws, c.a);
}
`;

// ---------------------------------------------------------------- final composite
const W_POST = S_G + W_FS + /*wgsl*/`
@group(0) @binding(1) var sC: sampler;
@group(0) @binding(2) var tS: texture_2d<f32>;
@group(0) @binding(3) var tR: texture_2d<f32>;
@group(0) @binding(4) var tB: texture_2d<f32>;
@group(0) @binding(5) var tDp: texture_depth${AA > 1 ? '_multisampled' : ''}_2d;
fn sat3(x: vec3f) -> vec3f { return clamp(x, vec3f(0.), vec3f(1.)); }
fn tmap(x: vec3f) -> vec3f { return sat3((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14)); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy);
  let uv = fc.xy * g.res.zw;
  let zf = g.fwd.w / max(textureLoad(tDp, px, 0), 1e-6);
  let h = fc.xy * .5 - .5; let b = floor(h); let f = h - b; let bi = vec2i(b);
  let mx = vec2i(textureDimensions(tR)) - 1;
  var acc = vec3f(0.); var ws = 0.;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let r = textureLoad(tR, clamp(bi + o, vec2i(0), mx), 0);
    let bw = mix(1. - f.x, f.x, f32(o.x)) * mix(1. - f.y, f.y, f32(o.y));
    let w = (bw + .02) / (.02 + abs(r.a - zf) / zf);
    acc += r.rgb * w; ws += w;
  }
  var c = textureLoad(tS, px, 0).rgb + acc / ws;
  let bl = textureSampleLevel(tB, sC, uv, 0.).rgb;
  c = mix(c, bl, .05) + bl * .03;
  c *= g.mis.x;
  let q = uv - .5;
  c *= 1. - dot(q, q) * .7;
  c = tmap(c);
  let l0 = dot(c, vec3f(.2126, .7152, .0722));
  let l = mix(l0, l0 * l0 * (3. - 2. * l0), .45);
  c *= l / max(l0, 1e-4);
  c = pow(max(c, vec3f(0.)), vec3f(1. / 2.2));
  let n = ign(fc.xy) + ign(fc.xy + 37.) - 1.;
  return vec4f(c + n / 255., 1.);
}
`;
