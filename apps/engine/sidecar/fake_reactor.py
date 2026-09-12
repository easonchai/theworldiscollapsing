#!/usr/bin/env python3
"""Fake Reactor sidecar: no reactor-sdk, no network, no API key. Speaks the
identical JSON-lines protocol as `reactor_sidecar.py` (see its docstring for
the protocol table) so `VIDEO_VENDOR=reactor` runs through the real
`reactor.ts` in soaks with the budget off. Selected with `REACTOR_SIDECAR=fake`.
See `.scratch/video-vendor/spec.md` section 7 and issue 16.

Env:
  FAKE_SPEED      Wall-clock speedup, default 20. Emitted `t`/`billed_s`
                  values are what a real 1.0x session would report; actual
                  sleeping is that divided by FAKE_SPEED, so a 60s plan
                  finishes in about 3s of wall time.
  FAKE_MEDIA_DIR  Replay real clips instead of ffmpeg testsrc2. Same
                  "<channel|any>-<resolution>-<anything>.mp4" file naming as
                  `apps/engine/src/fake/openrouter.ts`'s `replay()`.
  FAKE_FAIL       A clip id: that clip emits "failed" and the sidecar exits 1
                  right after, so the engine's RENDER retry path can be soaked.
"""
import json
import os
import re
import signal
import subprocess
import sys
import time

FAKE_SPEED = float(os.environ.get("FAKE_SPEED", "20"))
FAKE_MEDIA_DIR = os.environ.get("FAKE_MEDIA_DIR")
FAKE_FAIL = os.environ.get("FAKE_FAIL")
RESOLUTION = "720p"  # ponytail: fixed; the protocol carries no per-session resolution to key on.
SIZE = "1280x720"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def read_cmd() -> dict | None:
    line = sys.stdin.readline()
    return json.loads(line) if line else None


def flatten_plan(segments: list[dict]) -> tuple[list[dict], dict[str, tuple[int, int]]]:
    """First half then each branch, in plan order -- the same layout
    `reactor_sidecar.py`'s session sees. Returns the flat clip list and each
    segment's (first_index, last_index) into it.
    """
    clips: list[dict] = []
    seg_bounds: dict[str, tuple[int, int]] = {}
    for seg in segments:
        start = len(clips)
        clips.extend(seg["clips"])
        seg_bounds[seg["name"]] = (start, len(clips) - 1)
    return clips, seg_bounds


def channel_of(prompt: str) -> str:
    """Same heuristic as `fake/openrouter.ts`'s `replay()`: the channel house
    style is baked into every clip prompt by `clipPrompt()` before it reaches
    us, so matching on it here needs no extra field on the wire.
    """
    if re.search(r"reporter's camera|field footage", prompt, re.I):
        return "region"
    if re.search(r"press-pool|event television", prompt, re.I):
        return "culture"
    if re.search(r"news footage|studio", prompt, re.I):
        return "politics"
    if re.search(r"sports", prompt, re.I):
        return "sports"
    return "any"


_replay_cursor: dict[str, int] = {}


def replay_clip(prompt: str) -> str | None:
    """Picks a file from FAKE_MEDIA_DIR by the <channel|any>-<resolution>-*.mp4
    convention, round-robin per channel. None if there's no match (caller
    falls back to testsrc2).
    """
    channel = channel_of(prompt)
    all_files = sorted(f for f in os.listdir(FAKE_MEDIA_DIR) if f.endswith(".mp4") and f"-{RESOLUTION}-" in f)
    pool = [f for f in all_files if f.startswith(f"{channel}-")] or all_files
    if not pool:
        return None
    i = _replay_cursor.get(channel, 0)
    _replay_cursor[channel] = i + 1
    return os.path.join(FAKE_MEDIA_DIR, pool[i % len(pool)])


def build_part(clip: dict, work_dir: str, index: int) -> str:
    """One clip's video, exactly `clip["seconds"]` long, re-encoded to a
    common size/fps/pix_fmt so the final concat's durations -- and therefore
    the emitted `segment` offsets -- are byte-accurate.
    """
    seconds = clip["seconds"]
    out = os.path.join(work_dir, f"_part{index}.mp4")
    src = replay_clip(clip["prompt"]) if FAKE_MEDIA_DIR else None
    if src:
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-stream_loop", "-1", "-i", src,
            "-t", str(seconds), "-r", "24", "-vf", f"scale={SIZE}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", out,
        ]
    else:
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi", "-i", f"testsrc2=s={SIZE}:r=24:d={seconds}",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", out,
        ]
    subprocess.run(cmd, check=True, capture_output=True)
    return out


