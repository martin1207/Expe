"use strict";
// Rendu : boîtes sur la vidéo, frise des tracks, panneau latéral, loupes.

// ------------------------------------------------------------------ rendu
function layout() {
  const avail = $("videos").clientWidth, showDrone = droneOn();
  // avec le drone : 360° à gauche (~60 %), drone 16:9 à droite
  const w = showDrone ? Math.round(avail * 0.6) - 3 : avail;
  const ratio = C ? C.height / C.width : 0.5;
  const h = Math.round(Math.min(w * ratio, window.innerHeight * 0.62));
  const ww = Math.round(h / ratio);
  stage.style.width = ww + "px"; stage.style.height = h + "px";
  const db = $("dronebox");
  db.style.display = showDrone ? "block" : "none";
  db.style.width = (showDrone ? Math.max(160, avail - ww - 6) : 0) + "px"; db.style.height = h + "px";
  applyDroneView();
  world.style.width = ww + "px"; world.style.height = h + "px";
  const dpr = window.devicePixelRatio || 1;
  overlay.width = ww * dpr; overlay.height = h * dpr;
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  applyView(); renderTimeline();
}
window.addEventListener("resize", layout);

function renderAll() { renderFrame(); renderTimeline(); renderPanel(); }

function renderFrame() {
  if (!C) return;
  const { w, h } = stageSize();
  octx.clearRect(0, 0, w, h);
  if (C.ego_yaw > 0) {
    // zone arrière |yaw| > ego_yaw : les deux bords de l'image équirectangulaire
    const m = (180 - C.ego_yaw) / 360;
    const [l0, t0] = toScreen(0, 0), [l1, b1] = toScreen(m, 1), [r0] = toScreen(1 - m, 0), [r1] = toScreen(1, 0);
    octx.fillStyle = "rgba(0,0,0,.45)";
    octx.fillRect(l0, t0, l1 - l0, b1 - t0); octx.fillRect(r0, t0, r1 - r0, b1 - t0);
  }
  const lw = Math.max(1.5, 1.2 * Math.sqrt(view.z));
  octx.font = "600 11px -apple-system, sans-serif";
  for (const b of frameBoxes(frame, $("chkDead").checked)) {
    const { id, raw, removed } = b, sel = (!removed || AUTO_GONE.has(removed)) && selected.has(id);
    const [x1, y1] = toScreen(b.box[0], b.box[1]), [x2, y2] = toScreen(b.box[2], b.box[3]);
    const col = removed === "dead" ? "rgba(255,93,93,.8)" : removed ? "rgba(170,170,170,.7)" : color(id, sel ? 1 : 0.85);
    octx.save();
    octx.strokeStyle = removed ? col : color(id);
    octx.lineWidth = sel ? lw * 2.2 : lw;
    if (removed || raw < 0) octx.setLineDash([5, 4]);
    if (sel) { octx.shadowColor = "#fff"; octx.shadowBlur = 8; }
    octx.strokeRect(x1, y1, Math.max(1, x2 - x1), Math.max(1, y2 - y1));
    octx.restore();
    const label = (b.manual ? "✎ " : "") + (removed === "ego" ? "ego " : removed === "bike" ? "🚲 ✗ " : GONE_TXT[removed] ? `${GONE_TXT[removed]} ✗ ` : "")
      + (raw < 0 ? "?" : `#${id}`) + (raw >= 0 && id !== raw && !b.cyclist ? ` (${raw})` : "")
      + (b.cyclist ? (b.parts === "bike_estimated" || b.parts === "bike_interpolated" ? " cyclist ≈" : " cyclist") : "")
      + ` ${b.conf.toFixed(2)}`
      + ((p => p ? ` · ${distTxt(p)}` : "")(!removed && raw >= 0 ? posAt(frame, id) : null));
    const tw = octx.measureText(label).width + 6;
    octx.fillStyle = col;
    octx.fillRect(x1, y1 - 15, tw, 15);
    octx.fillStyle = "#000"; octx.fillText(label, x1 + 3, y1 - 4);
  }
  if (drawing) {
    // boîte en cours de tracé
    const [x1, y1] = toScreen(Math.min(drawing.a[0], drawing.b[0]), Math.min(drawing.a[1], drawing.b[1]));
    const [x2, y2] = toScreen(Math.max(drawing.a[0], drawing.b[0]), Math.max(drawing.a[1], drawing.b[1]));
    octx.save(); octx.strokeStyle = "#fff"; octx.lineWidth = 2; octx.setLineDash([6, 4]);
    octx.strokeRect(x1, y1, x2 - x1, y2 - y1); octx.restore();
  }
  $("seek").value = frame;
  const utc = C.utc0 ? " · " + new Date((C.utc0 + frame / C.fps) * 1000).toISOString().slice(11, 22) + " UTC" : "";
  $("frameinfo").textContent = `frame ${frame} / ${C.n_frames - 1} · ${(frame / C.fps).toFixed(2)} s${utc}`;
  renderTimelineCursor();
  renderLoupes();
  renderMap();
  satRender();
}

