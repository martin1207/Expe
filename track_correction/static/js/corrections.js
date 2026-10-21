"use strict";
// Corrections : rejoue les opérations (même logique que track_correction/ops.py), construit les tracks, actions D / X / B / M / T / annuler.

// ------------------------------------------------------------------ corrections
// Boîtes dessinées (op add_box), interpolées entre from et frame : même règle que manual_rows()
// dans track_correction/ops.py. Format des détections, + rang de l'opération en dernier.
const DRAWN_BASE = 9000;
function manualDetections() {
  const out = [];
  ops.forEach((op, j) => {
    if (op.op !== "add_box") return;
    const steps = [[op.frame, op.box]];
    if (op.from != null && op.from_box) {
      for (let f = Math.min(op.from, op.frame) + 1; f < Math.max(op.from, op.frame); f++) {
        const w = (f - op.from) / (op.frame - op.from);
        steps.push([f, op.from_box.map((a, i) => a + (op.box[i] - a) * w)]);
      }
    }
    for (const [f, b] of steps) out.push([f, op.id, op.cls || "person", 1.0, ...b, 0, j]);
  });
  return out;
}

// Rejoue les opérations boîte par boîte : même logique que replay() dans track_correction/ops.py.
function resolve() {
  const parent = new Map();
  const find = (i) => { while (parent.has(i)) i = parent.get(i); return i; };
  if (!C.rawDetections) C.rawDetections = C.detections;
  C.detections = C.rawDetections.concat(manualDetections());
  byFrame = new Map();
  C.detections.forEach((d, k) => { if (!byFrame.has(d[0])) byFrame.set(d[0], []); byFrame.get(d[0]).push(k); });
  const det = C.detections, n = det.length;
  const cur = det.map(d => d[1]);
  deadK = new Array(n).fill(false);
  // une boîte dessinée n'existe qu'à partir de son opération
  const alive = det.map(d => d[9] === undefined), born = new Map();
  det.forEach((d, k) => { if (d[9] !== undefined) { if (!born.has(d[9])) born.set(d[9], []); born.get(d[9]).push(k); } });
  let nextId = det.reduce((m, d) => d[9] === undefined ? Math.max(m, d[1]) : m, 0) + 1;   // ids des coupures
  for (const [j, op] of ops.entries()) {
    for (const k of born.get(j) || []) alive[k] = true;
    if (op.op === "merge") {
      const a = find(op.src), b = find(op.dst);
      if (a !== b) parent.set(a, b);
    } else if (op.op === "delete" || op.op === "delete_box" || op.op === "split") {
      const t = find(op.id), v = op.op === "split" ? nextId++ : null;
      for (let k = 0; k < n; k++) {
        if (!alive[k] || deadK[k] || cur[k] < 0 || find(cur[k]) !== t) continue;
        if (op.op === "delete" || (op.op === "delete_box" && det[k][0] === op.frame)) deadK[k] = true;
        else if (op.op === "split" && det[k][0] >= op.frame) cur[k] = v;
      }
    }
  }
  idOf = cur.map(c => c < 0 ? -1 : find(c));
  // track d'origine sans les coupures : seuil de frames minimum (cf. mark_uncut_length() dans pipeline.py)
  uncutOf = det.map(d => d[1] < 0 ? -1 : find(d[1]));
  // gardés à la main (K) ou avec une boîte dessinée : jamais retirés d'office ni trop courts
  keptIds = new Set(ops.filter(o => o.op === "keep" || o.op === "add_box").map(o => find(o.id)));
  rebuildTracks();
}

function setCyclists(list, overrides, alias, boxes) {
  cyclists = list || [];
  // boîtes cycliste calculées par le serveur (vélo estimé quand YOLO ne le voit pas)
  cycBoxes = new Map((boxes || []).map(b => [`${b[0]}:${b[1]}`, b.slice(2)]));
  cycAlias = new Map(Object.entries(alias || {}).map(([k, v]) => [+k, v]));
  classOv = new Map(Object.entries(overrides || {}).map(([k, v]) => [+k, v]));
  cycBike = new Map(cyclists.map(c => [c.bike, c.person]));
  cycPerson = new Map(cyclists.map(c => [c.person, c]));
}
// id affiché d'une détection : id final ; le vélo d'un cycliste prend l'id de sa personne, et
// les tracks cyclist réunis (un seul cycliste par clip) l'id gardé par le serveur
const dispIdK = (k) => {
  const m = idOf[k], p = cycBike.has(m) ? cycBike.get(m) : m;
  return cycAlias.has(p) ? cycAlias.get(p) : p;
};
const isBikePartK = (k) => cycBike.has(idOf[k]);
// ids finaux (avant affichage) qui composent les tracks affichés : pour viser les opérations
const finalIdsOf = (shown, onlyFrame = null) => [...new Set(C.detections
  .map((d, k) => k).filter(k => idOf[k] >= 0 && !deadK[k] && shown.has(dispIdK(k))
                             && (onlyFrame === null || C.detections[k][0] === onlyFrame))
  .map(k => idOf[k]))].sort((a, b) => a - b);

