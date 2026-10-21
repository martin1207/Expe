"use strict";
// Branchement des boutons, étiquettes du clip, raccourcis clavier, démarrage.

// ------------------------------------------------------------------ événements
$("selP").onchange = () => {
  const c = clips.find(c => c.participant === $("selP").value);
  if (c) openClip(c.participant, c.clip);
};
$("selClip").onchange = () => openClip($("selP").value, $("selClip").value);
$("selModel").onchange = () => {
  try { localStorage.setItem("ct_src", $("selModel").value); } catch {}   // gardé pour les clips suivants
  openClip(C.participant, C.clip, $("selModel").value);
};
$("btnPrev").onclick = () => stepClip(-1);
$("btnNext").onclick = () => stepClip(+1);
// --- étiquettes du clip
function renderLabels() {
  const eff = effLabels();
  for (const k of LABEL_KEYS)
    document.querySelectorAll(`input[name=${k}]`).forEach(i => i.checked = eff[k] === i.value);
  $("scenario").hidden = eff.condition !== "scenario";
  const inh = !ownScenario() && C?.inherited;
  $("labelsfrom").textContent = inh ? `pré-rempli depuis ${C.inherited.from} (même bloc, sans pause)` : "";
  const blk = C?.group?.clips || [];
  $("blockinfo").textContent = blk.length > 1 ? `bloc : ${blk.join(", ")}` : "";
  $("chkExcluded").checked = !!labels.excluded;
  $("excludeReason").hidden = !labels.excluded;
  if (document.activeElement !== $("excludeReason")) $("excludeReason").value = labels.exclude_reason || "";
  $("chkReview").checked = !!labels.to_review;
  $("reviewReason").hidden = !labels.to_review;
  if (document.activeElement !== $("reviewReason")) $("reviewReason").value = labels.review_reason || "";
  const b = $("banner");
  b.textContent = [
    labels.excluded ? `Clip exclu de l'analyse${labels.exclude_reason ? ` : ${labels.exclude_reason}` : ""}`
      : effLabels().condition === "baseline" ? "Baseline : aucun track conservé" : "",
    labels.to_review ? `⚑ À revoir${labels.review_reason ? ` : ${labels.review_reason}` : ""}` : "",
  ].filter(Boolean).join(" · ");
  b.style.display = b.textContent ? "block" : "none";
  b.style.color = labels.excluded ? "var(--danger)" : labels.to_review ? "var(--warn)" : "var(--text)";
}

// changer d'état baseline / exclu fait apparaître ou disparaître tous les tracks
function labelsChanged() {
  renderLabels(); resolve(); renderAll(); scheduleSave();
}
$("chkExcluded").onchange = () => {
  labels.excluded = $("chkExcluded").checked;
  if (!labels.excluded) labels.exclude_reason = "";
  labelsChanged();
  if (labels.excluded) $("excludeReason").focus();
};
$("excludeReason").oninput = () => { labels.exclude_reason = $("excludeReason").value; renderLabels(); scheduleSave(); };
// à revoir plus tard : simple signalement, ne change pas les tracks
$("chkReview").onchange = () => {
  labels.to_review = $("chkReview").checked;
  if (!labels.to_review) labels.review_reason = "";
  renderLabels(); scheduleSave();
  if (labels.to_review) $("reviewReason").focus();
};
$("reviewReason").oninput = () => { labels.review_reason = $("reviewReason").value; renderLabels(); scheduleSave(); };
document.querySelectorAll("#labels input[type=radio]").forEach(i => i.onchange = () => {
  // modifier une étiquette pré-remplie : on part des valeurs du bloc, qui deviennent celles du clip
  if (!ownScenario() && C.inherited) for (const k of LABEL_KEYS) labels[k] = C.inherited[k];
  labels[i.name] = i.value;
  labelsTouched = true;
  if (labels.condition !== "scenario") for (const k of LABEL_KEYS.slice(1)) labels[k] = "";
  labelsChanged();
});

$("chkReviewed").onchange = () => { reviewed = $("chkReviewed").checked; scheduleSave(); };
$("btnDone").onclick = async () => {
  reviewed = true; $("chkReviewed").checked = true; dirty = true;
  if (await save()) stepClip(+1);
};
$("btnPlay").onclick = togglePlay;
$("selRate").onchange = () => { video.playbackRate = +$("selRate").value; syncDrone(true); };
$("seek").oninput = () => setFrame(+$("seek").value);
$("chkDead").onchange = () => { resolve(); renderAll(); };
$("btnZoom").onclick = resetView;
$("btnDelete").onclick = doDelete;
$("btnMerge").onclick = doMerge;
$("btnDeleteBox").onclick = doDeleteBox;
$("btnSplit").onclick = doSplit;
$("btnKeep").onclick = doKeep;
$("btnDraw").onclick = () => setDrawMode(!drawMode);
$("btnClass").onclick = relabelAction;
$("btnClear").onclick = () => select(null, false);
$("btnUndo").onclick = undo;
$("btnReset").onclick = () => {
  if (confirm("Effacer toutes les corrections de ce clip ?")) { ops = []; undoSizes = []; afterEdit(); }
};

$("map").addEventListener("click", clickMap);
$("chkSat").onchange = () => toggleSat($("chkSat").checked);
$("btnSatFollow").onclick = () => setSatFollow(!satFollow);
$("btnSatFit").onclick = () => { setSatFollow(false); satLoadClip(); };
// affichée par défaut ; masquée seulement si on l'a fermée la dernière fois
toggleSat((() => { try { return localStorage.getItem("ct_sat") !== "0"; } catch { return true; } })());
document.querySelectorAll("[data-range]").forEach(b => b.onclick = () => setMapRange(+b.dataset.range));
setMapRange(mapRange);

window.addEventListener("keydown", (e) => {
  if (!C || e.target.matches("input[type=text], select")) return;
  if (e.target.matches("input[type=radio]")) e.target.blur();
  const k = e.key;
  if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (k === " ") { e.preventDefault(); togglePlay(); }
  else if (k === "ArrowRight") { e.preventDefault(); setFrame(frame + (e.shiftKey ? 10 : 1)); }
  else if (k === "ArrowLeft") { e.preventDefault(); setFrame(frame - (e.shiftKey ? 10 : 1)); }
  else if (k === "]") jumpBoundary(+1);
  else if (k === "[") jumpBoundary(-1);
  else if (k === "d" || k === "D" || k === "Delete" || k === "Backspace") { e.preventDefault(); doDelete(); }
  else if (k === "x" || k === "X") doDeleteBox();
  else if (k === "b" || k === "B") doSplit();
  else if (k === "k" || k === "K") doKeep();
  else if (k === "n" || k === "N") setDrawMode(!drawMode);
  else if (k === "m" || k === "M") doMerge();
  else if (k === "t" || k === "T") relabelAction();
  else if (k === "g" || k === "G") toggleSat($("satsec").hidden);
  else if (k === "v" || k === "V") { if (!$("chkDrone").disabled) toggleDrone(!$("chkDrone").checked); }
  else if (k === ",") shiftDroneOffset(-0.1);
  else if (k === ".") shiftDroneOffset(+0.1);
  else if (k === "Escape") { if (drawMode) setDrawMode(false); else select(null, false); }
  else if (k === "0") resetView();
  else if (k === "Enter") { e.preventDefault(); $("btnDone").click(); }
});

loadClips().catch(e => setStatus("serveur injoignable", "err"));
