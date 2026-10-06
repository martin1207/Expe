#!/usr/bin/env python
"""Rallonge les clips Transpolis raccourcis par une erreur GPS latérale.

clip_transpolis.py garde les instants où le GPS est dans le polygone Transpolis, une bande
de 46 m x 6.7 m. Quand le cycliste roule le long d'un bord, une erreur GPS de 0.3 à 1 m
le fait « sortir » de la bande : le clip commence trop tard ou finit trop tôt alors qu'il
est toujours dans la rue (ex. P1_t_010 finit 4 s avant le bout des façades, P1_t_011
commence 4.8 s après le demi-tour).

Ici la zone est élargie de LAT_TOL m sur les deux côtés longs de la bande seulement, ses
bouts ne bougent pas : un demi-tour au-delà d'un bout sépare toujours deux passages. Un
point est dans la zone s'il est dans le polygone d'origine OU dans la bande élargie. Les
intervalles sont ensuite calculés exactement comme dans clip_transpolis.py (PAD, GAP_MERGE,
MIN_DUR).

Chaque clip `t` existant est rapproché de son intervalle élargi ; s'il lui manque plus de
MIN_GAIN s au début ou à la fin, il est réencodé sous le même nom (mêmes sources et même
encodage que clip_transpolis.py). Les anciennes versions sont déplacées, pas supprimées :

    P01/clips/_recut_bounds/            ancien .mp4 et .csv
    runs_yolo11x/P01/_recut_bounds/     anciennes sorties YOLO et corrections

Un clip réencodé n'a plus de `_run.json` : batch_yolo11x_track.py le traitera à nouveau.

    python recut_clip_bounds.py --dry-run    # liste des clips à rallonger
    python recut_clip_bounds.py              # réencode
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import clip_transpolis as ctp                       # noqa: E402
from track_correction.config import RUNS               # noqa: E402
from track_correction.io_utils import natural_key       # noqa: E402
from track_correction.passes import band_frame          # noqa: E402

LAT_TOL = 2.0              # m de tolérance sur les côtés longs de la bande
MIN_GAIN = 1.0             # s : on ne réencode que si le clip gagne plus que ça d'un côté
BITRATE_FROM_MP4 = "80M"   # comme clip_transpolis.py quand il part des exports .mp4
BACKUP = "_recut_bounds"


def tolerant_inside():
    orig, _ = ctp.make_point_test(ctp.GPKG)
    uv, length, half = band_frame()

    def inside(lon, lat):
        if lon is None or lat is None:
            return False
        if orig(lon, lat):
            return True
        u, v = uv(lon, lat)
        return 0 <= u <= length and abs(v) <= half + LAT_TOL
    return inside


def clip_start(csv_path: Path, utc_to_t: dict[str, float]) -> tuple[float, float] | None:
    """(début, fin) du clip en temps de session, d'après son CSV GPS (t recalé à 0)."""
    rows = list(csv.DictReader(open(csv_path, newline="")))
    for r in rows:
        if r.get("utc") in utc_to_t:
            s = utc_to_t[r["utc"]] - float(r["t"])
            return s, s + float(rows[-1]["t"])
    return None


