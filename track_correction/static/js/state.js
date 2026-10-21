"use strict";
// Éléments de la page, état partagé et couleurs des tracks.

const $ = (id) => document.getElementById(id);
const video = $("video"), stage = $("stage"), world = $("world"), overlay = $("overlay");
const tl = $("timeline"), tlwrap = $("tlwrap");
const octx = overlay.getContext("2d"), tctx = tl.getContext("2d");

// ------------------------------------------------------------------ état
let clips = [];                 // [{participant, clip, n_ops, reviewed}]
let C = null;                   // clip courant (réponse /api/clip) ; C.source : dossier runs_* affiché
let byFrame = new Map();        // frame -> [indices dans C.detections]
let ops = [], undoSizes = [];   // opérations + taille de chaque action (pour annuler d'un bloc)
let reviewed = false;
let labelsTouched = false;      // étiquettes de scénario modifiées : les clips du même bloc en héritent
const LABEL_KEYS = ["condition", "mmv_direction", "ped_crossing", "ped_distance"];
let labels = {};               // étiquettes du clip, mêmes clés que LABELS dans correct_tracks.py
// rejeu des corrections, une valeur par détection (index dans C.detections)
let idOf = [];                  // id final (après fusions / coupures), -1 sans id
let deadK = [];                 // true si la boîte est supprimée (track ou frame)
let uncutOf = [];               // id du track sans les coupures (fusions appliquées), -1 sans id
let cycAlias = new Map();       // morceaux réunis par le serveur : cycliste unique (track_alias)
let cycBoxes = new Map();       // "frame:id" -> [x1n, y1n, x2n, y2n, parts] : boîtes cycliste du serveur
let tracks = [];                // tracks vivants, triés par première frame
let trackById = new Map();
let deadTracks = [];
let nLoneBikes = 0, nShort = 0;   // tracks retirés d'office : vélos seuls, trop courts
// tracks retirés d'office par le serveur : id -> raison (pilot, rider, offpath, extra), cf. pipeline.py
let removedIds = new Map();
let keptIds = new Set();          // ids finaux gardés à la main (K) ou avec une boîte dessinée
let allById = new Map();          // tous les tracks construits, retirés compris (id affiché -> track)
let linkSugg = [];                // raccrochages proposés (track_correction/pedestrians.py)
let goneCounts = {};              // tracks retirés d'office par raison (court compris)
// raisons d'un retrait d'office : visibles en gris avec « supprimés », sélectionnables
const AUTO_GONE = new Set(["short", "pilot", "rider", "offpath", "extra"]);
const GONE_TXT = { short: "court", pilot: "droniste", rider: "conducteur", offpath: "hors chemin", extra: "en trop" };
let selected = new Set();       // ids finaux
let frame = 0;
let view = { z: 1, x: 0, y: 0 };
let saveTimer = null, dirty = false;
// paires cycliste calculées par le serveur (cyclist_pairs() dans correct_tracks.py)
let cyclists = [], cycBike = new Map(), cycPerson = new Map();   // vélo -> personne, personne -> paire
let classOv = new Map();        // id final -> classe corrigée à la main ("person" | "cyclist")

const TL_ROW = 14, TL_LABEL = 46, TL_HEAD = 10;

// ------------------------------------------------------------------ couleurs
function color(id, alpha = 1) {
  if (id < 0) return `rgba(180,180,180,${alpha})`;
  const h = (id * 137.508) % 360;
  return `hsla(${h}, 85%, 60%, ${alpha})`;
}

