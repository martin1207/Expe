#!/usr/bin/env python
"""Interface web de correction des tracks YOLO11x + ByteTrack.

On ouvre un clip, la vidéo 360 est affichée avec ses boîtes, la vidéo drone synchronisée et
une vue de dessus des distances. En cliquant sur une boîte (ou une ligne de la liste / de la
frise) on sélectionne un track, puis :

    Suppr / D     supprime le track (faux positif, reflet...)
    M             fusionne les tracks sélectionnés : ils prennent tous le plus petit id
    T             corrige la classe : person <-> cyclist
    K             garde un track retiré d'office (conducteur, hors chemin, en trop, droniste)
    Ctrl/Cmd-Z    annule la dernière opération

Corrections NON destructives, à côté du CSV brut (jamais modifié) :

    runs_yolo11x/P01/P1_t_001_corrections.json      opérations et étiquettes du clip
    runs_yolo11x/P01/P1_t_001_tracks_corrected.csv  CSV corrigé

Plusieurs modèles : chaque dossier runs_* au même format (runs_rfdetr de batch_rfdetr_track.py...)
est une source de détections ; le menu à droite du clip montre le modèle affiché et permet d'en
changer. Corrections de tracks propres à chaque modèle, étiquettes du clip communes (gardées dans
runs_yolo11x, comme les exports). Voir track_correction/sources.py.

Le code est dans le paquet track_correction/ (un module par étape, voir son __init__.py) :
zone ego, cyclistes, distance / angle, droniste, piétons (conducteur, hors chemin, 5 au plus,
raccrochages proposés), tracks courts, passages coupés, drone, export.

Exemples
--------
    python correct_tracks.py                   # puis ouvrir http://127.0.0.1:5055
    python correct_tracks.py --port 8000
    python correct_tracks.py --ego-yaw 165     # zone ego plus large (0 = désactivée)
    python correct_tracks.py --cyc-iou 0.1     # association cycliste plus permissive
    python correct_tracks.py --min-frames 10   # retire les tracks de moins de 10 frames (15 par défaut)
    python correct_tracks.py --auto-link       # applique d'office les raccrochages de piétons proposés
    python correct_tracks.py --export-all      # runs_yolo11x/all_tracks_corrected.csv
                                               # et runs_yolo11x/clip_labels.csv
    python correct_tracks.py --export-scenarios  # runs_yolo11x/P{nn}/P{nn}_scenarios.csv seuls
                                               # (aussi écrits par l'interface à chaque enregistrement)

Nécessite Flask. Lecture vidéo HEVC : Safari ou Chrome récent sur macOS.
"""

from __future__ import annotations

import argparse
import sys

from track_correction import config


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5055)
    ap.add_argument("--ego-yaw", type=float, default=config.EGO_YAW,
                    help="retire les boîtes qui dépassent ±N° (zone arrière = ego) ; 0 = désactivé")
    ap.add_argument("--cyc-iou", type=float, default=config.CYC["iou"],
                    help="cycliste : IoU personne/vélo minimale sur une frame")
    ap.add_argument("--cyc-frac", type=float, default=config.CYC["frac"],
                    help="cycliste : part minimale des frames communes où la personne est sur le vélo")
    ap.add_argument("--cyc-min-frames", type=int, default=config.CYC["min_frames"],
                    help="cycliste : nombre minimal de frames communes")
    ap.add_argument("--min-frames", type=int, default=config.MIN_TRACK_FRAMES,
                    help="retire les tracks présents sur moins de N frames (0 = garder tout)")
    ap.add_argument("--pilot-radius", type=float, default=config.PILOT_RADIUS_M,
                    help="retire les piétons à moins de N m de l'emplacement du droniste (0 = garder)")
    ap.add_argument("--auto-link", action="store_true",
                    help="applique d'office les raccrochages de piétons (sinon proposés dans l'interface)")
    ap.add_argument("--max-pedestrians", type=int, default=config.N_PEDESTRIANS,
                    help="piétons simultanés au plus (0 = pas de limite)")
    ap.add_argument("--path-margin", type=float, default=config.PATH_MARGIN_M,
                    help="retire les piétons à plus de N m de la bande Transpolis (< 0 = garder)")
    ap.add_argument("--export-all", action="store_true",
                    help="écrire all_tracks_corrected.csv et clip_labels.csv puis quitter")
    ap.add_argument("--export-scenarios", action="store_true",
                    help="écrire le scénario de chaque clip, un CSV par participant, puis quitter")
    args = ap.parse_args()

    config.EGO_YAW = args.ego_yaw
    config.MIN_TRACK_FRAMES = args.min_frames
    config.PILOT_RADIUS_M = args.pilot_radius
    config.AUTO_LINK_PEDESTRIANS = args.auto_link
    config.N_PEDESTRIANS = args.max_pedestrians
    config.PATH_MARGIN_M = args.path_margin
    config.CYC.update(iou=args.cyc_iou, frac=args.cyc_frac, min_frames=args.cyc_min_frames)

    if args.export_all:
        from track_correction.export import export_all
        return export_all()
    if args.export_scenarios:
        from track_correction.export import export_scenarios
        return export_scenarios()

    from track_correction.server import app, warm_up
    warm_up()
    print(f"Correction des tracks : http://{args.host}:{args.port}")
    # pas de .env dans le projet : sa recherche appelle os.getcwd(), qui plante si le
    # dossier courant du terminal a disparu (disque externe démonté puis remonté)
    app.run(host=args.host, port=args.port, debug=False, threaded=True, load_dotenv=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