// --- frise : une ligne par track vivant, segments = frames où il est détecté
let tlBase = null;   // image de la frise sans curseur, pour redessiner seulement le curseur
function renderTimeline() {
  if (!C) return;
  const dpr = window.devicePixelRatio || 1, w = tlwrap.clientWidth;
  const rows = tracks.length, h = TL_HEAD + Math.max(1, rows) * TL_ROW + 4;
  tl.width = w * dpr; tl.height = h * dpr; tl.style.height = h + "px";
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  tctx.fillStyle = "#111418"; tctx.fillRect(0, 0, w, h);
  const fx = (f) => TL_LABEL + (f / Math.max(1, C.n_frames - 1)) * (w - TL_LABEL - 8);
  tctx.font = "11px ui-monospace, Menlo, monospace"; tctx.textBaseline = "middle";
  tracks.forEach((t, i) => {
    const y = TL_HEAD + i * TL_ROW, sel = selected.has(t.id);
    if (sel) { tctx.fillStyle = "#1d3b5c"; tctx.fillRect(0, y, w, TL_ROW); }
    tctx.fillStyle = sel ? "#fff" : "#8c96a3";
    tctx.fillText(`#${t.id}`, 4, y + TL_ROW / 2);
    tctx.fillStyle = t.gone ? "rgba(170,170,170,.5)" : color(t.id, sel ? 1 : 0.75);
    // regroupe les frames consécutives en segments
    let s = t.frames[0], p = s;
    for (let j = 1; j <= t.frames.length; j++) {
      const f = t.frames[j];
      if (f === p || f === p + 1) { p = f; continue; }
      tctx.fillRect(fx(s), y + 3, Math.max(2, fx(p) - fx(s) + 1), TL_ROW - 6);
      s = p = f;
    }
    if (t.overlap) { tctx.fillStyle = "#f5b84a"; tctx.fillText("⚠", w - 14, y + TL_ROW / 2); }
  });
  if (!rows) { tctx.fillStyle = "#8c96a3"; tctx.fillText("aucun track", TL_LABEL, TL_HEAD + 6); }
  tlBase = tctx.getImageData(0, 0, tl.width, tl.height);
  renderTimelineCursor();
  renderSpeed();
}

function renderTimelineCursor() {
  if (!tlBase || !C) return;
  tctx.putImageData(tlBase, 0, 0);
  const w = tlwrap.clientWidth;
  const x = TL_LABEL + (frame / Math.max(1, C.n_frames - 1)) * (w - TL_LABEL - 8);
  tctx.fillStyle = "#fff"; tctx.fillRect(x - 0.5, 0, 1, tl.height);
  renderSpeedCursor();
}

tl.addEventListener("click", (e) => {
  if (!C) return;
  const r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const row = Math.floor((y - TL_HEAD) / TL_ROW);
  const w = tlwrap.clientWidth;
  if (x > TL_LABEL) setFrame(Math.round(((x - TL_LABEL) / (w - TL_LABEL - 8)) * (C.n_frames - 1)));
  if (row >= 0 && row < tracks.length) select(tracks[row].id, e.shiftKey || e.metaKey || e.ctrlKey);
});

