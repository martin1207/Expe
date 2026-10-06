#!/usr/bin/env python3
"""
Extraction de la telemetrie GoPro (CORI = orientation camera, GPS) depuis les
fichiers MP4 / .360, avec les timestamps de chaque echantillon.

Le flux GPMF (piste "gpmd") est lu directement depuis le conteneur MP4 via un
petit lecteur ISO-BMFF natif : on ne lit QUE les echantillons de la piste GPMF
(quelques Mo) et pas les 4 Go de video. Les timestamps de chaque payload viennent
de la table de timing MP4 (stts + timescale) ; les echantillons internes sont
repartis uniformement sur la duree du payload -> timestamp "t" relatif au debut
de la video. Pour le GPS, on dispose en plus du temps UTC absolu (champ GPSU).

Dependances : pandas (optionnel, seulement pour la sortie CSV). Pas besoin de ffmpeg.

Usage en ligne de commande :
    python3 gopro_telemetry.py "P01/v/GS030196.360"
    python3 gopro_telemetry.py "video.360" --out-dir ./telemetry --csv

Usage en bibliotheque :
    from gopro_telemetry import extract_gopro_telemetry
    tel = extract_gopro_telemetry("video.360")
    tel["cori"]   # liste de dicts : t, w, x, y, z
    tel["gps"]    # liste de dicts : t, utc, lat, lon, alt, speed2d, speed3d, fix, dop
"""

from __future__ import annotations

import json
import struct
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Format GPMF : tailles des types de base (lettre -> (format struct, taille))
# ---------------------------------------------------------------------------
_TYPE_FMT = {
    b"b": ("b", 1),  # int8
    b"B": ("B", 1),  # uint8
    b"c": ("c", 1),  # char / ASCII
    b"d": ("d", 8),  # float64
    b"f": ("f", 4),  # float32
    b"F": ("I", 4),  # fourCC (4 octets)
    b"j": ("q", 8),  # int64
    b"J": ("Q", 8),  # uint64
    b"l": ("i", 4),  # int32
    b"L": ("I", 4),  # uint32
    b"s": ("h", 2),  # int16
    b"S": ("H", 2),  # uint16
    b"U": ("c", 1),  # date UTC (16 chars)
}


# ---------------------------------------------------------------------------
# Lecteur MP4 natif : localise la piste GPMF et ne lit QUE ses echantillons.
# Evite de relire les 4 Go du fichier (contrairement a ffmpeg -c copy).
# ---------------------------------------------------------------------------
def _read_box_header(f):
    """Lit un en-tete de box ISO-BMFF -> (type:bytes, size:int, data_offset:int).
    Retourne (None, None, None) en fin de fichier."""
    pos = f.tell()
    hdr = f.read(8)
    if len(hdr) < 8:
        return None, None, None
    size = struct.unpack(">I", hdr[:4])[0]
    btype = hdr[4:8]
    data_off = pos + 8
    if size == 1:  # taille 64 bits
        size = struct.unpack(">Q", f.read(8))[0]
        data_off = pos + 16
    elif size == 0:  # jusqu'a la fin du fichier
        f.seek(0, 2)
        size = f.tell() - pos
    return btype, size, data_off


def _find_box(f, target, start, end):
    """Cherche une box `target` parmi les enfants directs de [start, end)."""
    f.seek(start)
    while f.tell() < end:
        pos = f.tell()
        btype, size, data_off = _read_box_header(f)
        if btype is None or size <= 0:
            break
        if btype == target:
            return data_off, pos + size
        f.seek(pos + size)
    return None, None


def _parse_stbl_for_gpmd(f, moov_start, moov_end):
    """Parcourt les pistes de moov et renvoie les infos de la piste GPMF :
    dict {timescale, sample_sizes, sample_offsets, sample_durations}."""
    f.seek(moov_start)
    pos = moov_start
    while pos < moov_end:
        f.seek(pos)
        btype, size, data_off = _read_box_header(f)
        if btype is None or size <= 0:
            break
        if btype == b"trak":
            info = _try_trak(f, data_off, pos + size)
            if info is not None:
                return info
        pos += size
    return None


