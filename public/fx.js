// Efek suara (Web Audio, tanpa file audio) + confetti. Dipakai display.html dan index.html.
const fx = (() => {
  const AC = window.AudioContext || window.webkitAudioContext;
  const MUSIC_VOL = 0.14;
  let ctx = null, master = null, musicGain = null, noise = null;
  let muted = false, wantMusic = false, level = 1, timer = null, nextT = 0, bar = 0;
  try { muted = localStorage.getItem('quiz-muted') === '1'; } catch { /* storage tidak tersedia */ }

  const ensure = () => {
    if (!AC) return null;
    if (!ctx) {
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = muted ? 0 : 1; master.connect(ctx.destination);
      musicGain = ctx.createGain(); musicGain.gain.value = 0; musicGain.connect(master);
    }
    return ctx;
  };
  const ready = () => ctx && ctx.state === 'running' && !muted;

  const tone = (freq, t0, dur, { type = 'sine', vol = 0.2, dest = master, attack = 0.012, slide } = {}) => {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(dest);
    o.start(t0); o.stop(t0 + dur + 0.05);
  };

  // ---------- musik latar santai: C maj7 - A m7 - F maj7 - G6, 72 bpm ----------
  const BEAT = 60 / 72;
  const CHORDS = [
    { root: 65.41, pad: [261.63, 329.63, 392.0, 493.88] },
    { root: 55.0, pad: [220.0, 261.63, 329.63, 392.0] },
    { root: 87.31, pad: [174.61, 220.0, 261.63, 329.63] },
    { root: 98.0, pad: [196.0, 246.94, 293.66, 329.63] },
  ];
  const N = { C: 523.25, D: 587.33, E: 659.25, G: 783.99, A: 880.0 };
  const MELODY = [ // 8 langkah per bar, 0 = jeda
    [N.E, 0, N.G, 0, N.A, 0, N.G, 0],
    [N.A, 0, N.G, N.E, 0, 0, N.D, 0],
    [N.C, 0, N.E, 0, N.G, 0, N.E, 0],
    [N.D, 0, N.E, 0, N.G, 0, 0, 0],
  ];
  const scheduleBar = (t, i) => {
    const c = CHORDS[i], len = 4 * BEAT;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.connect(musicGain);
    c.pad.forEach((f, k) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f; o.detune.value = (k - 1.5) * 4;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.9);
      g.gain.setValueAtTime(0.18, t + len - 0.6);
      g.gain.linearRampToValueAtTime(0.0001, t + len + 0.5);
      o.connect(g); g.connect(lp); o.start(t); o.stop(t + len + 0.6);
    });
    [0, 2].forEach((b) => tone(c.root, t + b * BEAT, BEAT * 1.8, { vol: 0.5, dest: musicGain, attack: 0.03 }));
    MELODY[i].forEach((f, s) => { if (f) tone(f, t + s * BEAT / 2, 1.1, { type: 'triangle', vol: 0.35, dest: musicGain }); });
  };
  const sched = () => {
    while (nextT < ctx.currentTime + 1.2) { scheduleBar(nextT, bar++ % CHORDS.length); nextT += 4 * BEAT; }
  };
  const applyMusic = () => {
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (wantMusic) {
      musicGain.gain.setTargetAtTime(MUSIC_VOL * level, now, 0.4);
      if (!timer) { nextT = now + 0.1; timer = setInterval(sched, 300); sched(); }
    } else {
      musicGain.gain.setTargetAtTime(0, now, 0.4);
      if (timer) { clearInterval(timer); timer = null; }
    }
  };

  // ---------- efek ----------
  const sfx = (fn) => (...a) => { if (ready()) fn(ctx.currentTime, ...a); };
  const noiseBuf = () => {
    if (!noise) {
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noise;
  };

  const api = {
    supported: !!AC,
    unlock() {
      if (!ensure()) return;
      if (ctx.state === 'suspended') ctx.resume().then(applyMusic).catch(() => {});
      else applyMusic();
    },
    isMuted: () => muted,
    toggleMute() {
      muted = !muted;
      try { localStorage.setItem('quiz-muted', muted ? '1' : '0'); } catch { /* abaikan */ }
      if (ctx) master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
      return muted;
    },
    music(on) { wantMusic = on; applyMusic(); },
    level(x) { level = x; if (wantMusic) applyMusic(); },

    tick: sfx((t, soft) => tone(soft ? 520 : 760, t, 0.12, { type: 'square', vol: soft ? 0.05 : 0.11 })),
    go: sfx((t) => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * 0.07, 0.35, { type: 'triangle', vol: 0.22 }))),
    chime: sfx((t) => { tone(880, t, 0.5, { vol: 0.12 }); tone(1318.5, t + 0.08, 0.6, { vol: 0.09 }); }),
    correct: sfx((t) => { tone(659.25, t, 0.2, { type: 'triangle', vol: 0.25 }); tone(987.77, t + 0.12, 0.45, { type: 'triangle', vol: 0.25 }); }),
    wrong: sfx((t) => tone(240, t, 0.5, { type: 'sawtooth', vol: 0.1, slide: 120 })),
    buzz: sfx((t) => tone(880, t, 0.4, { vol: 0.25 })),
    pop: sfx((t) => tone(300, t, 0.25, { type: 'triangle', vol: 0.3, slide: 700 })),
    fanfare: sfx((t) => {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, t + i * 0.14, 0.4, { type: 'triangle', vol: 0.28 }));
      [523.25, 659.25, 783.99, 1046.5].forEach((f) => tone(f, t + 0.65, 1.4, { type: 'triangle', vol: 0.16, attack: 0.03 }));
    }),
    applause: sfx((t, dur = 2.6) => {
      const buf = noiseBuf();
      for (let i = 0; i < dur * 16; i++) {
        const at = t + i / 16 + Math.random() * 0.05;
        const shape = Math.sin(Math.PI * Math.min(1, (at - t) / dur));
        const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
        s.buffer = buf; f.type = 'bandpass'; f.frequency.value = 1200 + Math.random() * 1500; f.Q.value = 0.8;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.1 * shape + 0.005, at + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
        s.connect(f); f.connect(g); g.connect(master);
        s.start(at, Math.random() * 0.8, 0.1);
      }
    }),
  };

  // ---------- confetti ----------
  const COLORS = ['#ffd54f', '#e21b3c', '#1368ce', '#26890c', '#864cbf', '#ffffff', '#ff8a65'];
  let cv = null, parts = [], raf = 0, until = 0;
  api.confetti = ({ duration = 3500, count = 160 } = {}) => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (!cv) {
      cv = document.createElement('canvas');
      cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:50';
      document.body.appendChild(cv);
    }
    const W = cv.width = innerWidth, H = cv.height = innerHeight;
    const spawn = (n) => { for (let i = 0; i < n; i++) parts.push({
      x: Math.random() * W, y: -20 - Math.random() * H * 0.3, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4,
      w: 6 + Math.random() * 7, h: 10 + Math.random() * 8, r: Math.random() * 6, vr: (Math.random() - 0.5) * 0.3,
      c: COLORS[(Math.random() * COLORS.length) | 0] }); };
    spawn(count);
    until = Date.now() + duration;
    if (raf) return;
    const c = cv.getContext('2d');
    const frame = () => {
      c.clearRect(0, 0, cv.width, cv.height);
      if (Date.now() < until && parts.length < count * 2) spawn(3);
      parts = parts.filter((p) => p.y < cv.height + 30);
      for (const p of parts) {
        p.x += p.vx + Math.sin(p.r) * 0.8; p.y += p.vy; p.r += p.vr;
        c.save(); c.translate(p.x, p.y); c.rotate(p.r); c.fillStyle = p.c; c.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); c.restore();
      }
      if (parts.length) raf = requestAnimationFrame(frame); else { raf = 0; c.clearRect(0, 0, cv.width, cv.height); }
    };
    raf = requestAnimationFrame(frame);
  };
  return api;
})();
