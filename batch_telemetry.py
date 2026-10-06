#!/usr/bin/env python3
"""
Traite tous les .360 (P01..P20, dossiers v et t), ecrit les CSV de telemetrie
a cote de chaque video, et produit un rapport de qualite GPS.

  python3 batch_telemetry.py

Sortie :
  - <video>_cori.csv / <video>_gps.csv  a cote de chaque .360
  - telemetry_quality.csv               a la racine (resume)
  - affiche a l'ecran les fichiers au GPS douteux.

Criteres "mauvais GPS" :
  - pas de flux/points GPS du tout
  - moins de 70% des points en fix 3D
  - DOP median > 5.0  (precision mediocre)
"""
import sys
import time
import traceback
from pathlib import Path
from statistics import median

sys.path.insert(0, str(Path(__file__).resolve().parent))
from gopro_telemetry import extract_gopro_telemetry, _to_dataframe

ROOT = Path(__file__).resolve().parent

FIX_LABEL = {0: "no-fix", 2: "2D", 3: "3D"}


def quality(gps):
    n = len(gps)
    if n == 0:
        return {"n": 0, "fix3d_pct": 0.0, "dop_med": None, "verdict": "MAUVAIS",
                "raison": "aucun point GPS"}
    fixes = [g["fix"] for g in gps if g["fix"] is not None]
    n3d = sum(1 for fx in fixes if fx == 3)
    fix3d_pct = 100.0 * n3d / n
    dops = [g["dop"] / 100.0 for g in gps if g["dop"] is not None]
    dop_med = median(dops) if dops else None

    raisons = []
    if fix3d_pct < 70:
        raisons.append(f"fix3D={fix3d_pct:.0f}%")
    if dop_med is not None and dop_med > 5.0:
        raisons.append(f"DOP={dop_med:.1f}")
    verdict = "MAUVAIS" if raisons else "ok"
    return {"n": n, "fix3d_pct": fix3d_pct, "dop_med": dop_med,
            "verdict": verdict, "raison": ", ".join(raisons)}


def main():
    files = sorted(p for p in ROOT.glob("P??/[vt]/*.360")
                   if not p.name.startswith("._"))
    print(f"{len(files)} fichiers a traiter\n")

    rows = []
    bad = []
    for i, vid in enumerate(files, 1):
        rel = vid.relative_to(ROOT)
        t0 = time.time()
        try:
            tel = extract_gopro_telemetry(str(vid))
            if tel["cori"]:
                _to_dataframe(tel["cori"]).to_csv(
                    vid.with_name(vid.stem + "_cori.csv"), index=False)
            if tel["gps"]:
                _to_dataframe(tel["gps"]).to_csv(
                    vid.with_name(vid.stem + "_gps.csv"), index=False)
            q = quality(tel["gps"])
            dt = time.time() - t0
            print(f"[{i:3}/{len(files)}] {rel}  "
                  f"CORI={len(tel['cori']):5} GPS={q['n']:5} "
                  f"fix3D={q['fix3d_pct']:3.0f}% "
                  f"DOP={q['dop_med'] if q['dop_med'] is not None else '-'}  "
                  f"{q['verdict']}  ({dt:.0f}s)")
            row = {"file": str(rel), "cori": len(tel["cori"]), **q}
            rows.append(row)
            if q["verdict"] == "MAUVAIS":
                bad.append(row)
        except Exception as e:
            print(f"[{i:3}/{len(files)}] {rel}  ERREUR: {e}")
            traceback.print_exc()
            rows.append({"file": str(rel), "cori": 0, "n": 0,
                         "fix3d_pct": 0, "dop_med": None,
                         "verdict": "ERREUR", "raison": str(e)})
            bad.append(rows[-1])

    _to_dataframe(rows).to_csv(ROOT / "telemetry_quality.csv", index=False)

    print("\n" + "=" * 70)
    print(f"RESUME : {len(rows)} fichiers, {len(bad)} avec GPS douteux/erreur")
    print("=" * 70)
    for r in bad:
        print(f"  {r['file']:24} {r['verdict']:8} {r.get('raison','')}")
    print(f"\nRapport complet : telemetry_quality.csv")


if __name__ == "__main__":
    main()
