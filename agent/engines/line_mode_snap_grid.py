"""Line Mode v4 — SnapGrid from peaks_db (onset / silence / silence_pad)."""

from __future__ import annotations

import statistics
from typing import Any, TypedDict


class SnapPoint(TypedDict):
    t: float
    kind: str


HOP_SEC = 0.01
ONSET_DB_ABOVE_FLOOR = 6.0
SILENCE_DB_ABOVE_FLOOR = 3.0
SILENCE_MIN_SEC = 0.15
SILENCE_PAD_SEC = 0.30
SNAP_RADIUS_DEFAULT = 0.15


def _median_db(peaks_db: list[float], mean_volume_db: float | None) -> float:
    if peaks_db:
        return float(statistics.median(peaks_db))
    if mean_volume_db is not None:
        return float(mean_volume_db)
    return -60.0


def build_snap_grid_from_peaks(
    peaks_db: list[float],
    *,
    duration_sec: float,
    mean_volume_db: float | None = None,
) -> dict[str, Any]:
    """Build onset/silence/silence_pad caches (sorted by t)."""
    if not peaks_db or duration_sec <= 0:
        empty: list[SnapPoint] = []
        return {
            "onsets": empty,
            "silences": empty,
            "silencePads": empty,
            "dragStartSnaps": empty,
            "noiseFloorDb": -60.0,
            "hopSec": HOP_SEC,
        }

    n = len(peaks_db)
    dt = duration_sec / n
    floor = _median_db(peaks_db, mean_volume_db)
    onset_thresh = floor + ONSET_DB_ABOVE_FLOOR
    silence_thresh = floor + SILENCE_DB_ABOVE_FLOOR
    min_silent_cols = max(1, int(round(SILENCE_MIN_SEC / dt)))

    onsets: list[SnapPoint] = []
    for i in range(1, n):
        prev_db = float(peaks_db[i - 1])
        cur_db = float(peaks_db[i])
        if prev_db < onset_thresh <= cur_db:
            onsets.append({"t": i * dt, "kind": "onset"})

    silences: list[SnapPoint] = []
    run_start: int | None = None
    for i, db_raw in enumerate(peaks_db):
        db = float(db_raw)
        if db <= silence_thresh:
            if run_start is None:
                run_start = i
        elif run_start is not None:
            run_len = i - run_start
            if run_len >= min_silent_cols:
                silences.append({"t": run_start * dt, "kind": "silence"})
            run_start = None
    if run_start is not None:
        run_len = n - run_start
        if run_len >= min_silent_cols:
            silences.append({"t": run_start * dt, "kind": "silence"})

    silence_pads: list[SnapPoint] = [
        {"t": s["t"] + SILENCE_PAD_SEC, "kind": "silence_pad"} for s in silences
    ]

    onsets.sort(key=lambda p: p["t"])
    silences.sort(key=lambda p: p["t"])
    silence_pads.sort(key=lambda p: p["t"])

    return {
        "onsets": onsets,
        "silences": silences,
        "silencePads": silence_pads,
        "dragStartSnaps": list(onsets),
        "noiseFloorDb": floor,
        "hopSec": dt,
    }


def build_snap_grid_from_peaks_payload(payload: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return build_snap_grid_from_peaks([], duration_sec=0.0)
    peaks_db_raw = payload.get("peaks_db")
    peaks_db = [float(x) for x in peaks_db_raw] if isinstance(peaks_db_raw, list) else []
    dur = float(payload.get("timeline_sec") or payload.get("duration_sec") or 0.0)
    mean_db = payload.get("mean_volume_db")
    mean_volume_db = float(mean_db) if mean_db is not None else None
    return build_snap_grid_from_peaks(
        peaks_db,
        duration_sec=dur,
        mean_volume_db=mean_volume_db,
    )
