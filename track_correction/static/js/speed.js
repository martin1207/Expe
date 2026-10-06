"use strict";
// Vitesse de la trottinette sur le clip, alignée sur la frise des tracks (même axe des x) :
// compteur de la trottinette (absent pour certaines sessions, dont le 23/06 = P05-P08),
// RTK et GPS GoPro. Données synchronisées par le serveur (track_correction/speed.py).

const SPEED_H = 70;
const SPEED_COLORS = { scooter: "#3ecf8e", rtk: "#4da3ff", gopro: "#f5b84a" };
let speedBase = null;     // image des courbes sans curseur

// x de la frise pour un temps t (s) : même repère que renderTimeline()
function speedX(t, w) {
  const f = t * C.fps;
  return TL_LABEL + (f / Math.max(1, C.n_frames - 1)) * (w - TL_LABEL - 8);
}

function speedAt(series, t) {
  if (!series || series.length < 2 || t < series[0][0] || t > series[series.length - 1][0]) return null;
  let i = series.findIndex(p => p[0] >= t);
  if (i <= 0) return series[0][1];
  const a = series[i - 1], b = series[i];
  if (b[0] - a[0] > 1.5) return null;                 // trou dans les données
  return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0]);
}

function renderSpeed() {
  const cv = $("speedplot");
  if (!cv || !C) return;
  const dpr = window.devicePixelRatio || 1, w = $("speedwrap").clientWidth;
  cv.width = w * dpr; cv.height = SPEED_H * dpr; cv.style.height = SPEED_H + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#111418"; ctx.fillRect(0, 0, w, SPEED_H);
  const sp = C.speed || {};
  const all = [...(sp.scooter || []), ...(sp.rtk || [])].map(p => p[1]);
  const vmax = Math.max(10, Math.ceil((Math.max(0, ...all) + 2) / 5) * 5);
  const y = (v) => SPEED_H - 4 - (v / vmax) * (SPEED_H - 10);

  // grille tous les 5 km/h
  ctx.font = "10px ui-monospace, Menlo, monospace"; ctx.textBaseline = "middle";
  for (let v = 0; v <= vmax; v += 5) {
    ctx.strokeStyle = "#20252c"; ctx.beginPath(); ctx.moveTo(TL_LABEL, y(v)); ctx.lineTo(w - 8, y(v)); ctx.stroke();
    if (v % 10 === 0) { ctx.fillStyle = "#8c96a3"; ctx.fillText(`${v}`, 4, y(v)); }
  }
  ctx.fillStyle = "#8c96a3"; ctx.fillText("km/h", 18, 8);

  const draw = (series, col, dash) => {
    if (!series || !series.length) return;
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.setLineDash(dash || []);
    ctx.beginPath();
    let prev = null;
    for (const [t, v] of series) {
      const X = speedX(t, w), Y = y(v);
      if (prev && t - prev > 1.5) ctx.moveTo(X, Y); else if (prev === null) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
      prev = t;
    }
    ctx.stroke(); ctx.setLineDash([]);
  };
  draw(sp.gopro, SPEED_COLORS.gopro, [3, 4]);
  draw(sp.rtk, SPEED_COLORS.rtk);
  draw(sp.scooter, SPEED_COLORS.scooter);
  if (!(sp.scooter || []).length) {
    ctx.fillStyle = "#f5b84a"; ctx.textAlign = "right";
    ctx.fillText("compteur de la trottinette : pas de données pour cette session", w - 12, 9);
    ctx.textAlign = "left";
  }
  speedBase = ctx.getImageData(0, 0, cv.width, cv.height);
  renderSpeedCursor();
}

function renderSpeedCursor() {
  if (!speedBase || !C) return;
  const cv = $("speedplot"), ctx = cv.getContext("2d"), w = $("speedwrap").clientWidth;
  ctx.putImageData(speedBase, 0, 0);
  const t = frame / C.fps, x = speedX(t, w);
  ctx.fillStyle = "#fff"; ctx.fillRect(x - 0.5, 0, 1, SPEED_H);
  const sp = C.speed || {}, fmt = (v) => v == null ? "—" : v.toFixed(1);
  const sc = speedAt(sp.scooter, t), rk = speedAt(sp.rtk, t), gp = speedAt(sp.gopro, t);
  $("speedinfo").innerHTML =
    `<span style="color:${SPEED_COLORS.scooter}">compteur ${(sp.scooter || []).length ? fmt(sc) : "absent"}</span>`
    + ` · <span style="color:${SPEED_COLORS.rtk}">RTK ${fmt(rk)}</span>`
    + ` · <span style="color:${SPEED_COLORS.gopro}">GoPro ${fmt(gp)}</span> km/h`;
}

$("speedplot").addEventListener("click", (e) => {
  if (!C) return;
  const r = $("speedplot").getBoundingClientRect(), w = $("speedwrap").clientWidth, x = e.clientX - r.left;
  if (x > TL_LABEL) setFrame(Math.round(((x - TL_LABEL) / (w - TL_LABEL - 8)) * (C.n_frames - 1)));
});
