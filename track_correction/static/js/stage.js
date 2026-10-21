"use strict";
// Zoom / déplacement de la vidéo 360, boîtes de la frame telles qu'exportées, clic.

// ------------------------------------------------------------------ zoom / pan
function stageSize() { return { w: stage.clientWidth, h: stage.clientHeight }; }
function resetView() { view = { z: 1, x: 0, y: 0 }; applyView(); }
function clampView() {
  const { w, h } = stageSize();
  view.z = Math.max(1, Math.min(12, view.z));
  view.x = Math.min(0, Math.max(w - w * view.z, view.x));
  view.y = Math.min(0, Math.max(h - h * view.z, view.y));
}
function applyView() {
  clampView();
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
  renderFrame();
}
// coordonnées normalisées de l'image -> pixels du stage
const toScreen = (nx, ny) => { const { w, h } = stageSize(); return [view.x + nx * w * view.z, view.y + ny * h * view.z]; };
const toNorm = (sx, sy) => { const { w, h } = stageSize(); return [(sx - view.x) / (w * view.z), (sy - view.y) / (h * view.z)]; };

stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const k = Math.exp(-e.deltaY * 0.0015), z = Math.max(1, Math.min(12, view.z * k));
  view.x = mx - (mx - view.x) * z / view.z; view.y = my - (my - view.y) * z / view.z; view.z = z;
  applyView();
}, { passive: false });

let drag = null;
// mode dessin (N) : glisser sur la vidéo pour tracer une boîte (js : finishDraw)
let drawMode = false, drawing = null;
const stageNorm = (e) => { const r = stage.getBoundingClientRect(); return toNorm(e.clientX - r.left, e.clientY - r.top); };
stage.addEventListener("mousedown", (e) => {
  if (drawMode) { const p = stageNorm(e); drawing = { a: p, b: p }; e.preventDefault(); return; }
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
});
window.addEventListener("mousemove", (e) => {
  if (drawing) { drawing.b = stageNorm(e); renderFrame(); return; }
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.moved && view.z > 1) { view.x = drag.vx + dx; view.y = drag.vy + dy; applyView(); }
});
window.addEventListener("mouseup", (e) => {
  if (drawing) { const d = drawing; drawing = null; finishDraw(d); return; }
  if (drag && !drag.moved && e.target.closest("#stage")) clickStage(e);
  drag = null;
});

function setDrawMode(on) {
  drawMode = on; drawing = null;
  stage.classList.toggle("drawing", on);
  $("btnDraw").classList.toggle("on", on);
  setStatus(on ? "dessin : glisser sur la vidéo · Échap pour arrêter" : "");
  renderFrame();
}

// Boîte tracée : ajoutée au track sélectionné (remplace sa boîte de la frame s'il en a une, et
// interpole depuis sa boîte la plus proche à ≤ 2 s si des frames manquent), sinon nouveau track.
function finishDraw(d) {
  const clamp = (v) => Math.min(1, Math.max(0, v));
  const box = [clamp(Math.min(d.a[0], d.b[0])), clamp(Math.min(d.a[1], d.b[1])),
               clamp(Math.max(d.a[0], d.b[0])), clamp(Math.max(d.a[1], d.b[1]))];
  if (box[2] - box[0] < 0.002 || box[3] - box[1] < 0.005) { renderFrame(); return; }
  const r2 = (b) => b.map(v => +v.toFixed(5));
  const sel = selected.size === 1 ? trackById.get([...selected][0]) : null;
  const newOps = [];
  let id;
  if (sel) {
    id = sel.id;
    const op = { op: "add_box", id, frame, box: r2(box), cls: sel.className === "cyclist" ? "cyclist" : "person" };
    if (sel.frameSet.has(frame)) {
      newOps.push(...finalIdsOf(new Set([id]), frame).map(i => ({ op: "delete_box", id: i, frame })));
    } else {
      const maxGap = Math.round(2 * C.fps);
      const prev = sel.frames.filter(f => f < frame).pop(), next = sel.frames.find(f => f > frame);
      const from = prev != null && frame - prev > 1 && frame - prev <= maxGap ? prev
        : next != null && next - frame > 1 && next - frame <= maxGap ? next : null;
      const fb = from == null ? null : frameBoxes(from, true).find(b => b.id === id);
      if (fb) { op.from = from; op.from_box = r2(fb.box); }
    }
    newOps.push(op);
  } else {
    const used = new Set(ops.filter(o => o.op === "add_box" && o.id >= DRAWN_BASE).map(o => o.id));
    id = DRAWN_BASE; while (used.has(id)) id++;
    newOps.push({ op: "add_box", id, frame, box: r2(box), cls: "person" });
  }
  pushAction(newOps);
  selected = new Set([id]); renderAll();
}

