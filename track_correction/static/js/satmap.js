"use strict";
// Carte satellite (panneau latéral, sous la vue de dessus) : trace GNSS du clip sur orthophoto, synchronisée avec la vidéo.
// Fond IGN (BD ORTHO ~20 cm, natif jusqu'au zoom 19), Esri World Imagery en secours.
// Les usagers sont placés au sol par le serveur (track_correction/geo.py).

let sat = null;                 // { map, trace, done, ego, objs, band, pilot } une fois créée
let satFollow = true;
const SAT_MAX_NATIVE = 19;

function satLayers() {
  const ign = L.tileLayer(
    "https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=ORTHOIMAGERY.ORTHOPHOTOS"
    + "&STYLE=normal&TILEMATRIXSET=PM&FORMAT=image/jpeg&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}",
    { maxNativeZoom: SAT_MAX_NATIVE, maxZoom: 22, attribution: "© IGN – BD ORTHO" });
  const esri = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxNativeZoom: 19, maxZoom: 22, attribution: "© Esri World Imagery" });
  return { "Orthophoto IGN": ign, "Esri satellite": esri };
}

function satCreate() {
  if (sat) return true;
  if (typeof L === "undefined") {
    $("satmsg").textContent = "Leaflet n'a pas pu être chargé (pas d'accès internet ?)";
    $("satmsg").style.display = "flex";
    return false;
  }
  const layers = satLayers();
  const map = L.map("satmap", { zoomControl: true, maxZoom: 22, layers: [layers["Orthophoto IGN"]] });
  L.control.layers(layers, null, { position: "topright" }).addTo(map);
  L.control.scale({ imperial: false }).addTo(map);
  sat = {
    map,
    band: L.polygon([], { color: "#f5b84a", weight: 1.5, fill: false, dashArray: "4 4" }).addTo(map),
    pilot: L.circle([0, 0], { radius: 1, color: "#aaa", weight: 1, fill: false, dashArray: "2 4" }).addTo(map),
    gopro: L.polyline([], { color: "#f5b84a", weight: 1.5, opacity: 0.8, dashArray: "3 5" }).addTo(map),
    trace: L.polyline([], { color: "#ffffff", weight: 2, opacity: 0.55 }).addTo(map),
    done: L.polyline([], { color: "#4da3ff", weight: 4 }).addTo(map),
    objs: L.layerGroup().addTo(map),
    ego: L.marker([0, 0], { icon: satEgoIcon(0), interactive: false, zIndexOffset: 1000 }).addTo(map),
  };
  map.on("dragstart", () => setSatFollow(false));
  new ResizeObserver(() => map.invalidateSize()).observe($("satmap"));
  return true;
}

// flèche de la trottinette équipée, orientée selon son cap (degrés, 0 = nord)
function satEgoIcon(deg) {
  return L.divIcon({
    className: "", iconSize: [22, 22], iconAnchor: [11, 11],
    html: `<svg width="22" height="22" viewBox="-11 -11 22 22" style="transform:rotate(${deg}deg)">
             <path d="M0,-9 L6,7 L0,3 L-6,7 Z" fill="#fff" stroke="#000" stroke-width="1.5"/></svg>`,
  });
}

// nouveau clip : trace complète, contour de la bande, zone du droniste
function satLoadClip() {
  if (!sat || !C) return;
  const pts = (C.gnss || []).map(g => [g[1], g[2]]);
  sat.trace.setLatLngs(pts);
  // trace GoPro (moins précise) affichée en pointillés quand la trace principale est le RTK
  sat.gopro.setLatLngs(C.gnss_src !== "gopro" ? (C.gnss_gopro || []).map(g => [g[1], g[2]]) : []);
  if (C.site) {
    sat.band.setLatLngs(C.site.band);
    sat.pilot.setLatLng([C.site.pilot[0], C.site.pilot[1]]).setRadius(C.site.pilot[2] || 0.01);
  }
  if (pts.length) sat.map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 20 });
  else if (C.site) sat.map.fitBounds(L.latLngBounds(C.site.band).pad(0.5));
  $("satmsg").style.display = pts.length ? "none" : "flex";
  $("satmsg").textContent = pts.length ? "" : "Pas de trace GNSS pour ce clip";
  satRender();
}