def _try_trak(f, trak_start, trak_end):
    mdia_s, mdia_e = _find_box(f, b"mdia", trak_start, trak_end)
    if mdia_s is None:
        return None
    # handler : doit etre 'meta' avec le format gpmd dans stsd
    mdhd_s, _ = _find_box(f, b"mdhd", mdia_s, mdia_e)
    if mdhd_s is None:
        return None
    f.seek(mdhd_s)
    ver = f.read(1)[0]
    f.seek(mdhd_s + (20 if ver == 1 else 12))
    timescale = struct.unpack(">I", f.read(4))[0]

    minf_s, minf_e = _find_box(f, b"minf", mdia_s, mdia_e)
    if minf_s is None:
        return None
    stbl_s, stbl_e = _find_box(f, b"stbl", minf_s, minf_e)
    if stbl_s is None:
        return None

    # stsd : verifie que le format est 'gpmd'
    stsd_s, _ = _find_box(f, b"stsd", stbl_s, stbl_e)
    if stsd_s is None:
        return None
    f.seek(stsd_s + 8)  # version/flags(4) + entry_count(4)
    _entry_size = struct.unpack(">I", f.read(4))[0]
    fmt = f.read(4)
    if fmt != b"gpmd":
        return None

    sizes = _read_stsz(f, stbl_s, stbl_e)
    offsets = _read_chunk_offsets(f, stbl_s, stbl_e)
    chunks = _read_stsc(f, stbl_s, stbl_e)
    durations = _read_stts(f, stbl_s, stbl_e, len(sizes))
    sample_offsets = _compute_sample_offsets(sizes, offsets, chunks)
    return {
        "timescale": timescale,
        "sizes": sizes,
        "offsets": sample_offsets,
        "durations": durations,
    }


def _read_full(f, box_start):
    f.seek(box_start)
    return struct.unpack(">I", f.read(4))[0]  # version+flags (ignore)


def _read_stsz(f, stbl_s, stbl_e):
    s, _ = _find_box(f, b"stsz", stbl_s, stbl_e)
    f.seek(s + 4)
    sample_size = struct.unpack(">I", f.read(4))[0]
    count = struct.unpack(">I", f.read(4))[0]
    if sample_size != 0:
        return [sample_size] * count
    return list(struct.unpack(">" + "I" * count, f.read(4 * count)))


def _read_chunk_offsets(f, stbl_s, stbl_e):
    s, _ = _find_box(f, b"stco", stbl_s, stbl_e)
    if s is not None:
        f.seek(s + 4)
        n = struct.unpack(">I", f.read(4))[0]
        return list(struct.unpack(">" + "I" * n, f.read(4 * n)))
    s, _ = _find_box(f, b"co64", stbl_s, stbl_e)
    f.seek(s + 4)
    n = struct.unpack(">I", f.read(4))[0]
    return list(struct.unpack(">" + "Q" * n, f.read(8 * n)))


def _read_stsc(f, stbl_s, stbl_e):
    s, _ = _find_box(f, b"stsc", stbl_s, stbl_e)
    f.seek(s + 4)
    n = struct.unpack(">I", f.read(4))[0]
    entries = []
    for _ in range(n):
        first_chunk, spc, _desc = struct.unpack(">III", f.read(12))
        entries.append((first_chunk, spc))
    return entries


def _read_stts(f, stbl_s, stbl_e, n_samples):
    s, _ = _find_box(f, b"stts", stbl_s, stbl_e)
    f.seek(s + 4)
    n = struct.unpack(">I", f.read(4))[0]
    durations = []
    for _ in range(n):
        count, delta = struct.unpack(">II", f.read(8))
        durations.extend([delta] * count)
    if len(durations) < n_samples:
        durations.extend([durations[-1] if durations else 0] *
                         (n_samples - len(durations)))
    return durations[:n_samples]


