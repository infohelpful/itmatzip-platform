"""ffmpeg filter_complex — trim + concat / acrossfade helpers."""

from __future__ import annotations

EXPORT_AUDIO_CROSSFADE_SEC = 0.005
EXPORT_AUDIO_CROSSFADE_MIN_SEC = 0.002
EXPORT_AUDIO_CROSSFADE_MAX_SEC = 0.005
# program-master bake — segment마다 afade 금지 (줄 경계 뚝뚝 끊김)
BAKE_PROGRAM_MASTER_AUDIO_FADE_SEC = 0.0


def clamp_export_crossfade_sec(sec: float | None = None) -> float:
    v = EXPORT_AUDIO_CROSSFADE_SEC if sec is None else float(sec)
    return max(EXPORT_AUDIO_CROSSFADE_MIN_SEC, min(EXPORT_AUDIO_CROSSFADE_MAX_SEC, v))


def segment_audio_fade_sec(segment_dur: float, fade_sec: float | None = None) -> float:
    """Per-segment in/out fade — clamp so short clips stay audible."""
    d = clamp_export_crossfade_sec(fade_sec)
    dur = max(float(segment_dur), 1e-6)
    return min(d, dur * 0.2, max(dur - 1e-4, 0.0) * 0.5)


def build_audio_segment_afade_parts(
    a_labels: list[str],
    segments: list[tuple[float, float]],
    *,
    fade_sec: float | None = None,
    id_prefix: str = "afd",
) -> tuple[list[str], list[str]]:
    """Sequential fade-out / fade-in per segment — no overlap blend (reorder-safe)."""
    parts: list[str] = []
    faded: list[str] = []
    for i, (label, (start, end)) in enumerate(zip(a_labels, segments, strict=True)):
        dur = float(end) - float(start)
        fd = segment_audio_fade_sec(dur, fade_sec)
        base = label.strip("[]")
        out_lbl = f"{id_prefix}{i}"
        out_st = max(0.0, dur - fd)
        if fd <= 1e-6:
            faded.append(label)
            continue
        parts.append(
            f"{label}afade=t=in:st=0:d={fd:.6f},"
            f"afade=t=out:st={out_st:.6f}:d={fd:.6f}[{out_lbl}]"
        )
        faded.append(f"[{out_lbl}]")
    return parts, faded


def build_audio_acrossfade_chain(
    a_labels: list[str],
    a_out: str,
    *,
    fade_sec: float | None = None,
    id_prefix: str = "axf",
) -> list[str]:
    """Chain [a0][a1]acrossfade… — export pop guard (2–5ms)."""
    if not a_labels:
        return []
    out_label = a_out if a_out.startswith("[") else f"[{a_out}]"
    if len(a_labels) == 1:
        lbl = a_labels[0]
        if lbl == out_label:
            return []
        return [f"{lbl}anull{out_label}"]

    d = clamp_export_crossfade_sec(fade_sec)
    parts: list[str] = []
    cur = a_labels[0]
    for i in range(1, len(a_labels)):
        next_lbl = a_labels[i]
        if i == len(a_labels) - 1:
            dst = out_label
        else:
            dst = f"[{id_prefix}{i}]"
        parts.append(f"{cur}{next_lbl}acrossfade=d={d:.6f}:c1=tri:c2=tri{dst}")
        cur = dst
    return parts


def _program_slot_pad_sec(
    start: float,
    end: float,
    program_slot_durations: list[float] | None,
    index: int,
) -> float:
    if not program_slot_durations or index >= len(program_slot_durations):
        return 0.0
    return max(0.0, float(program_slot_durations[index]) - (float(end) - float(start)))