// position de la trottinette à t secondes (interpolée) et cap sur ±1 s
function satEgoAt(t) {
  const g = C.gnss || [];
  if (!g.length) return null;
  let i = g.findIndex(p => p[0] >= t);
  if (i < 0) i = g.length - 1;
  const a = g[Math.max(0, i - 1)], b = g[i];
  const k = b[0] > a[0] ? Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0]))) : 0;
  const lat = a[1] + (b[1] - a[1]) * k, lon = a[2] + (b[2] - a[2]) * k;
  const p0 = g.find(p => p[0] >= t - 1) || g[0];
  const p1 = [...g].reverse().find(p => p[0] <= t + 1) || g[g.length - 1];
  const de = (p1[2] - p0[2]) * Math.cos(lat * Math.PI / 180), dn = p1[1] - p0[1];
  const moving = Math.hypot(de, dn) * 111000 > 0.5;
  return { lat, lon, hdg: moving ? Math.atan2(de, dn) * 180 / Math.PI : null, i };
}

let satLastHdg = 0;
function satRender() {
  if (!sat || !C || $("satsec").hidden) return;
  const t = frame / C.fps, e = satEgoAt(t);
  if (e) {
    if (e.hdg !== null) satLastHdg = e.hdg;
    sat.ego.setLatLng([e.lat, e.lon]).setIcon(satEgoIcon(satLastHdg));
    sat.done.setLatLngs((C.gnss || []).slice(0, e.i).map(g => [g[1], g[2]]).concat([[e.lat, e.lon]]));
    if (satFollow && !sat.map.getBounds().pad(-0.2).contains([e.lat, e.lon])) sat.map.panTo([e.lat, e.lon], { animate: false });
  }
  // usagers de la frame, placés au sol
  sat.objs.clearLayers();
  for (const p of posByFrame.get(frame) || []) {
    if (p.lat == null) continue;
    const selp = selected.has(p.id);
    const m = L.circleMarker([p.lat, p.lon], {
      radius: selp ? 8 : 6, color: selp ? "#fff" : "#000", weight: selp ? 2.5 : 1,
      fillColor: color(p.id), fillOpacity: 0.95,
    });
    m.bindTooltip(`#${p.id} ${p.cls === "cyclist" ? "cycliste" : "piéton"} · ${p.d.toFixed(1)} m`, { direction: "top" });
    m.on("click", (ev) => select(p.id, ev.originalEvent.shiftKey || ev.originalEvent.metaKey || ev.originalEvent.ctrlKey));
    sat.objs.addLayer(m);
  }
  const u = C.utc0 ? new Date((C.utc0 + t) * 1000).toISOString().slice(11, 21) + " UTC" : "";
  const src = { rtk: "RTK", dgps: "DGPS", "rtk+dgps": "RTK + DGPS", gopro: "GPS GoPro" }[C.gnss_src] || "";
  $("satinfo").textContent = e ? `${src} · ${u} · ${(C.gnss[e.i]?.[3] * 3.6 || 0).toFixed(1)} km/h` : "";
}

function setSatFollow(on) {
  satFollow = on;
  $("btnSatFollow").classList.toggle("on", on);
  if (on) satRender();
}

// section affichée / masquée (case « carte » ou G), état gardé entre deux sessions
function toggleSat(on) {
  $("satsec").hidden = !on;
  $("chkSat").checked = on;
  try { localStorage.setItem("ct_sat", on ? "1" : "0"); } catch {}
  if (on && satCreate()) { sat.map.invalidateSize(); satLoadClip(); }
}