def _compute_sample_offsets(sizes, chunk_offsets, stsc):
    """Resout l'offset absolu de chaque echantillon (stsc + stco + stsz)."""
    # etend stsc en (chunk_index -> samples_per_chunk)
    n_chunks = len(chunk_offsets)
    spc_per_chunk = [0] * (n_chunks + 1)
    for i, (first_chunk, spc) in enumerate(stsc):
        last = stsc[i + 1][0] - 1 if i + 1 < len(stsc) else n_chunks
        for c in range(first_chunk, last + 1):
            if 1 <= c <= n_chunks:
                spc_per_chunk[c] = spc
    sample_offsets = []
    si = 0
    for c in range(1, n_chunks + 1):
        off = chunk_offsets[c - 1]
        for _ in range(spc_per_chunk[c]):
            if si >= len(sizes):
                break
            sample_offsets.append(off)
            off += sizes[si]
            si += 1
    return sample_offsets


def _read_gpmd_samples(path):
    """Renvoie (timescale, [(t0_sec, dur_sec, bytes), ...]) pour la piste GPMF."""
    with open(path, "rb") as f:
        f.seek(0, 2)
        fsize = f.tell()
        # localise moov au niveau racine
        moov_s = moov_e = None
        pos = 0
        while pos < fsize:
            f.seek(pos)
            btype, size, data_off = _read_box_header(f)
            if btype is None or size <= 0:
                break
            if btype == b"moov":
                moov_s, moov_e = data_off, pos + size
                break
            pos += size
        if moov_s is None:
            raise RuntimeError(f"Pas de box 'moov' dans {path}")

        info = _parse_stbl_for_gpmd(f, moov_s, moov_e)
        if info is None:
            raise RuntimeError(f"Aucune piste GPMF (gpmd) trouvee dans {path}")

        ts = info["timescale"]
        samples = []
        t_cum = 0
        for size, off, dur in zip(info["sizes"], info["offsets"], info["durations"]):
            f.seek(off)
            data = f.read(size)
            samples.append((t_cum / ts, dur / ts, data))
            t_cum += dur
        return ts, samples


_VIDEO_FORMATS = (b"hvc1", b"hev1", b"avc1", b"avc3", b"mp4v")


def _read_frame_times(path):
    """Renvoie (fps_moyen, [t0_frame_sec, ...]) pour la 1ere piste video.

    On ne lit QUE les tables de timing (stts) : aucune image n'est decodee.
    """
    with open(path, "rb") as f:
        f.seek(0, 2)
        fsize = f.tell()
        moov_s = moov_e = None
        pos = 0
        while pos < fsize:
            f.seek(pos)
            btype, size, data_off = _read_box_header(f)
            if btype is None or size <= 0:
                break
            if btype == b"moov":
                moov_s, moov_e = data_off, pos + size
                break
            pos += size
        if moov_s is None:
            raise RuntimeError(f"Pas de box 'moov' dans {path}")

        # parcourt les pistes, garde la 1ere video
        p = moov_s
        while p < moov_e:
            f.seek(p)
            btype, size, data_off = _read_box_header(f)
            if btype is None or size <= 0:
                break
            if btype == b"trak":
                t = _try_trak_video(f, data_off, p + size)
                if t is not None:
                    return t
            p += size
    raise RuntimeError(f"Aucune piste video trouvee dans {path}")


def _try_trak_video(f, trak_start, trak_end):
    mdia_s, mdia_e = _find_box(f, b"mdia", trak_start, trak_end)
    if mdia_s is None:
        return None
    mdhd_s, _ = _find_box(f, b"mdhd", mdia_s, mdia_e)
    if mdhd_s is None:
        return None
    f.seek(mdhd_s)
    ver = f.read(1)[0]
    f.seek(mdhd_s + (20 if ver == 1 else 12))
    timescale = struct.unpack(">I", f.read(4))[0]

    minf_s, minf_e = _find_box(f, b"minf", mdia_s, mdia_e)
    if minf_s is None:
        return None
    stbl_s, stbl_e = _find_box(f, b"stbl", minf_s, minf_e)
    if stbl_s is None:
        return None
    stsd_s, _ = _find_box(f, b"stsd", stbl_s, stbl_e)
    if stsd_s is None:
        return None
    f.seek(stsd_s + 8)
    struct.unpack(">I", f.read(4))  # entry size
    fmt = f.read(4)
    if fmt not in _VIDEO_FORMATS:
        return None

    s, _ = _find_box(f, b"stts", stbl_s, stbl_e)
    f.seek(s + 4)
    n = struct.unpack(">I", f.read(4))[0]
    times = []
    t_cum = 0
    for _ in range(n):
        count, delta = struct.unpack(">II", f.read(8))
        for _ in range(count):
            times.append(t_cum / timescale)
            t_cum += delta
    fps = len(times) / (t_cum / timescale) if t_cum else 0.0
    return fps, times


