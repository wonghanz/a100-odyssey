// ============================================================================
// audio: procedural machine ambience (no sample files)
// ============================================================================
// A fixed Web Audio graph, built on the first click / key / touch and driven by a 10 Hz timer, not the frame loop.
// Layers: sub rumble, a power-supply hum, fan noise (follows camera speed), clock ticks (follow the chip clock, silent
// when it is frozen), and data chirps (denser near the SMs and the tensor core).
let AC, OUT, muted = false;
const VOL = 0.7;
function mkSound(ac) {
  const sr = ac.sampleRate;
  const N = (C, o, ...to) => { const n = new C(ac, o); for (const d of to) n.connect(d); if (n.start) n.start(); return n; };
  const G = (gain, ...to) => N(GainNode, { gain }, ...to);
  const BQ = (type, frequency, Q, ...to) => N(BiquadFilterNode, { type, frequency, Q }, ...to);
  const lfo = (frequency, depth, to) => N(OscillatorNode, { frequency }, G(depth, to));
  const noise = (secs, f) => { const n = sr * secs | 0, b = new AudioBuffer({ length: n, numberOfChannels: 2, sampleRate: sr }); f(b.getChannelData(0), n); f(b.getChannelData(1), n); return b; };
  const nb = noise(7, (d, n) => { for (let i = 0, b = 0; i < n + 4096; i++) { b = (b + 0.02 * (rnd() * 2 - 1)) / 1.02; if (i < n) d[i] = b * 3.5; else { const k = (i - n) / 4096; d[i - n] = d[i - n] * k + b * 3.5 * (1 - k); } } });
  const ir = noise(3, (d, n) => { for (let i = 0, b = 0; i < n; i++) { const t = i / sr; b += (rnd() * 2 - 1 - b) * (0.05 + 0.5 * exp(-t * 3)); d[i] = b * (1 - exp(-t * 40)) * exp(-t * 2.2) * (1 - i / n); } });
  const lim = N(DynamicsCompressorNode, { threshold: -6, knee: 6, ratio: 20, attack: 0.003, release: 0.3 }, ac.destination);
  const out = OUT = G(0, lim), wet = N(ConvolverNode, { buffer: ir }, out);
  const src = (playbackRate, ...to) => N(AudioBufferSourceNode, { buffer: nb, loop: true, playbackRate }, ...to);
  // sub rumble
  const rum = G(0.3, out); src(1, BQ('lowpass', 120, 0.7, rum)); lfo(0.06, 0.1, rum.gain);
  // power hum: a low fifth with a slow beat, 50 Hz-ish like transformers
  const hum = G(1, out, G(0.8, wet));
  [[55, 0.05], [82.5, 0.022], [110.4, 0.016], [165, 0.008]].forEach(([f, v]) => { const g = G(v, hum); N(OscillatorNode, { frequency: f, type: 'sawtooth' }, BQ('lowpass', 260, 0.6, g)); N(OscillatorNode, { frequency: f * 1.004 }, g); });
  // fan / airflow noise: follows camera speed
  const fan = G(0.05, out), fanF = BQ('bandpass', 700, 0.6, fan); src(0.9, fanF);
  // pooled voices: oscillator -> envelope -> pan -> dry + reverb
  const pool = (n, send, type) => Array.from({ length: n }, () => { const p = N(StereoPannerNode, {}, out, G(send, wet)), g = G(0, p); return { p, g, o: N(OscillatorNode, { type }, g) }; });
  const tick = pool(6, 0.15, 'square'), chirp = pool(5, 0.6, 'sine');
  const play = (vs, t, f0, f1, dur, vol, att, pan) => {
    const v = vs.shift(), f = v.o.frequency, g = v.g.gain; vs.push(v);
    v.p.pan.setValueAtTime(pan, t);
    f.setValueAtTime(f0, t); f.exponentialRampToValueAtTime(f1, t + dur);
    g.setValueAtTime(0, t); g.linearRampToValueAtTime(vol, t + att); g.setTargetAtTime(0, t + att, (dur - att) / 5);
  };
  const NOTES = [0, 2, 4, 7, 9, 12, 14, 16, 19]; // major pentatonic, semitones above A4
  let lt = ac.currentTime, tC = lt + 3, lx = F[CX], ly = F[CY], lz = F[CZ], lastCycle = floor(F[CLK]);
  out.gain.setTargetAtTime(VOL, lt, 1);
  return () => {
    const now = ac.currentTime, t = now + 0.05, dt = now - lt;
    if (dt <= 0) return;
    let v = hypot(F[CX] - lx, F[CY] - ly, F[CZ] - lz) / dt; if (v > 60) v = 0;
    lt = now; lx = F[CX]; ly = F[CY]; lz = F[CZ];
    fan.gain.setTargetAtTime(0.04 + 0.4 * pow(min(v / 26, 1), 1.3), t, 0.3); fanF.frequency.setTargetAtTime(500 + v * 30, t, 0.3);
    // clock ticks: one click per cycle crossed since the last look (at most 3, spread over this 100 ms slice)
    const cyc = floor(F[CLK]), n = min(cyc - lastCycle, 3); lastCycle = cyc;
    for (let i = 0; i < n; i++) play(tick, t + i * 0.03, 1900, 1100, 0.035, 0.018, 0.002, rr(-0.2, 0.2));
    // data chirps: more of them close to the SM and the tensor core
    const d = min(hypot(F[CX] - SMX, F[CZ] - SMZ), hypot(F[CX] - TCX, F[CZ] - TCZ));
    if (!F[FRZ] && t > tC) {
      const f = 440 * pow(2, NOTES[rnd() * 9 | 0] / 12);
      play(chirp, t, f, f * rr(0.9, 1.5), 0.25, rr(0.01, 0.03), 0.01, rr(-0.8, 0.8));
      tC = t + rr(0.15, 1.3) * (0.6 + min(d, 120) / 40) / min(F[FREQ] + 0.4, 3);
    }
  };
}
// called on every click / key / touch: builds the graph once and resumes it when the browser allows
function sound() {
  if (!AC) { AC = new AudioContext({ latencyHint: 'playback' }); setInterval(mkSound(AC), 100); }
  if (AC.state === 'suspended' && !document.hidden) AC.resume();
}
const mute = () => { if (!AC) return; muted = !muted; OUT.gain.setTargetAtTime(muted ? 0 : VOL, AC.currentTime, 0.08); };
document.addEventListener('visibilitychange', () => { if (AC) document.hidden ? AC.suspend() : AC.resume(); });