// baseline ou exclu : le clip ne garde aucun track (cf. final_rows() dans correct_tracks.py)
const ownScenario = () => LABEL_KEYS.some(k => labels[k]);
// étiquettes de scénario du clip, ou à défaut celles de son bloc (track_correction/scenarios.py)
const effLabels = () => ownScenario() || !C?.inherited ? labels : { ...labels, ...C.inherited };
const clipOff = () => effLabels().condition === "baseline" || !!labels.excluded;

function rebuildTracks() {
  const live = new Map(), gone = new Map();
  // nombre de frames de chaque track sans les coupures (boîtes gardées seulement)
  const uncutFrames = new Map();
  C.detections.forEach((d, k) => {
    if (d[1] < 0 || d[8] || deadK[k]) return;
    if (!uncutFrames.has(uncutOf[k])) uncutFrames.set(uncutOf[k], new Set());
    uncutFrames.get(uncutOf[k]).add(d[0]);
  });
  C.detections.forEach((d, k) => {
    const raw = d[1];
    if (raw < 0 || d[8] || clipOff()) return;   // sans id, zone ego, ou clip baseline/exclu
    const isDead = deadK[k], id = isDead ? idOf[k] : dispIdK(k), m = isDead ? gone : live;
    if (!m.has(id)) m.set(id, { id, raws: new Set(), frames: [], bframes: [], idx: [], cls: {}, conf: 0, dead: isDead });
    const t = m.get(id);
    t.raws.add(raw); t.idx.push(k);
    if (d[9] !== undefined) t.manual = true;
    if (keptIds.has(idOf[k])) t.kept = true;
    if (!isDead) t.uncutN = Math.max(t.uncutN || 0, uncutFrames.get(uncutOf[k])?.size || 0);
    // le vélo d'un cycliste ne compte pas comme 2e boîte de la même frame
    if (!isDead && isBikePartK(k)) { t.bframes.push(d[0]); return; }
    t.frames.push(d[0]); t.cls[d[2]] = (t.cls[d[2]] || 0) + 1 + d[3] / 1000; t.conf += d[3];
  });
  const finish = (t) => {
    const own = t.frames.length;
    t.overlap = own - new Set(t.frames).size;          // frames avec 2 boîtes du même id
    t.frames = [...new Set([...t.frames, ...t.bframes])].sort((a, b) => a - b);
    t.first = t.frames[0]; t.last = t.frames[t.frames.length - 1];
    t.n = t.frames.length; t.conf /= Math.max(1, own);
    const cls = Object.entries(t.cls).sort((a, b) => b[1] - a[1]);
    t.className = cls.length ? cls[0][0] : "bicycle";
    t.cyc = !t.dead ? cycPerson.get(t.id) : undefined;
    if (t.cyc) t.className = "cyclist";
    t.manualCls = !t.dead ? classOv.get(t.id) : undefined;
    if (t.manualCls === "cyclist") t.className = "cyclist";
    else if (t.manualCls === "person" && t.className === "cyclist") t.className = "person";
    t.frameSet = new Set(t.frames);
    return t;
  };
  // vélos seuls : retirés du CSV corrigé, donc ni affichés ni sélectionnables
  const all = [...live.values()].map(finish).sort((a, b) => a.first - b.first || a.id - b.id);
  // tracks trop courts : retirés du CSV ; visibles et sélectionnables avec « supprimés »,
  // pour pouvoir les fusionner dans un track plus long
  // retraits d'office (serveur) et tracks trop courts : retirés du CSV ; visibles en gris et
  // sélectionnables avec « supprimés », pour les fusionner ou les garder (K)
  const minF = C.min_track_frames || 0;
  for (const t of all) {
    // seuil sur le track avant coupure : un morceau coupé d'un track assez long est gardé
    t.short = t.className !== "bicycle" && t.n < minF && !(t.uncutN >= minF) && !t.kept;
    t.gone = removedIds.get(t.id) || (t.short ? "short" : null);
  }
  nLoneBikes = all.filter(t => t.className === "bicycle").length;
  nShort = all.filter(t => t.short).length;
  allById = new Map(all.map(t => [t.id, t]));
  goneCounts = {};
  for (const t of all) if (t.gone && t.className !== "bicycle") goneCounts[t.gone] = (goneCounts[t.gone] || 0) + 1;
  tracks = all.filter(t => t.className !== "bicycle" && (!t.gone || $("chkDead").checked));
  deadTracks = [...gone.values()].map(finish).sort((a, b) => a.id - b.id);
  trackById = new Map(tracks.map(t => [t.id, t]));
  for (const id of [...selected]) if (!trackById.has(id)) selected.delete(id);
}

