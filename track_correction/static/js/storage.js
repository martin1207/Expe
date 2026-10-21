"use strict";
// Sauvegarde automatique et chargement des clips.

// ------------------------------------------------------------------ sauvegarde
function setStatus(txt, cls = "") { const s = $("status"); s.textContent = txt; s.className = cls; }

function scheduleSave() {
  dirty = true; setStatus("modifié…", "dirty");
  clearTimeout(saveTimer); saveTimer = setTimeout(save, 600);
}

function setRemoved(removed, sugg) {
  removedIds = new Map(Object.entries(removed || {}).map(([k, v]) => [+k, v]));
  linkSugg = sugg || [];
}

async function save() {
  clearTimeout(saveTimer);
  if (!C || !dirty) return true;
  try {
    const r = await fetch(`/api/clip/${C.participant}/${C.clip}?src=${C.source}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ops, reviewed, labels }),
    });
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    dirty = false;
    setCyclists(j.cyclists, j.class_overrides, j.track_alias, j.cyclist_boxes); setPositions(j.positions);
    setRemoved(j.removed, j.link_suggestions); resolve(); renderAll();
    setStatus(j.saved ? `enregistré · ${j.rows}/${j.rows_raw} lignes` : "aucune correction", "");
    const c = clips.find(c => c.participant === C.participant && c.clip === C.clip);
    if (c && j.counts) { c.n_ped = j.counts.p; c.n_cyc = j.counts.c; }
    if (c) {
      const eff = effLabels();
      c.labels_ok = eff.condition === "baseline" || (eff.condition === "scenario" && LABEL_KEYS.slice(1).every(k => eff[k]));
    }
    // ✓ / • du menu des clips : état dans la source principale ; celui de chaque modèle : menu des modèles
    const s = C.sources.find(s => s.id === C.source);
    if (s) { s.n_ops = ops.length; s.reviewed = reviewed; renderModels(); }
    if (c && s === C.sources[0]) { c.n_ops = ops.length; c.reviewed = reviewed; }
    if (c) { c.condition = effLabels().condition || ""; c.excluded = !!labels.excluded; c.to_review = !!labels.to_review; refreshClipOptions(); }
    // les autres clips du bloc héritent des nouvelles étiquettes : on recharge la liste
    if (labelsTouched) { labelsTouched = false; clips = await (await fetch("/api/clips")).json(); refreshClipOptions(); }
    return true;
  } catch (e) {
    setStatus("erreur d'enregistrement", "err"); console.error(e);
    return false;
  }
}
window.addEventListener("beforeunload", (e) => { if (dirty) { save(); e.preventDefault(); } });

// ------------------------------------------------------------------ chargement
async function loadClips() {
  clips = await (await fetch("/api/clips")).json();
  const ps = [...new Set(clips.map(c => c.participant))];
  $("selP").innerHTML = ps.map(p => `<option>${p}</option>`).join("");
  const last = (() => { try { return JSON.parse(localStorage.getItem("ct_last")); } catch { return null; } })();
  // adresse « #P01/P1_t_010 » : ouvre ce clip ; sinon le dernier ouvert
  const [hp, hc] = decodeURIComponent(location.hash.slice(1)).split("/");
  const start = clips.find(c => c.participant === hp && c.clip === hc)
    || clips.find(c => last && c.participant === last.p && c.clip === last.c) || clips[0];
  if (start) await openClip(start.participant, start.clip);
}

function refreshClipOptions() {
  const p = $("selP").value;
  $("selClip").innerHTML = clips.filter(c => c.participant === p).map(c => {
    const mark = c.excluded ? "✗ " : c.to_review ? "⚑ " : c.reviewed ? "✓ " : c.n_ops ? "• " : "  ";
    // [B] baseline ; [S✓] scénario complet, [S…] critères manquants ; * : repris du bloc
    const star = c.labels_from ? "*" : "";
    const cond = c.condition === "baseline" ? ` [B${star}]`
      : c.condition === "scenario" ? ` [S${c.labels_ok ? "✓" : "…"}${star}]` : "";
    const cut = c.n_parts > 1 ? " ↔" : "";
    const multi = c.sources && c.sources.length > 1 ? ` ◆${c.sources.length}` : "";
    // tracks gardés après correction : piétons + cyclistes
    const cnt = c.n_ped == null ? "" : ` · ${c.n_ped}p+${c.n_cyc}c`;
    return `<option value="${c.clip}">${mark}${c.clip}${cut}${multi}${cond}${cnt}${c.n_ops ? ` (${c.n_ops})` : ""}</option>`;
  }).join("");
  if (C && C.participant === p) $("selClip").value = C.clip;
  const done = clips.filter(c => c.reviewed).length;
  const later = clips.filter(c => c.to_review).length;
  const labelled = clips.filter(c => c.condition && c.labels_ok).length;
  $("clipinfo").textContent = `${done}/${clips.length} clips revus · ${labelled} étiquetés${later ? ` · ${later} à revoir` : ""}`;
}

async function openClip(p, clip, src) {
  if (dirty && !(await save())) return;
  setStatus("chargement…");
  // modèle : celui demandé, sinon le dernier choisi s'il a ce clip, sinon la source principale
  const avail = (clips.find(c => c.participant === p && c.clip === clip) || {}).sources || [];
  const pref = (() => { try { return localStorage.getItem("ct_src"); } catch { return null; } })();
  src = src || (avail.includes(pref) ? pref : avail[0]);
  const r = await fetch(`/api/clip/${p}/${clip}${src ? `?src=${src}` : ""}`);
  if (!r.ok) { setStatus(r.status === 404 ? "clip introuvable" : "erreur du serveur (détail dans le terminal)", "err"); return; }
  C = await r.json();
  droneSeg = null; drone.pause(); drone.removeAttribute("src"); drone.load();
  $("chkDrone").disabled = !(C.drones && C.drones.length);
  $("chkDrone").parentElement.title = C.drones && C.drones.length
    ? `Vidéo drone synchronisée (V) : ${[...new Set(C.drones.map(d => d.name))].join(", ")}`
    : "Aucune vidéo drone ne couvre ce clip";
  try { localStorage.setItem("ct_last", JSON.stringify({ p, c: clip })); } catch {}
  ops = C.ops || []; undoSizes = ops.map(() => 1); reviewed = !!C.reviewed; dirty = false;
  setCyclists(C.cyclists, C.class_overrides, C.track_alias, C.cyclist_boxes); setPositions(C.positions);
  setRemoved(C.removed, C.link_suggestions);
  if (sat && !$("satsec").hidden) satLoadClip();
  selected.clear(); frame = 0;
  C.rawDetections = C.detections;            // + boîtes dessinées, ajoutées par resolve()
  $("selP").value = p; refreshClipOptions(); renderModels();
  $("chkReviewed").checked = reviewed;
  renderPass();
  labels = { ...(C.labels || {}) }; renderLabels();
  $("seek").max = Math.max(0, C.n_frames - 1);
  $("novideo").style.display = C.video_ok ? "none" : "flex";
  if (C.video_ok) { video.src = `/video/${p}/${clip}?src=${C.source}`; video.load(); } else video.removeAttribute("src");
  resolve(); resetView(); layout(); renderAll(); syncDrone(true);
  setStatus(ops.length ? `${ops.length} correction(s) chargée(s)` : reviewed ? "revu, sans correction" : "");
}

// modèle(s) dont viennent les détections du clip (cf. track_correction/sources.py) : toujours
// affiché, sélectionnable quand il y en a plusieurs ; ✓ revu / • corrigé dans ce modèle
function renderModels() {
  const sel = $("selModel"), ss = C.sources || [];
  sel.innerHTML = ss.map(s => `<option value="${s.id}" title="${s.id}">`
    + `${s.reviewed ? "✓ " : s.n_ops ? "• " : ""}${s.model}${s.n_ops ? ` (${s.n_ops})` : ""}</option>`).join("");
  sel.value = C.source;
  sel.disabled = ss.length < 2;
}

// passage coupé en plusieurs clips par le GPS (cf. compute_passes() dans correct_tracks.py)
function renderPass() {
  const ps = C.pass, el = $("passinfo");
  if (!ps || ps.n_parts < 2) { el.style.display = "none"; return; }
  el.style.display = "";
  el.title = "Le GPS est sorti de la bande Transpolis (moins de 2 m sur le côté) : un même passage "
    + "a été coupé en plusieurs clips. Les ids de tracks ne se suivent pas d'un clip à l'autre.";
  el.innerHTML = `↔ passage coupé : partie ${ps.part}/${ps.n_parts}`
    + (ps.prev ? `<button data-clip="${ps.prev}">◀ ${ps.prev}</button>` : "")
    + (ps.next ? `<button data-clip="${ps.next}">${ps.next} ▶</button>` : "");
  el.querySelectorAll("[data-clip]").forEach(b => b.onclick = () => openClip(C.participant, b.dataset.clip));
}

function stepClip(delta) {
  const i = clips.findIndex(c => C && c.participant === C.participant && c.clip === C.clip);
  const n = clips[i + delta];
  if (n) openClip(n.participant, n.clip);
}

