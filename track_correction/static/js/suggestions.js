"use strict";
// Raccrochages proposés par le serveur (track_correction/pedestrians.py) : fin d'un morceau de
// piéton ↔ début du suivant, avec deux vignettes pour vérifier que c'est la même personne.

// boîte d'un track (id affiché) sur une frame, boîtes retirées comprises
function boxOf(id, f) {
  const b = frameBoxes(f, true).find(b => b.id === id);
  return b ? b.box : null;
}

function thumbUrl(f, box) {
  return `/thumb/${C.participant}/${C.clip}/${f}?b=${box.map(v => v.toFixed(4)).join(",")}`;
}

function renderSuggestions() {
  const el = $("sugg");
  const list = linkSugg.filter(l => allById.has(l.src) && allById.has(l.dst));
  $("nsugg").textContent = list.length ? `(${list.length})` : "";
  if (!list.length) { el.innerHTML = `<span class="muted">aucun</span>`; return; }
  el.innerHTML = list.map((l, i) => {
    const a = allById.get(l.src), b = allById.get(l.dst);
    const ba = boxOf(a.id, a.last), bb = boxOf(b.id, b.first);
    const img = (f, box) => box ? `<img src="${thumbUrl(f, box)}" loading="lazy" alt="">` : `<span class="noimg">—</span>`;
    const info = [`trou ${l.gap_s.toFixed(1)} s`, l.dist_m == null ? "" : `${l.dist_m.toFixed(1)} m`,
                  l.pass === 2 ? "moins sûr" : ""].filter(Boolean).join(" · ");
    return `<div class="sugg">
      ${img(a.last, ba)}${img(b.first, bb)}
      <div class="sugginfo"><b>#${a.id} → #${b.id}</b><br><span class="muted">${info}</span><br>
        <button data-see="${i}">voir</button><button data-acc="${i}" class="primary">fusionner</button></div>
    </div>`;
  }).join("");
  el.querySelectorAll("[data-see]").forEach(btn => btn.onclick = () => {
    const l = list[+btn.dataset.see];
    selected = new Set([l.src, l.dst].filter(id => trackById.has(id)));
    setFrame(allById.get(l.dst).first); renderAll();
  });
  el.querySelectorAll("[data-acc]").forEach(btn => btn.onclick = () => {
    const l = list[+btn.dataset.acc];
    acceptLink(l.src, l.dst);
  });
}