def plan_participant(pdir: Path, inside) -> list[dict]:
    plans = []
    clips = sorted((c for c in (pdir / "clips").glob("P*_t_*.csv") if not c.name.startswith("._")),
                   key=lambda p: natural_key(p.name))
    sessions = ctp.group_sessions(pdir / "t")
    for recid in sorted(sessions):
        chapters = sessions[recid]
        points, offsets, durations = ctp.session_gps(chapters)
        if not points:
            continue
        t_end = offsets[-1] + durations[-1]
        utc_to_t = {g["utc"]: g["t"] for g in points if g.get("utc")}
        new = ctp.find_intervals(points, inside, ctp.PAD, ctp.GAP_MERGE, ctp.MIN_DUR, t_end)
        cur = []
        for c in clips:
            r = clip_start(c, utc_to_t)
            if r:
                cur.append((c, *r))
        for c, s, e in cur:
            m = [(ns, ne) for ns, ne in new if ns < e and ne > s]
            if len(m) != 1:
                print(f"  {c.stem} : {len(m)} intervalle(s) élargi(s), laissé tel quel")
                continue
            ns, ne = m[0]
            # l'intervalle élargi ne doit pas avaler un autre clip (= nouveau passage coupé)
            others = [o for o, os_, oe in cur if o != c and os_ < ne and oe > ns]
            if others:
                print(f"  {c.stem} : rejoindrait {[o.stem for o in others]}, laissé tel quel")
                continue
            gain_s, gain_e = s - ns, ne - e
            if gain_s > MIN_GAIN or gain_e > MIN_GAIN:
                plans.append({"pid": pdir.name, "clip": c.stem, "recid": recid,
                              "s": min(s, ns), "e": max(e, ne), "old": (s, e),
                              "gain": (gain_s, gain_e), "chapters": chapters,
                              "offsets": offsets, "durations": durations, "points": points})
    return plans


def move(src: Path, dst_dir: Path) -> None:
    dst_dir.mkdir(parents=True, exist_ok=True)
    dst = dst_dir / src.name
    if dst.exists():
        raise SystemExit(f"{dst} existe déjà : rien n'est écrasé, arrêt.")
    shutil.move(str(src), str(dst))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="lister sans rien modifier")
    ap.add_argument("--only", nargs="+", metavar="P##", help="ne traiter que ces participants")
    args = ap.parse_args()

    inside = tolerant_inside()
    pdirs = sorted(p for p in ROOT.glob("P??") if (p / "t").is_dir())
    if args.only:
        pdirs = [p for p in pdirs if p.name in set(args.only)]
    plans = []
    for pdir in pdirs:
        plans += plan_participant(pdir, inside)

    for p in plans:
        print(f"{p['clip']:10s} {p['old'][1] - p['old'][0]:5.1f} s -> {p['e'] - p['s']:5.1f} s "
              f"(+{max(0, p['gain'][0]):.1f} s au début, +{max(0, p['gain'][1]):.1f} s à la fin)")
    print(f"\n{len(plans)} clip(s) à rallonger (gain > {MIN_GAIN} s d'un côté).")
    if args.dry_run or not plans:
        return 0

    t0 = time.time()
    for k, p in enumerate(plans, 1):
        clips_dir, runs_dir = ROOT / p["pid"] / "clips", RUNS / p["pid"]
        sources = [ctp.find_export_mp4(c) for c in p["chapters"]]
        if any(x is None for x in sources):
            print(f"[{k}/{len(plans)}] {p['clip']} : export .mp4 manquant, sauté")
            continue
        # encodage dans un fichier temporaire, puis mise de côté de l'ancienne version
        tmp = clips_dir / f"{p['clip']}.part.mp4"
        ctp.cut_clip(p["chapters"], p["offsets"], p["durations"], p["s"], p["e"], tmp,
                     ctp.EQ_W, ctp.EQ_H, BITRATE_FROM_MP4, ctp.ENCODER, sources=sources)
        for f in list(clips_dir.glob(f"{p['clip']}.*")):
            if not f.name.startswith("._") and f != tmp:
                move(f, clips_dir / BACKUP)
        for f in list(runs_dir.glob(f"{p['clip']}_*")):
            if not f.name.startswith("._"):
                move(f, runs_dir / BACKUP)
        tmp.replace(clips_dir / f"{p['clip']}.mp4")
        ctp.write_gps_csv(p["points"], p["s"], p["e"], clips_dir / f"{p['clip']}.csv")
        print(f"[{k}/{len(plans)}] {p['clip']} : {p['e'] - p['s']:.1f} s écrit "
              f"({time.time() - t0:.0f} s écoulées)", flush=True)

    pids = sorted({p["pid"] for p in plans})
    print(f"\nRelancer la détection : python batch_yolo11x_track.py -p {' '.join(pids)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
