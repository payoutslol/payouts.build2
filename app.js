(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const clamp01 = (t) => Math.max(0, Math.min(1, t));
  const lerp = (a, b, t) => a + (b - a) * t;
  const DEG = Math.PI / 180;

  const topbar = $(".topbar");
  const brandName = $(".brand-name");
  const intro = $("#intro");

  /* ============================================================
   * Landing intro: dotted globe, connection arc, status bar
   * ============================================================ */
  const ORIGIN = [-46.63, -23.55]; // [lon, lat] start of the route (São Paulo)
  const TARGET = [-74.006, 40.713]; // where it "lands" (New York)
  const DECOYS = [[-71.06, 42.36], [-77.04, 38.9]];
  const T_ZOOMOUT = 1.4, T_ARC0 = 1.8, T_ARC1 = 4.0, T_PROTECT = 4.2, T_END = 5.4;

  const canvas = $("#globe");
  const ctx = canvas.getContext("2d");
  const marker = $("#enter-marker");
  const ro = { kicker: $("#ro-kicker"), big: $("#ro-big"), sub: $("#ro-sub"), hash: $("#ro-hash") };

  let dots = null;     // Float32Array [cosφ, sinφ, λ, ...]
  let W = 0, H = 0, DPR = 1;
  let startTime = 0, offset = 0, running = false, finished = false, protectedState = false;
  let scrambleTimer = 0;

  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  }

  async function buildDots() {
    const topo = await fetch("https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json").then((r) => r.json());
    const land = topojson.feature(topo, topo.objects.land);
    const mw = 1440, mh = 720;
    const off = document.createElement("canvas");
    off.width = mw; off.height = mh;
    const octx = off.getContext("2d", { willReadFrequently: true });
    const proj = d3.geoEquirectangular().scale(mw / (2 * Math.PI)).translate([mw / 2, mh / 2]);
    octx.fillStyle = "#fff";
    octx.beginPath(); d3.geoPath(proj, octx)(land); octx.fill();
    const px = octx.getImageData(0, 0, mw, mh).data;

    const out = [];
    const step = 0.8;
    for (let lat = -84; lat <= 84; lat += step) {
      const n = Math.max(1, Math.round((360 * Math.cos(lat * DEG)) / step));
      for (let i = 0; i < n; i++) {
        const lon = -180 + (i * 360) / n;
        const x = Math.floor(((lon + 180) / 360) * mw);
        const y = Math.floor(((90 - lat) / 180) * mh);
        if (px[(y * mw + x) * 4 + 3] > 0) out.push(Math.cos(lat * DEG), Math.sin(lat * DEG), lon * DEG);
      }
    }
    dots = new Float32Array(out);
  }

  // Orthographic projection of [lon,lat] (deg) at altitude h onto screen.
  function project(lon, lat, cam, h = 0) {
    const l = lon * DEG, p = lat * DEG;
    const cp = Math.cos(p), sp = Math.sin(p), dl = l - cam.l0;
    const cosc = cam.sp0 * sp + cam.cp0 * cp * Math.cos(dl);
    const k = cam.R * (1 + h);
    const x = cam.cx + k * cp * Math.sin(dl);
    const y = cam.cy - k * (cam.cp0 * sp - cam.sp0 * cp * Math.cos(dl));
    const vis = cosc > 0 || Math.hypot(x - cam.cx, y - cam.cy) > cam.R;
    return { x, y, vis, cosc };
  }

  function camera(t) {
    const base = Math.min(W, H);
    let center, R;
    const geo = d3.geoInterpolate(ORIGIN, TARGET);
    if (t < T_ZOOMOUT) {
      center = ORIGIN; R = lerp(2.6, 2.2, t / T_ZOOMOUT) * base;
    } else if (t < T_ARC1) {
      const k = ease(clamp01((t - T_ZOOMOUT) / (T_ARC1 - T_ZOOMOUT)));
      center = geo(k);
      const zo = ease(clamp01((t - T_ZOOMOUT) / 1.4));
      R = lerp(2.2 * base, 0.46 * base, zo);
    } else {
      const k = ease(clamp01((t - T_ARC1) / (T_END - T_ARC1)));
      center = [TARGET[0], TARGET[1] + 6 * k];
      R = lerp(0.46 * base, 1.35 * base, k);
    }
    // gentle idle drift once settled
    if (t > T_END) center = [center[0] + Math.sin((t - T_END) * 0.25) * 1.5, center[1]];
    const p0 = center[1] * DEG;
    return { l0: center[0] * DEG, sp0: Math.sin(p0), cp0: Math.cos(p0), R, cx: W / 2, cy: H * 0.46 };
  }

  function draw(t) {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cam = camera(t);
    const accent = protectedState ? [70, 180, 80] : [255, 255, 255];

    // sphere glow
    const g = ctx.createRadialGradient(cam.cx, cam.cy, cam.R * 0.2, cam.cx, cam.cy, cam.R * 1.08);
    g.addColorStop(0, "rgba(255,255,255,0.035)");
    g.addColorStop(0.92, "rgba(255,255,255,0.015)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cam.cx, cam.cy, cam.R * 1.08, 0, Math.PI * 2); ctx.fill();

    // land dots, bucketed by depth for shading
    if (dots) {
      const r = Math.max(0.7, cam.R * 0.003);
      const buckets = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
      const { l0, sp0, cp0, R, cx, cy } = cam;
      for (let i = 0; i < dots.length; i += 3) {
        const cp = dots[i], sp = dots[i + 1], dl = dots[i + 2] - l0;
        const cdl = Math.cos(dl);
        const cosc = sp0 * sp + cp0 * cp * cdl;
        if (cosc <= 0.1) continue;
        const x = cx + R * cp * Math.sin(dl);
        const y = cy - R * (cp0 * sp - sp0 * cp * cdl);
        if (x < -r || y < -r || x > W + r || y > H + r) continue;
        const b = buckets[Math.min(3, (cosc * 4) | 0)];
        b.moveTo(x + r, y); b.arc(x, y, r, 0, Math.PI * 2);
      }
      const alphas = [0.1, 0.26, 0.48, 0.75];
      buckets.forEach((b, i) => { ctx.fillStyle = `rgba(235,235,235,${alphas[i]})`; ctx.fill(b); });
    }

    // connection arc
    const arcP = ease(clamp01((t - T_ARC0) / (T_ARC1 - T_ARC0)));
    if (arcP > 0) {
      const gi = d3.geoInterpolate(ORIGIN, TARGET);
      // bend the great circle sideways so the route sweeps instead of running straight
      const geo = (f) => { const [lon, lat] = gi(f); const s = Math.sin(Math.PI * f); return [lon + 26 * s * (1 - f * 0.4), lat + 4 * s]; };
      const N = 120, upto = Math.max(2, Math.round(N * arcP));
      ctx.lineWidth = Math.max(1.5, cam.R * 0.004);
      ctx.lineCap = "round";
      ctx.strokeStyle = `rgba(${accent},0.9)`;
      ctx.shadowColor = `rgba(${accent},0.8)`;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      let pen = false, head = null;
      for (let i = 0; i <= upto; i++) {
        const f = i / N;
        const [lon, lat] = geo(f);
        const p = project(lon, lat, cam, 0.26 * Math.sin(Math.PI * f));
        if (p.vis) { pen ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); pen = true; head = p; } else pen = false;
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      // waypoints along the route
      ctx.fillStyle = `rgba(${accent},1)`;
      for (let i = 1; i < 8; i++) {
        const f = i / 8;
        if (f > arcP) break;
        const [lon, lat] = geo(f);
        const p = project(lon, lat, cam, 0.26 * Math.sin(Math.PI * f));
        if (p.vis) { ctx.beginPath(); ctx.arc(p.x, p.y, ctx.lineWidth * 1.6, 0, Math.PI * 2); ctx.fill(); }
      }
      if (head && arcP < 1) { ctx.beginPath(); ctx.arc(head.x, head.y, ctx.lineWidth * 2.6, 0, Math.PI * 2); ctx.fill(); }
    }

    // decoy markers + target
    if (protectedState) {
      ctx.fillStyle = "rgba(70,180,80,0.9)";
      DECOYS.forEach(([lon, lat]) => {
        const p = project(lon, lat, cam);
        if (!p.cosc || p.cosc <= 0) return;
        const s = 6;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.PI / 4); ctx.fillRect(-s / 2, -s / 2, s, s); ctx.restore();
      });
    }
    const tp = project(TARGET[0], TARGET[1], cam);
    marker.style.transform = `translate(${tp.x}px, ${tp.y}px) scale(${marker.classList.contains("show") ? 1 : 0.6})`;
  }

  const CH = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
  const rnd = (n, set = CH) => Array.from({ length: n }, () => set[(Math.random() * set.length) | 0]).join("");
  function scramble() {
    ro.big.textContent = rnd(2);
    ro.sub.textContent = rnd(16, CH + "abcdefghijkmnopqrstuvwxyz");
    ro.hash.textContent = "c0" + rnd(10, "0123456789abcdef");
  }

  function setConnecting() {
    protectedState = false;
    topbar.dataset.state = "connecting";
    intro.classList.remove("protected");
    ro.kicker.textContent = "Creating secure connection";
    marker.classList.remove("show");
    clearInterval(scrambleTimer);
    scramble();
    scrambleTimer = setInterval(scramble, 80);
  }

  function setProtected() {
    if (protectedState) return;
    protectedState = true;
    clearInterval(scrambleTimer);
    topbar.dataset.state = "protected";
    intro.classList.add("protected");
    ro.kicker.textContent = "Protected";
    ro.big.textContent = "Payouts";
    ro.sub.textContent = "Location hidden";
    ro.hash.textContent = "us-nyc-payouts-202";
  }

  function frame(now) {
    if (!running) return;
    const t = (now - startTime) / 1000 + offset;
    if (t >= T_PROTECT) setProtected();
    if (t >= T_END && !finished) { finished = true; marker.classList.add("show"); }
    draw(t);
    requestAnimationFrame(frame);
  }

  function startIntro() {
    document.body.dataset.stage = "intro";
    brandName.textContent = brandName.dataset.intro;
    window.scrollTo(0, 0);
    finished = false; offset = 0;
    setConnecting();
    startTime = performance.now();
    if (!running) { running = true; requestAnimationFrame(frame); }
  }

  function skip() { offset = T_END + 0.01 - (performance.now() - startTime) / 1000; }

  function enter() {
    if (document.body.dataset.stage === "main") return;
    document.body.dataset.stage = "main";
    topbar.dataset.state = "entered";
    brandName.textContent = brandName.dataset.main;
    clearInterval(scrambleTimer);
    setTimeout(() => { if (document.body.dataset.stage === "main") running = false; }, 1000);
    startMusic(); // runs inside the click/key gesture, so the browser allows sound
  }

  function onIntroInput(e) {
    if (document.body.dataset.stage !== "intro") return;
    if (e.type === "keydown" && (e.metaKey || e.ctrlKey || e.altKey || e.key === "Tab")) return;
    if (e.target.closest && e.target.closest(".topbar-actions")) return;
    finished ? enter() : skip();
  }
  window.addEventListener("pointerdown", onIntroInput);
  window.addEventListener("keydown", onIntroInput);
  window.addEventListener("resize", resize);

  resize();
  startIntro();
  buildDots().catch((err) => console.warn("Globe data failed to load", err));

  /* ============================================================
   * Header, hero, settings, cursor
   * ============================================================ */
  const hero = $(".hero-inner");
  const haze = $("#bg-haze");
  const bgVideoEl = $("#bg-video");
  function onScroll() {
    const y = window.scrollY;
    topbar.classList.toggle("scrolled", y > 8);
    const k = clamp01(y / (window.innerHeight * 0.55));
    hero.style.opacity = String(1 - k * 0.85);
    hero.style.transform = `translateY(${-k * 40}px)`;
    // background video hazes over as you scroll past the hero:
    // tint fades in smoothly, the blur switches on once past ~30%
    const h = clamp01(y / (window.innerHeight * 0.7));
    haze.style.opacity = String(h);
    bgVideoEl.classList.toggle("hazed", h > 0.3);
  }
  onScroll();
  // one scroll handler per frame (instead of on every scroll event)
  let scrollQueued = false;
  window.addEventListener("scroll", () => {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => { scrollQueued = false; onScroll(); updateNav(); });
  }, { passive: true });

  // Header nav: highlight the section currently in view
  const navLinks = [...document.querySelectorAll(".site-nav a")];
  const navSections = navLinks.map((a) => document.getElementById(a.dataset.section));
  function updateNav() {
    const line = window.innerHeight * 0.4;
    const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    let current = null;
    navSections.forEach((s) => { if (s && s.getBoundingClientRect().top <= line) current = s.id; });
    if (atBottom) current = navSections[navSections.length - 1]?.id;
    navLinks.forEach((a) => {
      const on = a.dataset.section === current;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
    });
  }
  window.addEventListener("resize", updateNav);
  updateNav();

  const settingsBtn = $("#settings-btn"), settingsMenu = $("#settings-menu");
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = settingsMenu.hidden;
    settingsMenu.hidden = !open;
    settingsBtn.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".settings")) { settingsMenu.hidden = true; settingsBtn.setAttribute("aria-expanded", "false"); } });
  $("#opt-replay").addEventListener("click", () => { settingsMenu.hidden = true; startIntro(); });

  const cursorEl = $(".cursor"), ring = $(".cursor-ring"), dot = $(".cursor-dot");
  const fine = window.matchMedia("(pointer: fine)").matches;
  const optCursor = $("#opt-cursor");
  const cursorPref = store.get("c8-cursor");
  optCursor.checked = cursorPref !== false;
  const applyCursor = () => document.documentElement.classList.toggle("has-cursor", fine && optCursor.checked);
  optCursor.addEventListener("change", () => { store.set("c8-cursor", optCursor.checked); applyCursor(); });
  applyCursor();
  if (fine) {
    let mx = -100, my = -100, rx = -100, ry = -100, looping = false;
    // ring eases toward the pointer; the loop only runs while it's catching up
    function loop() {
      rx += (mx - rx) * 0.2; ry += (my - ry) * 0.2;
      ring.style.transform = `translate(${rx}px, ${ry}px)`;
      if (Math.abs(mx - rx) + Math.abs(my - ry) > 0.3) requestAnimationFrame(loop);
      else looping = false;
    }
    window.addEventListener("pointermove", (e) => {
      mx = e.clientX; my = e.clientY;
      dot.style.transform = `translate(${mx}px, ${my}px)`;
      cursorEl.classList.toggle("hover", !!e.target.closest("a, button, label, .game-card"));
      if (!looping) { looping = true; requestAnimationFrame(loop); }
    });
  }

  const toastEl = $("#toast");
  let toastTimer = 0;
  function toast(msg) {
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  // Header pill: combined live CCU across all listed games (set by the game loader below).
  const ccuEl = $("#online-count");
  let ccuShown = 0;
  function setCCU(total) { tween(ccuEl, ccuShown, total, (n) => full.format(n)); ccuShown = total; }
  // Header pill: combined total visits across all listed games.
  const visitsEl = $("#visits-count");
  let visitsShown = 0;
  function setVisits() {
    const total = [...cards.values()].reduce((s, e) => s + (e.values.visits || 0), 0);
    tween(visitsEl, visitsShown, total, (n) => compact.format(n));
    visitsShown = total;
    sub.textContent += ` · ${compact.format(total)} visits`;
  }

  /* ============================================================
   * Roblox game cards with live stats
   * Roblox's APIs don't allow browser requests, so we go through
   * RoProxy (a public mirror of the same endpoints that does).
   * ============================================================ */
  const API = {
    universe: (placeId) => `https://apis.roproxy.com/universes/v1/places/${placeId}/universe`,
    games: (ids) => `https://games.roproxy.com/v1/games?universeIds=${ids.join(",")}`,
    icons: (ids) => `https://thumbnails.roproxy.com/v1/games/icons?universeIds=${ids.join(",")}&returnPolicy=PlaceHolder&size=256x256&format=Png&isCircular=false`,
    thumbs: (ids) => `https://thumbnails.roproxy.com/v1/games/multiget/thumbnails?universeIds=${ids.join(",")}&countPerUniverse=1&defaults=true&size=768x432&format=Png&isCircular=false`,
  };
  const grid = $("#game-grid");
  const sub = $("#games-sub");
  const config = (window.C8_GAMES || []).filter((g) => g && g.placeId);
  const refreshMs = Math.max(10, window.C8_REFRESH_SECONDS || 30) * 1000;
  const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
  const full = new Intl.NumberFormat("en");
  const cards = new Map(); // universeId -> { el, values }

  async function getJSON(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  async function resolveUniverses() {
    const cache = store.get("c8-universes") || {};
    const ids = await Promise.all(config.map(async (g) => {
      if (cache[g.placeId]) return cache[g.placeId];
      try {
        const j = await getJSON(API.universe(g.placeId));
        cache[g.placeId] = j.universeId;
        return j.universeId;
      } catch { return null; }
    }));
    store.set("c8-universes", cache);
    return ids;
  }

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  function timeAgo(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (!isFinite(s)) return "";
    const units = [["y", 31536000], ["mo", 2592000], ["d", 86400], ["h", 3600], ["m", 60]];
    for (const [u, v] of units) if (s >= v) return `${Math.floor(s / v)}${u} ago`;
    return "just now";
  }

  const ICON = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 17 17 7M8 7h9v9"/></svg>',
    verified: '<svg class="verified" viewBox="0 0 28 28" role="img" aria-label="Verified"><rect x="5.888" width="22.89" height="22.89" transform="rotate(15 5.888 0)" fill="#0066FF"/><path fill-rule="evenodd" d="M20.543 8.751l.006.006a1.537 1.537 0 0 1 0 2.176l-8.732 8.732-4.367-4.368a1.537 1.537 0 0 1 0-2.175l.007-.007a1.537 1.537 0 0 1 2.176 0l2.184 2.185 6.55-6.549a1.537 1.537 0 0 1 2.176 0z" fill="#fff"/></svg>',
  };

  function skeletons(n) {
    grid.innerHTML = Array.from({ length: n }, () => `
      <article class="game-card loading">
        <div class="banner"></div>
        <div class="card-body">
          <div class="icon-wrap"><div class="game-icon"></div></div>
          <span class="skel" style="width:60%;margin-top:16px;height:16px"></span>
          <span class="skel" style="width:35%;margin-top:8px"></span>
          <div class="stats"><span class="skel" style="height:44px"></span><span class="skel" style="height:44px"></span><span class="skel" style="height:44px"></span></div>
        </div>
      </article>`).join("");
  }

  // Role tag shown on each card: label -> style key + icon
  const ROLES = {
    "environment art": { key: "env", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="m3 20 6-10 4 6 3-4 5 8z"/><circle cx="17" cy="6" r="2"/></svg>' },
    "qa": { key: "qa", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>' },
    "pm & moderation": { key: "pm", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.8c1.7.8 2.7 2.5 3 5.2"/></svg>' },
    "private": { key: "private", icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>' },
  };
  function roleTag(role) {
    if (!role) return "";
    const r = ROLES[String(role).toLowerCase()] || { key: "other", icon: "" };
    const tip = r.key === "private" ? ` title="Role not disclosed"` : "";
    return `<span class="role-tag role-${r.key}"${tip}>${r.icon}${esc(role)}</span>`;
  }

  function cardHTML(cfg, game, icon, thumb) {
    const name = cfg.name || game.name;
    const url = `https://www.roblox.com/games/${game.rootPlaceId}`;
    return `
      <div class="bg" style="background-image:url('${esc(icon || "")}')"></div>
      <a class="card-link" href="${url}" target="_blank" rel="noreferrer" aria-label="Play ${esc(name)} on Roblox"></a>
      <div class="banner">
        ${thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy" />` : ""}
        ${roleTag(cfg.role)}
        <div class="card-actions">
          <button type="button" class="icon-btn" data-copy="${url}" aria-label="Copy link to ${esc(name)}">${ICON.copy}</button>
          <a class="icon-btn" href="${url}" target="_blank" rel="noreferrer" aria-label="Open ${esc(name)}">${ICON.open}</a>
        </div>
      </div>
      <div class="card-body">
        <div class="icon-wrap">
          ${icon ? `<img class="game-icon" src="${esc(icon)}" alt="" />` : `<div class="game-icon"></div>`}
          <span class="live-dot" data-k="dot" title="Live"></span>
        </div>
        <h3 class="game-name" title="${esc(name)}">${esc(name)}</h3>
        <div class="creator"><span>by ${esc(game.creator?.name || "Unknown")}</span>${game.creator?.hasVerifiedBadge ? ICON.verified : ""}</div>
        <div class="stats">
          <div class="stat live"><div class="stat-label"><span class="mini-dot"></span>Playing</div><div class="stat-value" data-k="playing">0</div></div>
          <div class="stat"><div class="stat-label">Visits</div><div class="stat-value" data-k="visits">0</div></div>
          <div class="stat"><div class="stat-label">Favorites</div><div class="stat-value" data-k="favorites">0</div></div>
        </div>
        <div class="card-foot"><span data-k="max"></span><span data-k="updated"></span></div>
      </div>`;
  }

  // Smoothly count a number from its previous value to the new one.
  function tween(el, from, to, fmt) {
    if (from === to) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 900;
    (function step(now) {
      const k = ease(clamp01((now - t0) / dur));
      el.textContent = fmt(Math.round(from + (to - from) * k));
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  function updateCard(entry, game) {
    const { el, values } = entry;
    const q = (k) => el.querySelector(`[data-k="${k}"]`);
    tween(q("playing"), values.playing || 0, game.playing || 0, (n) => full.format(n));
    tween(q("visits"), values.visits || 0, game.visits || 0, (n) => compact.format(n));
    tween(q("favorites"), values.favorites || 0, game.favoritedCount || 0, (n) => compact.format(n));
    q("dot").classList.toggle("on", (game.playing || 0) > 0);
    q("max").textContent = game.maxPlayers ? `${game.maxPlayers} per server` : "";
    q("updated").textContent = game.updated ? `Updated ${timeAgo(game.updated)}` : "";
    entry.values = { playing: game.playing || 0, visits: game.visits || 0, favorites: game.favoritedCount || 0 };
  }

  let universeIds = [];
  async function refreshStats() {
    const ids = universeIds.filter(Boolean);
    if (!ids.length) return;
    try {
      const { data } = await getJSON(API.games(ids));
      let total = 0;
      data.forEach((g) => { const c = cards.get(g.id); if (c) updateCard(c, g); total += g.playing || 0; });
      sub.textContent = `${data.length} game${data.length === 1 ? "" : "s"} · ${full.format(total)} playing now`;
      setCCU(total); setVisits();
    } catch {
      sub.textContent = "Couldn't reach Roblox, retrying shortly…";
    }
  }

  async function initGames() {
    if (!config.length) {
      grid.innerHTML = `<div class="empty">No games yet. Add place IDs to <code>games.js</code>.</div>`;
      sub.textContent = "";
      return;
    }
    skeletons(config.length);
    universeIds = await resolveUniverses();
    const ids = universeIds.filter(Boolean);
    if (!ids.length) { sub.textContent = "Couldn't load games. Check the place IDs in games.js."; grid.innerHTML = ""; return; }

    const [games, icons, thumbs] = await Promise.all([
      getJSON(API.games(ids)).catch(() => ({ data: [] })),
      getJSON(API.icons(ids)).catch(() => ({ data: [] })),
      getJSON(API.thumbs(ids)).catch(() => ({ data: [] })),
    ]);
    const byId = new Map(games.data.map((g) => [g.id, g]));
    const iconBy = new Map(icons.data.map((i) => [i.targetId, i.imageUrl]));
    const thumbBy = new Map(thumbs.data.map((t) => [t.universeId, t.thumbnails?.[0]?.imageUrl]));

    grid.innerHTML = "";
    let total = 0;
    config.forEach((cfg, i) => {
      const uid = universeIds[i];
      const game = byId.get(uid);
      if (!game) return;
      const el = document.createElement("article");
      el.className = "game-card";
      el.innerHTML = cardHTML(cfg, game, iconBy.get(uid), thumbBy.get(uid));
      grid.appendChild(el);
      const entry = { el, values: {} };
      cards.set(uid, entry);
      updateCard(entry, game);
      total += game.playing || 0;
    });
    sub.textContent = `${cards.size} game${cards.size === 1 ? "" : "s"} · ${full.format(total)} playing now`;
    setCCU(total); setVisits();
    setInterval(refreshStats, refreshMs);
  }

  grid.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    e.preventDefault();
    try { await navigator.clipboard.writeText(btn.dataset.copy); toast("Link copied"); }
    catch { toast(btn.dataset.copy); }
  });

  initGames();

  /* ============================================================
   * About: live Roblox profile (avatar render, names, verified)
   * ============================================================ */
  const ROBLOX_USER_ID = 4885560811;
  async function initProfile() {
    $("#years-note").textContent = `${new Date().getFullYear() - 2019} years`;
    const avatar = $("#profile-avatar");
    avatar.addEventListener("load", () => avatar.classList.add("loaded"));
    try {
      const [user, thumb] = await Promise.all([
        getJSON(`https://users.roproxy.com/v1/users/${ROBLOX_USER_ID}`),
        getJSON(`https://thumbnails.roproxy.com/v1/users/avatar?userIds=${ROBLOX_USER_ID}&size=720x720&format=Png&isCircular=false`),
      ]);
      $("#profile-display").textContent = user.displayName;
      $("#profile-bg-name").textContent = user.displayName;
      $("#profile-user").textContent = `@${user.name}`;
      $("#profile-verified").style.display = user.hasVerifiedBadge ? "" : "none";
      const url = thumb.data?.[0]?.imageUrl;
      if (url) avatar.src = url;
    } catch (err) {
      console.warn("Roblox profile failed to load", err);
    }
  }
  initProfile();

  /* ============================================================
   * Contact: live Discord profile card
   *  - dstn.to: banner, avatar, server tag, badges
   *  - Lanyard: live status + activity (refreshes every 30s)
   * ============================================================ */
  const DISCORD_ID = "1278425743847718973";
  const CDN = "https://cdn.discordapp.com";
  const cdnImg = (path, hash, size) => `${CDN}/${path}/${hash}.${String(hash).startsWith("a_") ? "gif" : "png"}?size=${size}`;

  $("#copy-discord-id").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(DISCORD_ID); toast("Discord ID copied"); }
    catch { toast(DISCORD_ID); }
  });

  async function loadDiscordProfile() {
    try {
      const p = await getJSON(`https://dcdn.dstn.to/profile/${DISCORD_ID}`);
      const u = p.user || {};
      if (u.global_name || u.username) $("#dc-name").textContent = u.global_name || u.username;
      if (u.username) $("#dc-user").textContent = `@${u.username}`;
      if (u.avatar) $("#dc-avatar").src = cdnImg(`avatars/${DISCORD_ID}`, u.avatar, 160);
      const banner = $("#dc-banner");
      if (u.banner) banner.style.backgroundImage = `url('${cdnImg(`banners/${DISCORD_ID}`, u.banner, 600)}')`;
      else if (u.banner_color) banner.style.backgroundColor = u.banner_color;
      const g = u.primary_guild || u.clan;
      if (g && g.tag) {
        const tag = $("#dc-tag");
        tag.innerHTML = `${g.badge ? `<img alt="" src="${CDN}/clan-badges/${g.identity_guild_id}/${g.badge}.png?size=32" />` : ""}${esc(g.tag)}`;
        tag.hidden = false;
      }
      $("#dc-badges").innerHTML = (p.badges || []).map((b) =>
        `<img alt="${esc(b.description)}" title="${esc(b.description)}" src="${CDN}/badge-icons/${b.icon}.png" />`).join("");
    } catch (err) { console.warn("Discord profile failed to load", err); }
  }

  const STATUS = { online: "Online", idle: "Idle", dnd: "Do Not Disturb", offline: "Offline" };
  async function loadDiscordPresence() {
    try {
      const { data } = await getJSON(`https://api.lanyard.rest/v1/users/${DISCORD_ID}`);
      const s = STATUS[data.discord_status] ? data.discord_status : "offline";
      $("#dc-status").dataset.status = s;
      $("#dc-status").title = STATUS[s];
      $("#dc-pdot").dataset.status = s;
      const custom = (data.activities || []).find((a) => a.type === 4 && a.state);
      $("#dc-presence").textContent = s === "offline" ? "Offline · DM me anyway"
        : custom ? `${STATUS[s]} · ${custom.state}` : STATUS[s];

      const act = $("#dc-activity");
      const game = (data.activities || []).find((a) => a.type === 0);
      if (data.listening_to_spotify && data.spotify) {
        const sp = data.spotify;
        act.innerHTML = `${sp.album_art_url ? `<img alt="" src="${esc(sp.album_art_url)}" />` : ""}
          <div><div class="a-kicker">Listening to Spotify</div><div class="a-title">${esc(sp.song)}</div><div class="a-sub">by ${esc(sp.artist)}</div></div>`;
        act.hidden = false;
      } else if (game) {
        act.innerHTML = `<div><div class="a-kicker">Playing</div><div class="a-title">${esc(game.name)}</div>${game.details ? `<div class="a-sub">${esc(game.details)}</div>` : ""}</div>`;
        act.hidden = false;
      } else act.hidden = true;
    } catch (err) { console.warn("Discord presence failed to load", err); }
  }

  loadDiscordProfile();
  loadDiscordPresence();
  setInterval(loadDiscordPresence, 30000);

  /* ============================================================
   * Background music video (YouTube)
   * Starts muted behind the intro (browsers only allow muted
   * autoplay), then unmutes on the "enter" click.
   * ============================================================ */
  const BG_VIDEO_ID = "YnF-6UtAZSk";
  const BG_VOLUME = 40;
  const bgWrap = $("#bg-video");
  const soundBtn = $("#sound-btn");
  let player = null, playerReady = false, wantSound = store.get("c8-music") !== false;

  function renderSoundBtn() {
    const on = !!(playerReady && !player.isMuted());
    soundBtn.setAttribute("aria-pressed", String(on));
    soundBtn.setAttribute("aria-label", on ? "Mute music" : "Unmute music");
  }

  function startMusic() {
    if (!playerReady || !wantSound) return;
    player.unMute(); player.setVolume(BG_VOLUME); player.playVideo();
    setTimeout(renderSoundBtn, 150);
  }

  soundBtn.addEventListener("click", () => {
    if (!playerReady) return;
    if (player.isMuted()) { wantSound = true; player.unMute(); player.setVolume(BG_VOLUME); player.playVideo(); }
    else { wantSound = false; player.mute(); }
    store.set("c8-music", wantSound);
    setTimeout(renderSoundBtn, 150);
  });

  window.onYouTubeIframeAPIReady = () => {
    player = new YT.Player("bg-player", {
      videoId: BG_VIDEO_ID,
      playerVars: {
        autoplay: 1, mute: 1, controls: 0, loop: 1, playlist: BG_VIDEO_ID, playsinline: 1,
        rel: 0, modestbranding: 1, iv_load_policy: 3, disablekb: 1, fs: 0,
      },
      events: {
        onReady: (e) => {
          playerReady = true;
          e.target.mute(); e.target.playVideo();
          if (document.body.dataset.stage === "main") startMusic(); // entered before the player loaded
          renderSoundBtn();
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) bgWrap.classList.add("playing");
          renderSoundBtn();
        },
      },
    });
  };
  const yt = document.createElement("script");
  yt.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(yt);
})();
