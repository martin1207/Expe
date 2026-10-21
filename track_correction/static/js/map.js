"use strict";
// Vue de dessus égocentrée : la trottinette équipée au centre, l'avant vers le haut, la droite à
// droite. Positions (m) calculées par le serveur (track_correction/position.py) pour les
// boîtes gardées : x = dist·sin(angle) vers la droite, y = dist·cos(angle) vers l'avant.

let posByFrame = new Map();     // frame -> [{id, cls, x, y, d, lat, lon, src}]
// distance : « ≈ » interpolée (pieds cachés), « ? » suspecte (cf. track_correction/smoothing.py)
const distTxt = (p) => `${p.src === "interp" ? "≈" : p.src === "suspect" ? "?" : ""}${p.d.toFixed(1)} m`;
let mapRange = 20;              // rayon affiché (m)
const MAP_TRAIL_S = 2;          // longueur des traînées (s)
const PED_MAX_M = 24;           // ped_distance.py ramène toute distance hors [0, 24 m] à 24 m
try { mapRange = +localStorage.getItem("ct_map_range") || 20; } catch {}

function setPositions(list) {
  posByFrame = new Map();
  for (const [f, id, c, x, y, d, lat, lon, src] of list || []) {
    if (!posByFrame.has(f)) posByFrame.set(f, []);
    posByFrame.get(f).push({ id, cls: c === "c" ? "cyclist" : "person", x, y, d, lat, lon, src });
  }
}

const posAt = (f, id) => (posByFrame.get(f) || []).find(p => p.id === id);

// mètres -> pixels du canvas (centre = trottinette équipée)
function mapProjection(size) {
  const c = size / 2, k = (size / 2 - 10) / mapRange;
  return { c, k, P: (x, y) => [c + x * k, c - y * k] };
}

function renderMap() {
  const cv = $("map");
  if (!cv || !C) return;
  const size = cv.clientWidth, dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(size * dpr)) { cv.width = cv.height = Math.round(size * dpr); }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const { c, k, P } = mapProjection(size);

  // zone arrière retirée (ego) : secteur |angle| > ego_yaw
  if (C.ego_yaw > 0) {
    const a = (C.ego_yaw - 90) * Math.PI / 180, b = (270 - C.ego_yaw) * Math.PI / 180;
    ctx.fillStyle = "rgba(255,255,255,.05)";
    ctx.beginPath(); ctx.moveTo(c, c); ctx.arc(c, c, size, a, b); ctx.closePath(); ctx.fill();
  }
  // anneaux de distance et axes
  const step = mapRange <= 10 ? 2 : 5;
  ctx.strokeStyle = "#2b313a"; ctx.fillStyle = "#8c96a3"; ctx.lineWidth = 1;
  ctx.font = "10px ui-monospace, Menlo, monospace";
  for (let r = step; r <= mapRange + 1e-6; r += step) {
    ctx.beginPath(); ctx.arc(c, c, r * k, 0, 2 * Math.PI); ctx.stroke();
    ctx.fillText(`${r} m`, c + 3, c - r * k + 11);
  }
  ctx.beginPath(); ctx.moveTo(c, 4); ctx.lineTo(c, size - 4); ctx.moveTo(4, c); ctx.lineTo(size - 4, c); ctx.stroke();
  ctx.fillText("avant", c + 4, 12);

  // trottinette équipée
  ctx.fillStyle = "#fff";
  ctx.beginPath(); ctx.moveTo(c, c - 8); ctx.lineTo(c - 5, c + 6); ctx.lineTo(c + 5, c + 6); ctx.closePath(); ctx.fill();

  const cur = posByFrame.get(frame) || [];
  // traînées : positions du même track sur les MAP_TRAIL_S dernières secondes
  const n = Math.round(C.fps * MAP_TRAIL_S);
  ctx.lineWidth = 1.5;
  for (const p of cur) {
    const pts = [];
    for (let f = Math.max(0, frame - n); f <= frame; f++) { const q = posAt(f, p.id); if (q) pts.push(P(q.x, q.y)); }
    if (pts.length < 2) continue;
    ctx.strokeStyle = color(p.id, 0.45);
    ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke();
  }
  // usagers de la frame
  ctx.font = "600 10px -apple-system, sans-serif";
  for (const p of cur) {
    let [x, y] = P(p.x, p.y);
    const out = p.d > mapRange;
    if (out) { const s = (mapRange * k) / Math.hypot(x - c, y - c); x = c + (x - c) * s; y = c + (y - c) * s; }
    const sel = selected.has(p.id), r = sel ? 7 : 5;
    ctx.beginPath();
    if (p.cls === "cyclist") ctx.rect(x - r, y - r, 2 * r, 2 * r); else ctx.arc(x, y, r, 0, 2 * Math.PI);
    // creux : hors du cadre, ou piéton plafonné à 24 m par le modèle (distance réelle >= 24 m)
    const hollow = out || (p.cls === "person" && p.d >= PED_MAX_M - 1e-3);
    if (hollow) { ctx.strokeStyle = color(p.id); ctx.lineWidth = 2; ctx.stroke(); }
    else { ctx.fillStyle = color(p.id); ctx.fill(); }
    if (sel) { ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke(); }
    ctx.fillStyle = color(p.id);
    ctx.fillText(`#${p.id} ${distTxt(p)}${hollow && !out ? "+" : ""}`, x + r + 3, y + 3);
  }
  $("mapinfo").textContent = cur.length ? `${cur.length} usager(s)` : "";
}

// clic sur un point : sélectionne le track (⇧ / ⌘ pour ajouter)
function clickMap(e) {
  if (!C) return;
  const cv = $("map"), r = cv.getBoundingClientRect();
  const { c, k, P } = mapProjection(cv.clientWidth);
  let best = null, bestD = 12;
  for (const p of posByFrame.get(frame) || []) {
    let [x, y] = P(p.x, p.y);
    if (p.d > mapRange) { const s = (mapRange * k) / Math.hypot(x - c, y - c); x = c + (x - c) * s; y = c + (y - c) * s; }
    const d = Math.hypot(e.clientX - r.left - x, e.clientY - r.top - y);
    if (d < bestD) { bestD = d; best = p.id; }
  }
  select(best, e.shiftKey || e.metaKey || e.ctrlKey);
}

function setMapRange(m) {
  mapRange = m;
  try { localStorage.setItem("ct_map_range", String(m)); } catch {}
  document.querySelectorAll("[data-range]").forEach(b => b.classList.toggle("on", +b.dataset.range === m));
  renderMap();
}
