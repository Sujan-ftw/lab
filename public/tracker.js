'use strict';
/**
 * Tracker: cursor-following motion widgets (no dependencies).
 *
 *   Tracker.field(canvas, opts)  A dot grid that swells, brightens and parts around the pointer, with a soft
 *                                glow and click ripples. When the pointer is away, a ghost cursor drifts so it never sits still.
 *   Tracker.deck(el)             A 3D stack of exam documents that tilts toward the pointer, with parallax depth and a
 *                                moving glare. Returns { mood('idle'|'look'|'shake'|'cheer') }.
 */
(function () {
  const reduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const ptr = { x: -1e4, y: -1e4, t: 0 };
  window.addEventListener('pointermove', e => { ptr.x = e.clientX; ptr.y = e.clientY; ptr.t = performance.now(); }, { passive: true });
  document.addEventListener('pointerleave', () => { ptr.t = 0; });

  /** Run fn(dt, now) each frame while el is connected and on screen. */
  function loop(el, fn) {
    let vis = true, last = performance.now(), raf = 0, live = true;
    const io = 'IntersectionObserver' in window ? new IntersectionObserver(es => { vis = es[0].isIntersecting; }) : null;
    if (io) io.observe(el);
    const tick = now => {
      if (!live) return;
      if (!el.isConnected) { live = false; if (io) io.disconnect(); return; }
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (vis && !document.hidden) fn(dt, now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { live = false; cancelAnimationFrame(raf); if (io) io.disconnect(); };
  }

  // ── Dot field ─────────────────────────────────────────────────────────
  function field(canvas, opts = {}) {
    const g = canvas.getContext('2d');
    const gap = opts.gap || 22, R = opts.radius || 130;
    const col = opts.color || [150, 230, 196];
    let W = 0, H = 0, dpr = 1, dots = [];
    const p = { x: 0, y: 0, vx: 0, vy: 0, on: 0 };
    const ripples = [];
    let t = Math.random() * 10;

    function size() {
      dpr = Math.min(2, devicePixelRatio || 1);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return false;
      if (Math.round(w * dpr) !== W || Math.round(h * dpr) !== H) {
        W = canvas.width = Math.round(w * dpr); H = canvas.height = Math.round(h * dpr);
        dots = [];
        const s = gap * dpr, ox = (W % s) / 2, oy = (H % s) / 2;
        for (let y = oy; y <= H; y += s) for (let x = ox; x <= W; x += s) dots.push({ x, y, ox: 0, oy: 0, a: 0 });
        p.x = W * 0.6; p.y = H * 0.5;
      }
      return true;
    }
    canvas.addEventListener('pointerdown', e => { const r = canvas.getBoundingClientRect(); ripple((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); });
    function ripple(fx, fy) { ripples.push({ x: fx * W, y: fy * H, r: 0 }); }

    function draw(dt, now) {
      if (!size()) return;
      t += dt;
      const r = canvas.getBoundingClientRect();
      const inside = ptr.t && now - ptr.t < 2600 && ptr.x > r.left - 60 && ptr.x < r.right + 60 && ptr.y > r.top - 60 && ptr.y < r.bottom + 60;
      // Target: the real pointer, or a slow ghost path when the pointer is away.
      const gx = W * (0.55 + 0.3 * Math.sin(t * 0.43) * Math.cos(t * 0.17)), gy = H * (0.5 + 0.32 * Math.sin(t * 0.61 + 1));
      const tx = inside ? (ptr.x - r.left) * dpr : gx, ty = inside ? (ptr.y - r.top) * dpr : gy;
      // Critically damped spring toward the target, so the glow trails the cursor smoothly.
      const k = 90, c = 2 * Math.sqrt(k);
      p.vx += ((tx - p.x) * k - p.vx * c) * dt; p.vy += ((ty - p.y) * k - p.vy * c) * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.on += ((inside ? 1 : 0.55) - p.on) * Math.min(1, dt * 3);
      for (const q of ripples) q.r += dt * 520 * dpr;
      while (ripples.length && ripples[0].r > Math.hypot(W, H)) ripples.shift();

      g.clearRect(0, 0, W, H);
      const RR = R * dpr;
      const glow = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, RR * 1.5);
      glow.addColorStop(0, `rgba(${col},${0.2 * p.on})`); glow.addColorStop(1, `rgba(${col},0)`);
      g.fillStyle = glow; g.fillRect(0, 0, W, H);

      const near = [];
      for (const d of dots) {
        const dx = d.x - p.x, dy = d.y - p.y, dist = Math.hypot(dx, dy) || 1;
        let f = Math.exp(-(dist * dist) / (RR * RR)) * p.on;
        for (const q of ripples) { const rd = Math.hypot(d.x - q.x, d.y - q.y) - q.r; f += Math.exp(-(rd * rd) / (400 * dpr * dpr)) * 0.8 * Math.max(0, 1 - q.r / (W * 0.9)); }
        const push = 12 * dpr * f;
        d.ox += ((dx / dist) * push - d.ox) * Math.min(1, dt * 10);
        d.oy += ((dy / dist) * push - d.oy) * Math.min(1, dt * 10);
        d.a += (f - d.a) * Math.min(1, dt * 8);
        const x = d.x + d.ox, y = d.y + d.oy;
        const shimmer = 0.06 * (1 + Math.sin(t * 1.3 + d.x * 0.013 + d.y * 0.02));
        g.fillStyle = `rgba(${col},${0.1 + shimmer + 0.75 * d.a})`;
        const s = (1 + 2.2 * d.a) * dpr;
        g.beginPath(); g.arc(x, y, s, 0, 6.283); g.fill();
        if (d.a > 0.35 && near.length < 14) near.push([x, y, d.a]);
      }
      // Faint threads from the cursor to the brightest nearby dots.
      g.lineWidth = dpr * 0.8;
      for (const [x, y, a] of near) { g.strokeStyle = `rgba(${col},${0.22 * a})`; g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(x, y); g.stroke(); }
      // Cursor ring
      g.strokeStyle = `rgba(${col},${0.5 * p.on})`; g.lineWidth = 1.2 * dpr;
      g.beginPath(); g.arc(p.x, p.y, (10 + 2 * Math.sin(t * 3)) * dpr, 0, 6.283); g.stroke();
      g.fillStyle = `rgba(235,255,245,${0.85 * p.on})`; g.beginPath(); g.arc(p.x, p.y, 2.2 * dpr, 0, 6.283); g.fill();
    }
    if (reduce()) { size(); t = 2; draw(0.016, 0); return { ripple() {} }; }
    loop(canvas, draw);
    return { ripple: (fx = 0.5, fy = 0.5) => ripple(fx, fy) };
  }

  // ── Document deck ─────────────────────────────────────────────────────
  const rows = [['1', 'Arun K', '24DI01'], ['2', 'Bala S', '24DI02'], ['3', 'Chitra M', '24DI03'], ['4', 'Divya R', '24DI04']];
  const sign = '<svg viewBox="0 0 40 12"><path d="M2 9c4-6 6-6 7-2s3 3 6-2 4 0 6 3 5-4 8-4 5 4 9 1"/></svg>';
  const CARDS = [
    { cls: 'marks', html: '<small>Scheme</small><b>Mark Allocation</b><div class="mk"><span>Aim &amp; procedure</span><i style="--w:70%"></i><span>Execution</span><i style="--w:92%"></i><span>Result</span><i style="--w:55%"></i><span>Viva voce</span><i style="--w:40%"></i></div><div class="tot">Total <em>100</em></div>' },
    { cls: 'qp', html: '<small>Semester exam</small><b>Question Paper</b><div class="ln" style="--w:90%"></div><div class="ln" style="--w:72%"></div><div class="q"><em>1.</em><div><div class="ln" style="--w:95%"></div><div class="ln" style="--w:60%"></div></div></div><div class="q"><em>2.</em><div><div class="ln" style="--w:88%"></div><div class="ln" style="--w:70%"></div></div></div><div class="q"><em>3.</em><div><div class="ln" style="--w:80%"></div></div></div>' },
    { cls: 'att', html: '<small>Batch A · 24DI</small><b>Attendance Sheet</b><table><tr><th>No</th><th>Name</th><th>Roll</th><th>Sign</th></tr>' + rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${sign}</td></tr>`).join('') + '</table><div class="ex"><span>Internal Examiner</span><span>External Examiner</span></div><div class="stamp">Ready ✓</div>' },
  ];
  // Rest and fanned poses, in card widths (x, y), degrees (r) and pixels of depth (z).
  const REST = [{ x: -0.36, y: -0.07, r: -9, z: -70 }, { x: 0.34, y: -0.11, r: 7, z: -35 }, { x: 0, y: 0.05, r: -2, z: 30 }];
  const FAN = [{ x: -0.62, y: -0.02, r: -15, z: -60 }, { x: 0.6, y: -0.05, r: 13, z: -30 }, { x: 0.02, y: 0.02, r: 0, z: 70 }];

  function deck(el) {
    el.innerHTML = '<div class="deck-wrap"><div class="deck">' + CARDS.map(c => `<div class="doc ${c.cls}"><div class="doc-in">${c.html}</div></div>`).join('') + '</div></div>';
    const wrap = el.querySelector('.deck-wrap'), dk = el.querySelector('.deck'), cards = [...el.querySelectorAll('.doc')];
    const s = { x: 0, y: 0, vx: 0, vy: 0, fan: 0, lift: 0, mood: 'idle' };
    let t = Math.random() * 10;
    function frame(dt, now) {
      t += dt;
      const r = el.getBoundingClientRect();
      const live = ptr.t && now - ptr.t < 3000;
      let tx, ty;
      if (s.mood === 'look') { tx = 0.75; ty = -0.05; } // turn toward the sign-in form
      else if (live) { tx = clamp((ptr.x - (r.left + r.width / 2)) / (r.width * 0.75), -1, 1); ty = clamp((ptr.y - (r.top + r.height / 2)) / (r.height * 0.75), -1, 1); }
      else { tx = 0.35 * Math.sin(t * 0.5); ty = 0.2 * Math.sin(t * 0.37 + 1); }
      const k = 60, c = 2 * Math.sqrt(k) * 0.8; // slightly under-damped: a soft overshoot feels physical
      s.vx += ((tx - s.x) * k - s.vx * c) * dt; s.vy += ((ty - s.y) * k - s.vy * c) * dt;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.fan += ((s.mood === 'look' || s.mood === 'cheer' ? 1 : 0) - s.fan) * Math.min(1, dt * 5);
      s.lift += ((s.mood === 'cheer' ? 1 : 0) - s.lift) * Math.min(1, dt * 6);
      dk.style.transform = `translateY(${-14 * s.lift}px) rotateX(${(-s.y * 14).toFixed(2)}deg) rotateY(${(s.x * 20).toFixed(2)}deg)`;
      const W = cards[0].offsetWidth;
      cards.forEach((cd, i) => {
        const a = REST[i], b = FAN[i], f = s.fan, bob = Math.sin(t * 1.1 + i * 2.1) * 4;
        const z = a.z + (b.z - a.z) * f;
        const x = (a.x + (b.x - a.x) * f) * W + s.x * z * 0.18, y = (a.y + (b.y - a.y) * f) * W + bob + s.y * z * 0.18;
        cd.style.transform = `translate(-50%,-50%) translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,${z.toFixed(1)}px) rotate(${(a.r + (b.r - a.r) * f).toFixed(2)}deg)`;
        cd.style.setProperty('--gx', (50 + s.x * 55).toFixed(1) + '%');
        cd.style.setProperty('--gy', (40 + s.y * 55).toFixed(1) + '%');
      });
    }
    if (reduce()) frame(0, 0); else loop(el, frame);
    return {
      mood(name) {
        s.mood = name;
        wrap.classList.toggle('shake', false);
        if (name === 'shake') { void wrap.offsetWidth; wrap.classList.toggle('shake', true); setTimeout(() => { if (s.mood === 'shake') s.mood = 'idle'; }, 600); }
        el.classList.toggle('ok', name === 'cheer');
        if (reduce()) frame(0, 0);
      },
    };
  }

  window.Tracker = { field, deck };
})();