function pushAction(newOps) {
  if (!newOps.length) return;
  ops.push(...newOps); undoSizes.push(newOps.length);
  afterEdit();
}

function afterEdit() {
  resolve(); renderAll(); scheduleSave();
}

function doDelete() {
  if (!selected.size) return;
  // tous les ids qui composent le track affiché : vélo d'un cycliste, tracks cyclist réunis
  pushAction(finalIdsOf(selected).map(id => ({ op: "delete", id })));
  selected.clear(); renderAll();
}

// X : retire la boîte des tracks sélectionnés sur la frame courante seulement
function doDeleteBox() {
  if (!selected.size) return;
  const todo = finalIdsOf(selected, frame);
  if (!todo.length) { setStatus("aucune boîte de ce track sur cette frame"); return; }
  pushAction(todo.map(id => ({ op: "delete_box", id, frame })));
}

// K : garde les tracks sélectionnés retirés d'office (conducteur, hors chemin, en trop, droniste)
function doKeep() {
  const sel = [...selected].map(id => trackById.get(id)).filter(t => t && t.gone && t.gone !== "short");
  if (!sel.length) { setStatus("sélectionner un track retiré d'office (cocher « supprimés »)"); return; }
  pushAction(finalIdsOf(new Set(sel.map(t => t.id))).map(id => ({ op: "keep", id })));
}

// fusion proposée (raccrochage) : le plus petit id est gardé, comme M
function acceptLink(a, b) {
  const [dst, src] = a < b ? [a, b] : [b, a];
  pushAction([{ op: "merge", src, dst }]);
  linkSugg = linkSugg.filter(l => !(l.src === a && l.dst === b));
  selected = new Set([dst]); renderAll();
}

// B : coupe le track sélectionné à la frame courante ; la suite prend un nouvel id
function doSplit() {
  if (selected.size !== 1) { setStatus("sélectionner un seul track pour le couper"); return; }
  const id = [...selected][0], t = trackById.get(id);
  if (!t || frame <= t.first || frame > t.last) { setStatus("se placer à l'intérieur du track (pas sur sa 1re frame)"); return; }
  // ids finaux du track présents à partir de cette frame
  const ids = [...new Set(C.detections.map((d, k) => k)
    .filter(k => idOf[k] >= 0 && !deadK[k] && dispIdK(k) === id && C.detections[k][0] >= frame).map(k => idOf[k]))];
  pushAction(ids.sort((a, b) => a - b).map(i => ({ op: "split", id: i, frame })));
}

function doMerge() {
  if (selected.size < 2) return;
  const ids = [...selected].sort((a, b) => a - b), dst = ids[0];
  const both = overlapFrames(ids);
  if (both > 0 && !confirm(`Ces tracks sont présents ensemble sur ${both} frame(s) : ` +
      `après fusion, ces frames auront 2 boîtes avec l'id #${dst}.\n` +
      `C'est normal pour une personne coupée par la couture 360°, sinon c'est sûrement deux personnes.\n\nFusionner quand même ?`)) return;
  pushAction(ids.slice(1).map(src => ({ op: "merge", src, dst })));
  selected = new Set([dst]); renderAll();
}

// T : corrige la classe des tracks sélectionnés (tous cyclistes -> person, sinon -> cyclist)
function relabelAction() {
  const sel = [...selected].map(id => trackById.get(id)).filter(Boolean);
  if (!sel.length) return;
  const cls = sel.every(t => t.className === "cyclist") ? "person" : "cyclist";
  pushAction(sel.map(t => ({ op: "relabel", id: t.id, cls })));
}

function overlapFrames(ids) {
  const count = new Map();
  for (const id of ids) for (const f of trackById.get(id).frameSet) count.set(f, (count.get(f) || 0) + 1);
  let n = 0; for (const c of count.values()) if (c > 1) n++;
  return n;
}

function undo() {
  if (!ops.length) return;
  const n = undoSizes.pop() || 1;
  ops.splice(ops.length - n, n);
  afterEdit();
}

function removeOp(i) {
  ops.splice(i, 1); undoSizes = ops.map(() => 1);
  afterEdit();
}

