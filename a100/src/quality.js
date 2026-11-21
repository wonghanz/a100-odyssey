// ============================================================================
// quality level, chosen before anything is built
// ============================================================================
// LV: 0 High, 1 Medium, 2 Low. Medium and Low keep every 2nd / 4th wire, pillar and mote, and Low also drops
// anti-aliasing and uses fewer light-shaft steps.
// localStorage.a100 = "level,pixels,detail". a100Load is set while the world is built: still set on the next visit
// means that load crashed the tab, so this one runs a level lower.
const mob = matchMedia('(pointer:coarse)').matches, mem = navigator.deviceMemory;
const keep = (k, v) => { try { localStorage[k] = v; } catch {} };
let SV = [], LV, bad;
try { SV = (localStorage.a100 || '').split(','); bad = localStorage.a100Load; } catch {}
LV = SV[0] ? +SV[0] : mob ? (mem > 7 ? 1 : 2) : mem <= 4 ? 2 : 0;
if (bad && LV < 2) { SV = [++LV]; keep('a100', LV); }
const THIN = 1 << LV, AA = LV > 1 ? 1 : 4, RAYN = LV > 1 ? 11 : 20;