// Boîtes de la frame telles qu'elles partent dans le CSV corrigé (cf. make_cyclists()) :
// un cycliste = une boîte, union de sa personne et de son vélo ; aucun vélo seul.
// Avec showDead, on ajoute les boîtes retirées (removed = "ego" | "dead" | "bike", ou une raison
// de AUTO_GONE : "short" | "pilot" | "rider" | "offpath" | "extra").
function frameBoxes(f, showDead) {
  const out = [], cyc = new Map();
  for (const k of byFrame.get(f) || []) {
    const d = C.detections[k], raw = d[1], box = d.slice(4, 8);
    const removed = d[8] ? "ego" : clipOff() || (raw >= 0 && deadK[k]) ? "dead" : null;
    const id = raw < 0 ? -1 : removed ? idOf[k] : dispIdK(k);
    const t = trackById.get(id);
    const bike = d[2] === "bicycle" && t?.className !== "cyclist";
    // pas dans les tracks gardés : vélo seul, track trop court, ou détection sans id
    const gone = removed || (bike ? "bike" : removedIds.get(id) || (!t || t.short ? "short" : null));
    if (gone) {
      if (showDead) out.push({ id, raw, box, conf: d[3], removed: gone });
      continue;
    }
    if (t?.className === "cyclist") {
      // union personne + vélo, mais bas = bas du vélo s'il est détecté (cf. make_cyclists)
      const c = cyc.get(id);
      const bikeY2 = isBikePartK(k) ? box[3] : null;
      if (!c) cyc.set(id, { id, raw, box: [...box], conf: d[3], cyclist: true, bikeY2 });
      else {
        c.box = [Math.min(c.box[0], box[0]), Math.min(c.box[1], box[1]), Math.max(c.box[2], box[2]), Math.max(c.box[3], box[3])];
        c.conf = Math.max(c.conf, d[3]);
        if (bikeY2 !== null) c.bikeY2 = Math.max(c.bikeY2 ?? 0, bikeY2);
      }
      continue;
    }
    out.push({ id, raw, box, conf: d[3], manual: d[9] !== undefined });
  }
  for (const c of cyc.values()) {
    if (c.bikeY2 !== null) c.box[3] = c.bikeY2;
    // boîte du serveur si elle existe : identique au CSV, avec le vélo estimé s'il n'est pas vu
    const s = cycBoxes.get(`${f}:${c.id}`);
    if (s) { c.box = s.slice(0, 4); c.parts = s[4]; }
  }
  return out.concat([...cyc.values()]);
}

function clickStage(e) {
  if (!C) return;
  const r = stage.getBoundingClientRect();
  const [nx, ny] = toNorm(e.clientX - r.left, e.clientY - r.top);
  // plus petite boîte contenant le clic (les boîtes imbriquées restent atteignables)
  let best = null, bestA = Infinity;
  for (const b of frameBoxes(frame, $("chkDead").checked)) {
    if (b.removed && !(AUTO_GONE.has(b.removed) && trackById.has(b.id))) continue;
    const [x1, y1, x2, y2] = b.box;
    if (b.id < 0 || nx < x1 || nx > x2 || ny < y1 || ny > y2) continue;
    const a = (x2 - x1) * (y2 - y1);
    if (a < bestA) { bestA = a; best = b.id; }
  }
  select(best, e.shiftKey || e.metaKey || e.ctrlKey);
}

function select(id, additive) {
  if (id == null) { if (!additive) selected.clear(); }
  else if (additive) selected.has(id) ? selected.delete(id) : selected.add(id);
  else selected = selected.size === 1 && selected.has(id) ? new Set() : new Set([id]);
  renderAll();
}