# ---------------------------------------------------------------------------
# Parsing KLV du GPMF
# ---------------------------------------------------------------------------
def _iter_klv(buf: bytes, start: int, end: int):
    """Itere sur les entrees KLV (key, type, struct_size, repeat, data_start, data_len)."""
    pos = start
    while pos + 8 <= end:
        key = buf[pos:pos + 4]
        typ = buf[pos + 4:pos + 5]
        struct_size = buf[pos + 5]
        repeat = struct.unpack(">H", buf[pos + 6:pos + 8])[0]
        data_len = struct_size * repeat
        data_start = pos + 8
        yield key, typ, struct_size, repeat, data_start, data_len
        # avance avec padding 32 bits
        pos = data_start + ((data_len + 3) & ~3)


def _decode_values(buf, typ, struct_size, repeat, data_start, data_len):
    """Decode un champ KLV en liste d'echantillons (chaque echantillon = liste de scalaires)."""
    if typ == b"c" or typ == b"U":
        return buf[data_start:data_start + data_len].decode("latin-1", "replace")
    fmt = _TYPE_FMT.get(typ)
    if fmt is None:
        return None  # type complexe ('?') ou nested non gere ici
    sfmt, esize = fmt
    n_per_sample = struct_size // esize
    samples = []
    off = data_start
    for _ in range(repeat):
        vals = struct.unpack(">" + sfmt * n_per_sample,
                             buf[off:off + struct_size])
        samples.append(list(vals))
        off += struct_size
    return samples


def _parse_payload(buf, p_start, p_end):
    """Parse un payload DEVC -> dict {STRM_key: {'data':..., 'scal':..., 'meta':{}}}.

    Retourne un dict des flux interessants : CORI, GPS5, GPS9, et metadonnees
    associees (GPSU, GPSF, GPSP, STMP).
    """
    result = {"streams": []}
    for key, typ, ss, rep, ds, dl in _iter_klv(buf, p_start, p_end):
        if key == b"DEVC":
            # contenu nested -> on descend
            for skey, styp, sss, srep, sds, sdl in _iter_klv(buf, ds, ds + dl):
                if skey == b"STRM":
                    stream = _parse_strm(buf, sds, sds + sdl)
                    if stream:
                        result["streams"].append(stream)
    return result


def _parse_strm(buf, s_start, s_end):
    """Parse un bloc STRM, renvoie un dict si CORI/GPS y figure, sinon None."""
    scal = None
    payload_key = None
    payload_data = None
    meta = {}
    for key, typ, ss, rep, ds, dl in _iter_klv(buf, s_start, s_end):
        if key == b"SCAL":
            scal = _decode_values(buf, typ, ss, rep, ds, dl)
            scal = [v[0] for v in scal] if scal else None
        elif key in (b"CORI", b"GPS5", b"GPS9", b"IORI", b"GRAV", b"ACCL", b"GYRO"):
            payload_key = key.decode()
            payload_data = _decode_values(buf, typ, ss, rep, ds, dl)
        elif key == b"GPSU":
            meta["GPSU"] = _decode_values(buf, typ, ss, rep, ds, dl)
        elif key == b"GPSF":
            v = _decode_values(buf, typ, ss, rep, ds, dl)
            meta["GPSF"] = v[0][0] if v else None
        elif key == b"GPSP":
            v = _decode_values(buf, typ, ss, rep, ds, dl)
            meta["GPSP"] = v[0][0] if v else None
        elif key == b"STMP":
            v = _decode_values(buf, typ, ss, rep, ds, dl)
            meta["STMP"] = v[0][0] if v else None
    if payload_key is None:
        return None
    return {"key": payload_key, "data": payload_data, "scal": scal, "meta": meta}


