"""Multi-media program plan. Source captions/timestamps remain in source coordinates.

The JSON wire format is shared/mediaComposition.ts MediaComposition. Images insert silence;
videos insert only their own sound. No original audio is mixed across an inserted clip.
"""
from __future__ import annotations

import json
import math
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from . import media, paths

FPS = 30
SAMPLE_RATE = 48000
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
MAX_ITEMS = 10000


def inspect_asset(raw_path: str, kind: str) -> dict[str, Any]:
    """Check actual file metadata before registering a path for browser preview."""
    if kind not in ("image", "video") or not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError("이미지 또는 영상 파일이 필요합니다.")
    path = Path(raw_path)
    suffixes = IMAGE_EXTENSIONS if kind == "image" else set(paths.VIDEO_EXTENSIONS)
    if not path.is_absolute() or path.suffix.lower() not in suffixes or not path.is_file():
        raise ValueError("미디어 파일을 찾을 수 없거나 지원하지 않는 형식입니다.")
    ff = paths.ffmpeg_paths()
    if not ff:
        raise RuntimeError("ffmpeg 준비가 필요합니다.")
    if kind == "video":
        timing = media.probe_media_timing(ff[1], path)
        result = {"kind": kind, "path": str(path), "duration": timing.duration,
                  "width": timing.width, "height": timing.height, "hasAudio": timing.has_audio,
                  "sourceOriginSec": timing.source_origin_sec}
    else:
        proc = subprocess.run([ff[1], "-v", "error", "-select_streams", "v:0", "-show_entries",
                               "stream=width,height", "-of", "json", str(path)],
                              capture_output=True, timeout=30, creationflags=media._NO_WINDOW)
        if proc.returncode:
            raise ValueError("이미지를 읽지 못했습니다.")
        try:
            stream = json.loads(proc.stdout)["streams"][0]
            w, h = int(stream["width"]), int(stream["height"])
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise ValueError("이미지 크기가 올바르지 않습니다.") from error
        if w <= 0 or h <= 0 or w * h > 100_000_000:
            raise ValueError("이미지 크기가 올바르지 않거나 너무 큽니다.")
        result = {"kind": kind, "path": str(path), "width": w, "height": h,
                  "hasAudio": False, "sourceOriginSec": 0.0}
    media.allow_path(path)
    return result