def build_trim_concat_filter_parts(
    segments: list[tuple[float, float]],
    *,
    has_audio: bool,
    v_out: str,
    a_out: str | None,
    id_prefix: str,
    audio_crossfade_sec: float | None = None,
    program_slot_durations: list[float] | None = None,
) -> list[str]:
    """trim segments → optional program-slot pad → video/audio concat."""
    parts: list[str] = []
    if not segments:
        return parts

    v_out_b = v_out if v_out.startswith("[") else f"[{v_out}]"
    a_out_b = (
        (a_out if a_out.startswith("[") else f"[{a_out}]")
        if a_out
        else None
    )

    if len(segments) == 1:
        start, end = segments[0]
        pad = _program_slot_pad_sec(start, end, program_slot_durations, 0)
        v_lbl = v_out_b.strip("[]")
        v_trim = f"{id_prefix}v0t"
        parts.append(
            f"[0:v]trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS[{v_trim}]"
        )
        if pad > 1e-6:
            parts.append(
                f"[{v_trim}]tpad=stop_mode=clone:stop_duration={pad:.6f}[{v_lbl}]"
            )
        else:
            parts.append(f"[{v_trim}]null[{v_lbl}]")
        if has_audio and a_out_b:
            a_lbl = a_out_b.strip("[]")
            a_trim = f"{id_prefix}a0t"
            parts.append(
                f"[0:a]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[{a_trim}]"
            )
            if pad > 1e-6:
                parts.append(f"[{a_trim}]apad=pad_dur={pad:.6f}[{a_lbl}]")
            else:
                parts.append(f"[{a_trim}]anull[{a_lbl}]")
        return parts

    v_labels: list[str] = []
    a_labels: list[str] = []
    for i, (start, end) in enumerate(segments):
        pad = _program_slot_pad_sec(start, end, program_slot_durations, i)
        vi = f"{id_prefix}v{i}t"
        parts.append(
            f"[0:v]trim=start={start:.6f}:end={end:.6f},setpts=PTS-STARTPTS[{vi}]"
        )
        if pad > 1e-6:
            vo = f"{id_prefix}v{i}p"
            parts.append(
                f"[{vi}]tpad=stop_mode=clone:stop_duration={pad:.6f}[{vo}]"
            )
            v_labels.append(f"[{vo}]")
        else:
            v_labels.append(f"[{vi}]")
        if has_audio:
            ai = f"{id_prefix}a{i}t"
            parts.append(
                f"[0:a]atrim=start={start:.6f}:end={end:.6f},asetpts=PTS-STARTPTS[{ai}]"
            )
            if pad > 1e-6:
                ao = f"{id_prefix}a{i}p"
                parts.append(f"[{ai}]apad=pad_dur={pad:.6f}[{ao}]")
                a_labels.append(f"[{ao}]")
            else:
                a_labels.append(f"[{ai}]")

    n = len(segments)
    fade = float(audio_crossfade_sec or 0)
    use_join_fade = has_audio and a_out_b and fade > 1e-6 and len(a_labels) > 1

    if use_join_fade:
        v_lbl = v_out_b.strip("[]")
        parts.append(f"{''.join(v_labels)}concat=n={n}:v=1:a=0[{v_lbl}]")
        afade_parts, faded_labels = build_audio_segment_afade_parts(
            a_labels,
            segments,
            fade_sec=fade,
            id_prefix=f"{id_prefix}af",
        )
        parts.extend(afade_parts)
        a_lbl = a_out_b.strip("[]")
        parts.append(f"{''.join(faded_labels)}concat=n={n}:v=0:a=1[{a_lbl}]")
    elif has_audio and a_out_b:
        concat_in = "".join(
            label for i in range(n) for label in (v_labels[i], a_labels[i])
        )
        a_lbl = a_out_b.strip("[]")
        v_lbl = v_out_b.strip("[]")
        parts.append(f"{concat_in}concat=n={n}:v=1:a=1[{v_lbl}][{a_lbl}]")
    else:
        v_lbl = v_out_b.strip("[]")
        parts.append(f"{''.join(v_labels)}concat=n={n}:v=1:a=0[{v_lbl}]")

    return parts