def _apply_scale(sample, scal):
    """Divise chaque composante par le scaler correspondant."""
    if not scal:
        return [float(v) for v in sample]
    if len(scal) == 1:
        s = scal[0] or 1
        return [v / s for v in sample]
    return [v / (scal[i] if i < len(scal) and scal[i] else 1)
            for i, v in enumerate(sample)]


def _parse_gpsu(s):
    """Parse la date GPSU 'yymmddhhmmss.sss' -> datetime UTC."""
    if not s:
        return None
    s = s.strip().strip("\x00")
    try:
        return datetime.strptime(s, "%y%m%d%H%M%S.%f").replace(tzinfo=timezone.utc)
    except ValueError:
        try:
            return datetime.strptime(s, "%y%m%d%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            return None


# ---------------------------------------------------------------------------
# Fonction principale
# ---------------------------------------------------------------------------
def extract_gopro_telemetry(path: str, streams=("CORI", "GPS5", "GPS9")):
    """Extrait la telemetrie GoPro avec timestamps.

    Parametres
    ----------
    path : str
        Chemin du fichier video GoPro (.mp4 ou .360).
    streams : tuple
        Cles GPMF a extraire (par defaut CORI + GPS).

    Retourne
    --------
    dict avec une cle par flux demande, ex :
      "cori" -> [{"t": float, "w","x","y","z": float}, ...]
      "gps"  -> [{"t","lat","lon","alt","speed2d","speed3d",
                  "utc","fix","dop"}, ...]
    "t" = temps en secondes depuis le debut de la video.
    "utc" = timestamp ISO 8601 absolu (GPS uniquement).
    """
    path = str(path)
    _timescale, payloads = _read_gpmd_samples(path)

    cori_out, gps_out = [], []

    for i, (t0, dur, data_bytes) in enumerate(payloads):
        span = dur if dur else 1.0
        parsed = _parse_payload(data_bytes, 0, len(data_bytes))
        for stream in parsed["streams"]:
            key, data, scal, meta = (stream["key"], stream["data"],
                                     stream["scal"], stream["meta"])
            if not data or key not in streams:
                continue
            n = len(data)

            if key == "CORI":
                for j, sample in enumerate(data):
                    sc = _apply_scale(sample, scal)
                    t = (t0 + span * j / n) if t0 is not None else None
                    w, x, y, z = (sc + [0, 0, 0, 0])[:4]
                    cori_out.append({"t": t, "w": w, "x": x, "y": y, "z": z})

            elif key in ("GPS5", "GPS9"):
                utc0 = _parse_gpsu(meta.get("GPSU"))
                for j, sample in enumerate(data):
                    sc = _apply_scale(sample, scal)
                    t = (t0 + span * j / n) if t0 is not None else None
                    utc = None
                    if utc0 is not None:
                        utc = (utc0.timestamp() + span * j / n)
                        utc = datetime.fromtimestamp(utc, tz=timezone.utc).isoformat()
                    rec = {
                        "t": t, "utc": utc,
                        "lat": sc[0] if len(sc) > 0 else None,
                        "lon": sc[1] if len(sc) > 1 else None,
                        "alt": sc[2] if len(sc) > 2 else None,
                        "speed2d": sc[3] if len(sc) > 3 else None,
                        "speed3d": sc[4] if len(sc) > 4 else None,
                        "fix": meta.get("GPSF"),
                        "dop": meta.get("GPSP"),
                    }
                    gps_out.append(rec)

    return {"cori": cori_out, "gps": gps_out}


# ---------------------------------------------------------------------------
# Timestamps UTC exacts de chaque frame video
# ---------------------------------------------------------------------------
def _gps_utc_anchor(gps):
    """Ajuste utc_epoch = a*t + b par moindres carres sur les points GPS valides.

    Renvoie (a, b, n_points). Le GPS GoPro donne l'UTC reel (GPSU) ; on s'en
    sert pour transformer le temps relatif video en UTC absolu.
    """
    pts = [(g["t"], datetime.fromisoformat(g["utc"]).timestamp())
           for g in gps
           if g.get("utc") and g.get("fix") == 3 and g["t"] is not None]
    if len(pts) < 2:
        raise RuntimeError("Pas assez de points GPS valides (fix 3D) pour "
                           "ancrer l'UTC.")
    ts = [p[0] for p in pts]
    us = [p[1] for p in pts]
    n = len(pts)
    sx = sum(ts); sy = sum(us)
    sxx = sum(t * t for t in ts); sxy = sum(t * u for t, u in zip(ts, us))
    denom = n * sxx - sx * sx
    a = (n * sxy - sx * sy) / denom if denom else 1.0
    b = (sy - a * sx) / n
    return a, b, n


def frame_timestamps(path, gps=None):
    """Renvoie l'UTC absolu exact de chaque frame video.

    Parametres
    ----------
    path : str
        Fichier .mp4 / .360.
    gps : list, optionnel
        Liste GPS deja extraite (extract_gopro_telemetry()["gps"]). Si None,
        elle est lue depuis le fichier.

    Retourne
    --------
    dict :
      "fps"    : cadence moyenne (Hz)
      "utc0"   : UTC de la frame 0 (ISO 8601)
      "frames" : liste de {"frame": i, "t": sec_relatif, "utc": ISO8601}
    """
    path = str(path)
    if gps is None:
        gps = extract_gopro_telemetry(path, streams=("GPS5", "GPS9"))["gps"]
    a, b, n_anchor = _gps_utc_anchor(gps)
    fps, times = _read_frame_times(path)
    frames = []
    for i, t in enumerate(times):
        epoch = a * t + b
        utc = datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()
        frames.append({"frame": i, "t": t, "utc": utc})
    return {"fps": fps, "utc0": frames[0]["utc"] if frames else None,
            "frames": frames, "n_gps_anchor": n_anchor}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _to_dataframe(records):
    import pandas as pd
    return pd.DataFrame.from_records(records)


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Extraction telemetrie GoPro (CORI + GPS).")
    ap.add_argument("video", help="Fichier .mp4 ou .360")
    ap.add_argument("--out-dir", default=None,
                    help="Dossier de sortie (par defaut : a cote de la video)")
    ap.add_argument("--csv", action="store_true", help="Ecrit aussi des CSV")
    ap.add_argument("--frames", action="store_true",
                    help="Ecrit <video>_frames.csv : UTC exact de chaque frame")
    args = ap.parse_args()

    tel = extract_gopro_telemetry(args.video)
    video_path = Path(args.video)
    stem = video_path.stem
    out = Path(args.out_dir) if args.out_dir else video_path.parent
    out.mkdir(parents=True, exist_ok=True)

    print(f"{stem}: {len(tel['cori'])} echantillons CORI, "
          f"{len(tel['gps'])} echantillons GPS")

    if args.frames:
        ft = frame_timestamps(args.video, gps=tel["gps"])
        _to_dataframe(ft["frames"]).to_csv(out / f"{stem}_frames.csv", index=False)
        print(f"{len(ft['frames'])} frames @ {ft['fps']:.3f} fps ; "
              f"frame 0 = {ft['utc0']}")
        print(f"-> {out / (stem + '_frames.csv')}")

    if args.csv:
        if tel["cori"]:
            _to_dataframe(tel["cori"]).to_csv(out / f"{stem}_cori.csv", index=False)
        if tel["gps"]:
            _to_dataframe(tel["gps"]).to_csv(out / f"{stem}_gps.csv", index=False)
        print(f"CSV ecrits dans {out}")
    elif not args.frames:
        (out / f"{stem}_telemetry.json").write_text(json.dumps(tel, indent=2))
        print(f"JSON ecrit dans {out / (stem + '_telemetry.json')}")


if __name__ == "__main__":
    main()