def _number(value: Any, minimum: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < minimum:
        raise ValueError("Invalid composition number")
    return float(value)


def _id(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise ValueError("Invalid composition ID")
    return value


def _fit(value: Any) -> str:
    if value not in ("contain", "cover"):
        raise ValueError("Invalid media fit")
    return value


def frame_at(sec: float) -> int:
    return math.ceil(sec * FPS - 1e-9)


@dataclass
class ResolvedComposition:
    clips: list[dict[str, Any]]
    overlays: list[dict[str, Any]]
    assets: dict[str, dict[str, Any]]
    duration: float


def resolve_composition(raw: Any, source: media.MediaTiming,
                        probe: Callable[[str, str], dict[str, Any]] = inspect_asset) -> ResolvedComposition:
    if not isinstance(raw, dict) or raw.get("version") != 1 or isinstance(raw.get("version"), bool):
        raise ValueError("Unsupported media composition")
    for key in ("clips", "overlays", "assets"):
        if not isinstance(raw.get(key), list) or len(raw[key]) > MAX_ITEMS:
            raise ValueError("Invalid composition list")
    if not raw["clips"]:
        raise ValueError("No media remains in the composition")
    declared: dict[str, dict[str, Any]] = {}
    for a in raw["assets"]:
        if not isinstance(a, dict):
            raise ValueError("Invalid media asset")
        aid = _id(a.get("id"))
        if aid in declared or a.get("kind") not in ("image", "video") or not isinstance(a.get("path"), str):
            raise ValueError("Invalid media asset")
        declared[aid] = a
    assets: dict[str, dict[str, Any]] = {}

    def asset(aid: Any, kind: str) -> str:
        aid = _id(aid)
        if aid not in declared or declared[aid]["kind"] != kind:
            raise ValueError("Missing or mismatched media asset")
        if aid not in assets:
            assets[aid] = probe(declared[aid]["path"], kind)
        return aid

    clips, ids, cursor = [], set(), 0.0
    for c in raw["clips"]:
        if not isinstance(c, dict):
            raise ValueError("Invalid composition clip")
        cid, duration, start = _id(c.get("id")), _number(c.get("duration")), _number(c.get("programStart"))
        kind = c.get("kind")
        if cid in ids or duration <= 0 or abs(start - cursor) > 1e-6 or kind not in ("source", "image", "video"):
            raise ValueError("Invalid composition clip or timeline gap")
        ids.add(cid)
        out = {"id": cid, "kind": kind, "programStart": cursor, "duration": duration}
        if kind != "source":
            out.update(assetId=asset(c.get("assetId"), kind), fit=_fit(c.get("fit")))
        if kind in ("source", "video"):
            s, e = _number(c.get("sourceStart")), _number(c.get("sourceEnd"))
            limit = source.duration if kind == "source" else assets[out["assetId"]]["duration"]
            if e <= s or e > limit + 1e-6 or abs(e - s - duration) > 1e-6:
                raise ValueError("Composition clip exceeds its source")
            out.update(sourceStart=s, sourceEnd=min(e, limit))
        if kind == "video":
            if not isinstance(c.get("muted"), bool):
                raise ValueError("Invalid inserted video audio setting")
            out["muted"] = c["muted"]
        clips.append(out)
        cursor += duration
    if abs(_number(raw.get("duration")) - cursor) > 1e-6 or cursor > 24 * 60 * 60 or frame_at(cursor) < 1:
        raise ValueError("Invalid composition duration")
    overlays = []
    for o in raw["overlays"]:
        if not isinstance(o, dict):
            raise ValueError("Invalid image overlay")
        oid, start, end = _id(o.get("id")), _number(o.get("start")), _number(o.get("end"))
        if oid in ids or end <= start or end > cursor + 1e-6:
            raise ValueError("Invalid image overlay range")
        ids.add(oid)
        overlays.append({"id": oid, "assetId": asset(o.get("assetId"), "image"),
                         "start": start, "end": min(cursor, end), "fit": _fit(o.get("fit"))})
    return ResolvedComposition(clips, overlays, assets, cursor)


def _f(n: float) -> str:
    return f"{n:.9f}"


def _scale(w: int, h: int, fit: str, transparent: bool = False) -> str:
    mode = "decrease" if fit == "contain" else "increase"
    # RGBA before padding preserves transparency around a contained image overlay.
    fmt = "rgba" if transparent else "yuv420p"
    tail = (f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black" + ("@0" if transparent else "")
            if fit == "contain" else f"crop={w}:{h}")
    return f"scale={w}:{h}:force_original_aspect_ratio={mode}:force_divisible_by=2,format={fmt},{tail},setsar=1"


def build_composition_graph(plan: ResolvedComposition, source: media.MediaTiming,
                            first_asset_input: int = 2) -> tuple[list[str], str]:
    """Return extra input argv and graph ending in [vmain]/[amain]. Input 1 is subtitle BGRA.

    Every segment is normalized to the SAME global frame boundaries in both video and audio.
    This prevents per-clip AAC/concat padding from accumulating and leaking source sound into inserts.
    """
    w, h = source.width, source.height
    extra_inputs: list[str] = []
    info: dict[str, dict[str, Any]] = {"": {"index": 0, "kind": "video", "hasAudio": source.has_audio,
                                              "sourceOriginSec": source.source_origin_sec}}
    for i, (aid, a) in enumerate(plan.assets.items(), first_asset_input):
        info[aid] = {**a, "index": i}
        extra_inputs += (["-loop", "1", "-framerate", str(FPS)] if a["kind"] == "image" else []) + ["-i", a["path"]]
    clips = [(c, frame_at(c["programStart"] + c["duration"]) - frame_at(c["programStart"])) for c in plan.clips]
    clips = [(c, count) for c, count in clips if count > 0]
    overlays = [o for o in plan.overlays if frame_at(o["end"]) > frame_at(o["start"])]
    video_uses: dict[str, list[str]] = {}
    audio_uses: dict[str, list[str]] = {}
    for i, (c, _) in enumerate(clips):
        key = c.get("assetId", "")
        video_uses.setdefault(key, []).append(f"cv{i}")
        if c["kind"] != "image" and not c.get("muted", False) and info[key]["hasAudio"]:
            audio_uses.setdefault(key, []).append(f"ca{i}")
    for i, o in enumerate(overlays):
        video_uses.setdefault(o["assetId"], []).append(f"ov{i}")
    filters = []
    for key, labels in video_uses.items():
        a = info[key]
        filters.append(f"[{a['index']}:v:0]setpts=PTS-({_f(a['sourceOriginSec'])})/TB,"
                       f"split={len(labels)}" + "".join(f"[{label}]" for label in labels))
    for key, labels in audio_uses.items():
        a = info[key]
        filters.append(f"[{a['index']}:a:0]asetpts=PTS-({_f(a['sourceOriginSec'])})/TB,"
                       f"aresample={SAMPLE_RATE}:async=1:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,"
                       f"asplit={len(labels)}" + "".join(f"[{label}]" for label in labels))
    for i, (c, count) in enumerate(clips):
        s = c.get("sourceStart", 0.0)
        end = c.get("sourceEnd", c["duration"])
        filters.append(f"[cv{i}]trim=start={_f(s)}:end={_f(end)},setpts=PTS-({_f(s)})/TB,"
                       f"fps={FPS},tpad=stop_mode=clone:stop_duration=1,trim=end_frame={count},setpts=N/({FPS}*TB),"
                       f"{_scale(w, h, c.get('fit', 'contain'))}[v{i}]")
        samples = count * (SAMPLE_RATE // FPS)
        if f"ca{i}" in audio_uses.get(c.get("assetId", ""), []):
            filters.append(f"[ca{i}]atrim=start={_f(s)}:end={_f(end)},asetpts=PTS-STARTPTS,apad,"
                           f"atrim=end_sample={samples},asetpts=N/SR/TB[a{i}]")
        else:
            filters.append(f"anullsrc=r={SAMPLE_RATE}:cl=stereo,atrim=end_sample={samples},asetpts=N/SR/TB[a{i}]")
    n = len(clips)
    filters.append("".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[composed][amain]")
    previous = "composed"
    for i, o in enumerate(overlays):
        start, end = frame_at(o["start"]), frame_at(o["end"])
        filters.append(f"[ov{i}]fps={FPS},trim=end_frame={end-start},setpts=(N+{start})/({FPS}*TB),"
                       f"{_scale(w, h, o['fit'], True)}[layer{i}]")
        filters.append(f"[{previous}][layer{i}]overlay=0:0:eof_action=pass:repeatlast=0:"
                       f"enable='gte(n,{start})*lt(n,{end})'[overlaid{i}]")
        previous = f"overlaid{i}"
    filters.append(f"[{previous}]setpts=N/({FPS}*TB)[vmain]")
    return extra_inputs, ";".join(filters)
