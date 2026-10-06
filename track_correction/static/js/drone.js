"use strict";
// Vidéo drone synchronisée par l'heure UTC (cf. track_correction/drone.py), décalage, zoom.

// ------------------------------------------------------------------ drone
// position dans la vidéo drone = utc - t0 - offset (cf. clip_drones() dans correct_tracks.py)
const drone = $("drone");
let droneSeg = null, droneView = { z: 1, x: 0, y: 0 }, offTimer = null;
const droneOn = () => !!(C && C.drones && C.drones.length && $("chkDrone").checked);
const mainTime = () => C.video_ok && !video.paused ? video.currentTime : (frame + 0.5) / C.fps;

function droneTarget() {
  if (!C?.utc0) return null;
  const u = C.utc0 + mainTime();
  for (const s of C.drones) {
    const t = u - s.t0 - s.offset;
    if (t >= 0 && t <= s.duration) return [s, t];
  }
  return null;
}

function droneMsg(txt) { $("dronemsg").textContent = txt; $("dronemsg").style.display = txt ? "flex" : "none"; }

function syncDrone(force = false) {
  if (!droneOn()) { if (!drone.paused) drone.pause(); return; }
  const r = droneTarget();
  if (!r) {
    drone.pause(); droneMsg("Pas de vidéo drone à cet instant"); $("dronename").textContent = "";
    return;
  }
  const [s, t] = r;
  droneMsg("");
  if (droneSeg !== s) {
    droneSeg = s; drone.src = `/drone/${s.name}`; force = true;
    $("droneoff").textContent = s.offset.toFixed(1);
  }
  $("dronename").textContent = `${s.name} · ${t.toFixed(1)} s`;
  if (drone.readyState < 1) return;               // reprise au loadedmetadata
  drone.playbackRate = video.playbackRate;
  const playing = C.video_ok && !video.paused;
  // en lecture on ne recale que si l'écart devient visible, sinon saccades
  if (force || !playing || Math.abs(drone.currentTime - t) > 0.25) drone.currentTime = t;
  if (playing && drone.paused) drone.play().catch(() => {});
  if (!playing && !drone.paused) drone.pause();
}
drone.addEventListener("loadedmetadata", () => syncDrone(true));
video.addEventListener("play", () => syncDrone(true));
video.addEventListener("pause", () => syncDrone(true));
video.addEventListener("seeked", () => syncDrone(true));

function shiftDroneOffset(delta, absolute = false) {
  if (!droneSeg) return;
  const s = droneSeg;
  s.offset = Math.round((absolute ? delta : s.offset + delta) * 100) / 100;
  // même vidéo drone partagée par plusieurs segments du clip : même décalage
  for (const o of C.drones) if (o.name === s.name) o.offset = s.offset;
  $("droneoff").textContent = s.offset.toFixed(1);
  syncDrone(true);
  clearTimeout(offTimer);
  offTimer = setTimeout(() => fetch("/api/drone_offset", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: s.name, offset: s.offset }),
  }).catch(e => setStatus("décalage drone non enregistré", "err")), 400);
}
document.querySelectorAll("[data-doff]").forEach(b => b.onclick = (e) => {
  e.stopPropagation();
  const d = +b.dataset.doff;
  d === 0 ? shiftDroneOffset(C.drone_default ?? 0, true) : shiftDroneOffset(d);
});
$("btnOffAll").onclick = async (e) => {
  e.stopPropagation();
  if (!droneSeg) return;
  const off = droneSeg.offset;
  if (!confirm(`Utiliser un décalage de ${off.toFixed(2)} s pour toutes les vidéos drone ?\n` +
               `(les réglages faits vidéo par vidéo seront remplacés)`)) return;
  clearTimeout(offTimer);
  const r = await fetch("/api/drone_offset", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "*", offset: off }) });
  if (!r.ok) { setStatus("décalage drone non enregistré", "err"); return; }
  C.drone_default = off;
  for (const o of C.drones) o.offset = off;
  setStatus(`décalage drone ${off.toFixed(2)} s pour toutes les vidéos`);
};

// zoom / déplacement dans la vidéo drone (4K vue de dessus : les usagers y sont petits)
function applyDroneView() {
  const db = $("dronebox"), w = db.clientWidth, h = db.clientHeight;
  droneView.z = Math.max(1, Math.min(10, droneView.z));
  droneView.x = Math.min(0, Math.max(w - w * droneView.z, droneView.x));
  droneView.y = Math.min(0, Math.max(h - h * droneView.z, droneView.y));
  drone.style.transform = `translate(${droneView.x}px, ${droneView.y}px) scale(${droneView.z})`;
}
$("dronebox").addEventListener("wheel", (e) => {
  e.preventDefault();
  const r = $("dronebox").getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  const z = Math.max(1, Math.min(10, droneView.z * Math.exp(-e.deltaY * 0.0015)));
  droneView.x = mx - (mx - droneView.x) * z / droneView.z; droneView.y = my - (my - droneView.y) * z / droneView.z;
  droneView.z = z; applyDroneView();
}, { passive: false });
let droneDrag = null;
$("dronebox").addEventListener("mousedown", (e) => {
  if (e.target.closest("button")) return;
  droneDrag = { x: e.clientX, y: e.clientY, vx: droneView.x, vy: droneView.y };
});
window.addEventListener("mousemove", (e) => {
  if (!droneDrag) return;
  droneView.x = droneDrag.vx + e.clientX - droneDrag.x; droneView.y = droneDrag.vy + e.clientY - droneDrag.y;
  applyDroneView();
});
window.addEventListener("mouseup", () => { droneDrag = null; });
$("dronebox").addEventListener("dblclick", () => { droneView = { z: 1, x: 0, y: 0 }; applyDroneView(); });

function toggleDrone(on) {
  $("chkDrone").checked = on;
  try { localStorage.setItem("ct_drone", on ? "1" : "0"); } catch {}
  if (!on) drone.pause();
  layout(); syncDrone(true);
}
$("chkDrone").onchange = () => toggleDrone($("chkDrone").checked);
try { $("chkDrone").checked = localStorage.getItem("ct_drone") === "1"; } catch {}

function togglePlay() { if (!C?.video_ok) return; video.paused ? video.play() : video.pause(); }

function jumpBoundary(dir) {
  // débuts et fins de tracks vivants : là où se produisent les changements d'id
  const pts = [...new Set(tracks.flatMap(t => [t.first, t.last]))].sort((a, b) => a - b);
  const f = dir > 0 ? pts.find(x => x > frame) : pts.reverse().find(x => x < frame);
  if (f !== undefined) setFrame(f);
}