def build_session_mp4(clips: list[dict], work_dir: str) -> str:
    """`<work_dir>/session.mp4`: every clip's part, concatenated in flattened
    plan order so the offsets already emitted in `segment` events land where
    `reactor.ts` will later cut.
    """
    parts = [build_part(c, work_dir, i) for i, c in enumerate(clips)]
    concat_list = os.path.join(work_dir, "_concat.txt")
    with open(concat_list, "w") as f:
        f.writelines(f"file '{os.path.abspath(p)}'\n" for p in parts)
    session_path = os.path.join(work_dir, "session.mp4")
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", concat_list, "-c", "copy", session_path],
        check=True,
        capture_output=True,
    )
    for p in [*parts, concat_list]:
        os.remove(p)
    return session_path


def run(start_cmd: dict, plan_cmd: dict) -> None:
    work_dir = start_cmd["work"]
    os.makedirs(work_dir, exist_ok=True)

    signal.signal(signal.SIGTERM, lambda signum, frame: sys.exit(0))

    emit({"event": "ready"})

    clips, seg_bounds = flatten_plan(plan_cmd["segments"])
    first_of_segment = {bounds[0]: name for name, bounds in seg_bounds.items()}
    last_of_segment = {bounds[1]: name for name, bounds in seg_bounds.items()}
    segment_start_t: dict[str, float] = {}

    t = 0.0
    for idx, clip in enumerate(clips):
        if idx in first_of_segment:
            segment_start_t[first_of_segment[idx]] = round(t, 1)
        emit({"event": "clip", "id": clip["id"], "state": "started", "t": round(t, 1)})
        time.sleep(clip["seconds"] / FAKE_SPEED)
        t += clip["seconds"]

        if clip["id"] == FAKE_FAIL:
            emit({"event": "clip", "id": clip["id"], "state": "failed", "t": round(t, 1)})
            emit({"event": "error", "stage": "clip", "reason": f"clip {clip['id']} failed (FAKE_FAIL)"})
            sys.exit(1)

        emit({"event": "clip", "id": clip["id"], "state": "finished", "t": round(t, 1)})
        if idx in last_of_segment:
            name = last_of_segment[idx]
            emit({"event": "segment", "name": name, "start_t": segment_start_t[name], "end_t": round(t, 1)})

    billed_s = round(t, 1)  # what a real 1.0x session would have billed, not our sped-up wall clock
    emit({"event": "disconnected", "billed_s": billed_s})
    fetch_t0 = time.monotonic()
    try:
        session_path = build_session_mp4(clips, work_dir)
    except subprocess.CalledProcessError as exc:
        reason = exc.stderr.decode() if exc.stderr else str(exc)
        emit({"event": "error", "stage": "fetch", "reason": reason})
        sys.exit(1)
    fetch_s = round(time.monotonic() - fetch_t0, 1)

    emit({
        "event": "done",
        "recording": session_path,
        "billed_s": billed_s,
        "fetch_s": fetch_s,
        # No retries and no ffprobe here (see module docstring); the fake's session.mp4 is built to
        # exactly `billed_s` by construction, so that doubles as its own duration.
        "fetch_attempts": 1,
        "recording_s": billed_s,
    })
    sys.exit(0)


def main() -> None:
    start_cmd = read_cmd()
    if start_cmd is None or start_cmd.get("cmd") != "start":
        log("expected a 'start' command first")
        sys.exit(1)

    plan_cmd = read_cmd()
    if plan_cmd is None or plan_cmd.get("cmd") != "plan":
        emit({"event": "error", "stage": "clip", "reason": "expected a 'plan' command after 'start'"})
        sys.exit(1)

    run(start_cmd, plan_cmd)


def selftest() -> None:
    """No ffmpeg, no stdin: checks the plan-flattening/segment-boundary logic
    the `segment` event offsets rest on, and the replay channel heuristic.
    """
    segments = [
        {"name": "first", "clips": [{"id": f"f{i}", "prompt": "p", "seconds": 10} for i in range(3)]},
        {"name": "branch-0", "clips": [{"id": "b0-0", "prompt": "p", "seconds": 10}]},
    ]
    clips, seg_bounds = flatten_plan(segments)
    assert [c["id"] for c in clips] == ["f0", "f1", "f2", "b0-0"]
    assert seg_bounds == {"first": (0, 2), "branch-0": (3, 3)}

    assert channel_of("Local television news field footage, reporter's camera, natural light") == "region"
    assert channel_of("Live event television coverage, ENG press-pool camera") == "culture"
    assert channel_of("Television news footage, fixed studio camera") == "politics"
    assert channel_of("Live sports broadcast footage, broadcast camera") == "sports"
    assert channel_of("something else entirely") == "any"

    print("selftest OK", file=sys.stderr)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