// --- panneau latéral
function renderPanel() {
  if (!C) return;
  const sel = [...selected].sort((a, b) => a - b).map(id => trackById.get(id)).filter(Boolean);
  $("selcards").className = sel.length ? "" : "muted";
  $("selcards").innerHTML = sel.length ? sel.map(t => `
    <div class="card">
      <canvas width="144" height="192" data-loupe="${t.id}"></canvas>
      <div class="meta">
        <b><span class="sw" style="background:${color(t.id)}"></span>#${t.id}</b> ${t.className}<br>
        <span class="muted">frames ${t.first}–${t.last} · ${t.n} dét. · conf ${t.conf.toFixed(2)}</span><br>
        ${t.manualCls ? `<span class="muted">classe corrigée à la main → ${t.manualCls}</span><br>` : ""}
        ${t.cyc ? `<span class="muted">🚲 vélo #${t.cyc.bike} · ${t.cyc.forced ? "forcé à la main" : `sur le vélo ${Math.round(t.cyc.frac * 100)} % de ${t.cyc.n_common} frames`}</span><br>` : ""}
        ${t.raws.size > 1 ? `<span class="muted">ids bruts : ${[...t.raws].sort((a, b) => a - b).join(", ")}</span><br>` : ""}
        ${t.overlap ? `<span class="warn">⚠ ${t.overlap} frame(s) avec 2 boîtes</span>` : ""}
        <div class="row">
          <button data-go="${t.first}">⇤ début</button><button data-go="${t.last}">fin ⇥</button>
        </div>
      </div>
    </div>`).join("") : "Cliquer une boîte, une ligne de la frise ou de la liste.";
  $("selcards").querySelectorAll("[data-go]").forEach(b => b.onclick = () => setFrame(+b.dataset.go));
  $("btnDelete").disabled = !sel.length;
  $("btnMerge").disabled = sel.length < 2;
  $("btnDeleteBox").disabled = !sel.length;
  $("btnKeep").disabled = !sel.some(t => t.gone && t.gone !== "short");
  $("btnSplit").disabled = sel.length !== 1 || frame <= sel[0].first || frame > sel[0].last;
  $("btnClass").disabled = !sel.length;
  $("btnClass").innerHTML = (sel.length && sel.every(t => t.className === "cyclist") ? "→ personne" : "→ cycliste") + " <kbd>T</kbd>";
  $("btnClear").disabled = !sel.length;
  $("mergeinfo").innerHTML = sel.length >= 2
    ? `Fusion → <b>#${sel[0].id}</b>` + (overlapFrames(sel.map(t => t.id))
        ? ` · <span class="warn">⚠ ${overlapFrames(sel.map(t => t.id))} frame(s) en commun</span>` : "")
    : "";

  $("nops").textContent = ops.length ? `(${ops.length})` : "";
  const opText = (o) => o.op === "merge" ? `fusion #${o.src} → #${o.dst}`
    : o.op === "delete" ? `suppression #${o.id}`
    : o.op === "pair" ? `cycliste #${o.person} + 🚲#${o.bike}`
    : o.op === "relabel" ? `#${o.id} → ${o.cls === "cyclist" ? "cycliste" : "personne"}`
    : o.op === "delete_box" ? `boîte #${o.id} · <a href="#" data-go="${o.frame}">frame ${o.frame}</a>`
    : o.op === "split" ? `coupure #${o.id} · <a href="#" data-go="${o.frame}">frame ${o.frame}</a>`
    : o.op === "keep" ? `garder #${o.id}`
    : o.op === "add_box" ? `boîte dessinée #${o.id} · <a href="#" data-go="${o.frame}">frame ${o.frame}</a>${o.from != null ? ` (+${Math.abs(o.frame - o.from) - 1} interpolées)` : ""}`
    : `séparer #${o.person} / 🚲#${o.bike}`;
  $("ops").innerHTML = ops.map((o, i) => `<li>${opText(o)}<button data-rm="${i}" title="Retirer">×</button></li>`).join("")
    || `<span class="muted">aucune</span>`;
  $("ops").querySelectorAll("[data-rm]").forEach(b => b.onclick = () => removeOp(+b.dataset.rm));
  $("ops").querySelectorAll("[data-go]").forEach(a => a.onclick = (e) => { e.preventDefault(); setFrame(+a.dataset.go); });
  $("btnUndo").disabled = !ops.length;
  $("btnReset").disabled = !ops.length;

  const kept = tracks.filter(t => !t.gone), nCyc = kept.filter(t => t.className === "cyclist").length;
  const goneTxt = Object.entries(goneCounts).map(([k, n]) => `${n} ${GONE_TXT[k]}`).join(", ");
  $("ntracks").textContent = `(${kept.length - nCyc} piéton(s), ${nCyc} cycliste(s)`
    + `${deadTracks.length ? ` + ${deadTracks.length} suppr.` : ""}${nLoneBikes ? ` · ${nLoneBikes} vélo(s) seul(s) retiré(s)` : ""}`
    + `${goneTxt ? ` · retirés d'office : ${goneTxt}` : ""})`;
  const goneTitle = (t) => !t.gone ? "" : t.gone === "short"
    ? `Moins de ${C.min_track_frames} frames, y compris avant toute coupure : retiré du CSV, sauf s'il est fusionné`
    : `Retiré d'office (${GONE_TXT[t.gone]}) : K pour le garder`;
  const rowsHtml = (list) => list.map(t => `
    <tr data-id="${t.id}" class="${t.dead ? "dead" : selected.has(t.id) ? "sel" : t.gone ? "short" : ""}"
        title="${goneTitle(t)}">
      <td><span class="sw" style="background:${t.dead ? "#555" : color(t.id)}"></span>#${t.id}</td>
      <td>${t.className}${t.gone ? ` (${GONE_TXT[t.gone]})` : ""}</td><td class="muted">${t.first}–${t.last}</td><td class="muted">${t.n}</td>
      <td>${t.overlap ? '<span class="warn">⚠</span>' : ""}</td>
    </tr>`).join("");
  $("tracklist").innerHTML = rowsHtml(tracks) + rowsHtml(deadTracks);
  renderSuggestions();
  $("tracklist").querySelectorAll("tr").forEach(tr => tr.onclick = (e) => {
    const t = trackById.get(+tr.dataset.id);
    if (!t || tr.classList.contains("dead")) return;
    select(t.id, e.shiftKey || e.metaKey || e.ctrlKey);
    if (!t.frameSet.has(frame)) setFrame(t.first);
  });
  renderLoupes();
}

// loupe : la boîte du track agrandie, si le track est présent sur la frame courante
function renderLoupes() {
  if (!C) return;
  document.querySelectorAll("canvas[data-loupe]").forEach(cv => {
    const id = +cv.dataset.loupe, ctx = cv.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
    const b = frameBoxes(frame, $("chkDead").checked).find(b => b.id === id && (!b.removed || AUTO_GONE.has(b.removed)));
    if (!b || !C.video_ok || video.readyState < 2) {
      ctx.fillStyle = "#8c96a3"; ctx.font = "20px sans-serif"; ctx.textAlign = "center";
      ctx.fillText(!b ? "absent" : "…", cv.width / 2, cv.height / 2);
      return;
    }
    const vw = video.videoWidth, vh = video.videoHeight;
    let x1 = b.box[0] * vw, y1 = b.box[1] * vh, x2 = b.box[2] * vw, y2 = b.box[3] * vh;
    const pw = (x2 - x1) * 0.25 + 8, ph = (y2 - y1) * 0.15 + 8;
    x1 = Math.max(0, x1 - pw); x2 = Math.min(vw, x2 + pw); y1 = Math.max(0, y1 - ph); y2 = Math.min(vh, y2 + ph);
    const s = Math.min(cv.width / (x2 - x1), cv.height / (y2 - y1));
    const dw = (x2 - x1) * s, dh = (y2 - y1) * s;
    ctx.drawImage(video, x1, y1, x2 - x1, y2 - y1, (cv.width - dw) / 2, (cv.height - dh) / 2, dw, dh);
  });
}

