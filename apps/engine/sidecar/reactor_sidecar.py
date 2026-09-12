#!/usr/bin/env python3
"""Reactor sidecar: drives one reactor-sdk session for one channel-event.

Spawned once per `render(ev)` call by the Node engine. Speaks JSON lines on
stdin/stdout, nothing else on stdout. Logs go to stderr. See
`.scratch/video-vendor/spec.md` section 5 and issue 14 for the contract.

Protocol
--------
in (stdin, one JSON object per line, exactly these two, in order):
  {"cmd":"start","model":"reactor/fast-h3","work":"<dir>","ready_timeout_s":60}
  {"cmd":"plan","segments":[{"name":"first","clips":[{"id":"f0","prompt":"...",
    "seconds":10,"starting_frame":null,"continue_from":null}, ...]}, ...]}

out (stdout, one JSON object per line):
  {"event":"ready"}
  {"event":"error","stage":"connect","reason":"..."}
  {"event":"clip","id":"f0","state":"generated"|"started"|"finished"|"failed","t":12.3}
  {"event":"segment","name":"first","start_t":9.1,"end_t":69.4}
  {"event":"done","recording":"<work>/session.mp4","billed_s":250.4,"fetch_s":28.0}
  {"event":"error","stage":"clip"|"recording"|"fetch","reason":"..."}   (exit 1)

`t` and every `*_t`/`billed_s`/`fetch_s` field is seconds since `ready`. We call
`request_recording()` immediately after `ready` (before anything else), so we
treat that same instant as t=0 for the recording too -- there is no engine-
observable gap between the two. If a future SDK version makes that call slow
or async, this assumption needs revisiting.

What the SDK actually does, read out of `reactor-sdk==1.5.0`'s own source
(installed offline, `site-packages/reactor_sdk/*.py`, 2026-09-12 -- no live
session). Four of these bite hard enough to be worth stating:

  1. The SDK is asyncio. `connect`, `disconnect`, `send_command`,
     `request_recording` and `upload_file` are all `async def`, so the session
     lifecycle runs under `asyncio.run()`. `connect()` takes no JWT and does
     not return until the status already reads `ready`, so awaiting it under
     `asyncio.wait_for(..., ready_timeout_s)` is the entire wait -- there is
     no poll loop to write.
  2. Clip events are not event names. `reactor.on(name, ...)` only ever fires
     `status_changed`, `error`, `message`, `runtime_message`, `track_received`,
     `capabilities_received` and `session_id_changed`. Every clip-lifecycle
     name arrives nested inside `message` as `{"type": ..., "data": {...}}`,
     so registering `on("clip_generated", ...)` silently never fires. Hence
     the single `on("message")` handler that switches on the payload type.
  3. The recording playlist is fragmented MP4: an `#EXT-X-MAP` init segment
     carrying `ftyp`/`moov` that every later `.m4s` fragment is meaningless
     without. Fetching only the non-comment lines yields a file no player
     opens, so this calls the SDK's own `download_clip()`, which assembles
     fMP4 correctly and needs no ffmpeg remux afterwards.
  4. `Reactor._jwt` is the only way to read the token back after
     `disconnect()`; the class has no public getter and disconnect does not
     clear it. Hence the private read below.

`send_command(command, data)` waits for its correlated reply, which is how a
plan id gets mapped to a real clip UUID for `continue_from_clip_id`.

Read from the fast-h3 schema page rather than the package, so docs-checked
only: the `enqueue` field names (`prompt`, `seconds`, `starting_frame`,
`continue_from_clip_id`), that an omitted `position` appends to the back of
the queue, and that an `enqueue` reply carries the UUID at
`data.clip.clip_id`. Nothing here has been exercised against a live account.
The `on("error", ...)` mid-session teardown has no citation at all; it is
defensive plumbing.
"""
import asyncio
import json
import os
import signal
import sys
import time

RECORDING_MAX_202_S = 60.0

EVENT_STATE_BY_SDK_NAME = {
    "clip_generated": "generated",
    "clip_started": "started",
    "clip_finished": "finished",
    "clip_failed": "failed",
}


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def emit(obj):
    print(json.dumps(obj), flush=True)


def read_cmd():
    line = sys.stdin.readline()
    if not line:
        return None
    return json.loads(line)


class PlanClip:
    __slots__ = ("plan_id", "segment", "prompt", "seconds", "starting_frame", "continue_from", "uuid")

    def __init__(self, plan_id, segment, prompt, seconds, starting_frame, continue_from):
        self.plan_id = plan_id
        self.segment = segment
        self.prompt = prompt
        self.seconds = seconds
        self.starting_frame = starting_frame
        self.continue_from = continue_from
        self.uuid = None  # filled in with Reactor's own clip_id once enqueued


def flatten_plan(segments):
    """Flattens plan segments into one ordered clip list (first half, then each
    branch in order), plus each segment's (first_index, last_index) into that
    list. Enqueueing strictly in this order guarantees every `continue_from`
    target (a same-branch predecessor, or the last first-half clip) already has
    its real UUID by the time it is needed -- the first half fully enqueues
    before any branch clip does.

    A comment the spec asked for: the last first-half clip must stay resolvable
    in the session's build history for every branch's first clip to chain from
    it. With a build lead of two, that history entry isn't evicted before the
    5th branch starts (N_OUTCOMES tops out at 5), per the research doc's note on
    `queue_update.history` being a bounded, evicting list.
    """
    clips = []
    seg_bounds = {}
    for seg in segments:
        start_idx = len(clips)
        for c in seg["clips"]:
            clips.append(
                PlanClip(
                    plan_id=c["id"],
                    segment=seg["name"],
                    prompt=c["prompt"],
                    seconds=c["seconds"],
                    starting_frame=c.get("starting_frame"),
                    continue_from=c.get("continue_from"),
                )
            )
        seg_bounds[seg["name"]] = (start_idx, len(clips) - 1)
    return clips, seg_bounds


async def safe_disconnect(reactor):
    try:
        await reactor.disconnect()
    except Exception as exc:  # ponytail: best-effort cleanup, never let this mask the real error
        log(f"disconnect during cleanup failed: {exc}")
    finally:
        reactor.close()


async def run(reactor_module, start_cmd, plan_cmd):
    """Runs the whole session lifecycle. `reactor_module` is the imported
    `reactor_sdk` module (passed in so `--selftest` never has to import it).
    """
    model = start_cmd["model"]
    work_dir = start_cmd["work"]
    ready_timeout_s = start_cmd.get("ready_timeout_s", 60)
    os.makedirs(work_dir, exist_ok=True)

    api_key = os.environ.get("REACTOR_API_KEY")
    if not api_key:
        emit({"event": "error", "stage": "connect", "reason": "REACTOR_API_KEY is not set"})
        sys.exit(1)

    events: asyncio.Queue = asyncio.Queue()

    def on_status_changed(status):
        events.put_nowait(("status_changed", status))

    def on_message(payload):
        events.put_nowait(("message", payload))

    def on_sdk_error(err):
        events.put_nowait(("sdk_error", err))

    try:
        reactor = reactor_module.Reactor(model_name=model, api_key=api_key)
        reactor.on("status_changed", on_status_changed)
        reactor.on("message", on_message)
        reactor.on("error", on_sdk_error)
    except Exception as exc:
        emit({"event": "error", "stage": "connect", "reason": str(exc)})
        sys.exit(1)

    loop = asyncio.get_running_loop()

    async def cleanup_and_exit():
        await safe_disconnect(reactor)
        os._exit(0)  # hard exit: RUNBOOK promises SIGTERM exits within 3s

    loop.add_signal_handler(signal.SIGTERM, lambda: asyncio.ensure_future(cleanup_and_exit()))

    try:
        await asyncio.wait_for(reactor.connect(), timeout=ready_timeout_s)
    except TimeoutError:
        emit({"event": "error", "stage": "connect", "reason": f"ready not reached within {ready_timeout_s}s"})
        await safe_disconnect(reactor)
        sys.exit(1)
    except Exception as exc:
        emit({"event": "error", "stage": "connect", "reason": str(exc)})
        await safe_disconnect(reactor)
        sys.exit(1)

    emit({"event": "ready"})
    ready_t0 = time.monotonic()

    try:
        recording_clip = await reactor.request_recording()
        await reactor.send_command("set_autoplay", {"enabled": True})
    except Exception as exc:
        emit({"event": "error", "stage": "clip", "reason": f"post-ready setup failed: {exc}"})
        await safe_disconnect(reactor)
        sys.exit(1)

    clips, seg_bounds = flatten_plan(plan_cmd["segments"])
    by_plan_id = {c.plan_id: c for c in clips}
    idx_of = {c.plan_id: i for i, c in enumerate(clips)}
    first_clip_idx_to_segment = {bounds[0]: name for name, bounds in seg_bounds.items()}
    last_clip_idx_to_segment = {bounds[1]: name for name, bounds in seg_bounds.items()}
    segment_start_t = {}

    uuid_to_clip = {}
    next_to_enqueue = 0
    BUILD_LEAD = 2

    async def enqueue_next():
        nonlocal next_to_enqueue
        if next_to_enqueue >= len(clips):
            return
        clip = clips[next_to_enqueue]
        next_to_enqueue += 1

        command_data = {"prompt": clip.prompt, "seconds": clip.seconds}
        if clip.starting_frame:
            command_data["starting_frame"] = await reactor.upload_file(clip.starting_frame)
        if clip.continue_from:
            command_data["continue_from_clip_id"] = by_plan_id[clip.continue_from].uuid

        result = await reactor.send_command("enqueue", command_data)
        clip.uuid = result["data"]["clip"]["clip_id"]
        uuid_to_clip[clip.uuid] = clip

    try:
        for _ in range(min(BUILD_LEAD, len(clips))):
            await enqueue_next()

        last_clip_index = len(clips) - 1
        finished_last = False
        while not finished_last:
            kind, payload = await events.get()

            if kind == "sdk_error":
                emit({"event": "error", "stage": "clip", "reason": f"transport error: {payload}"})
                await safe_disconnect(reactor)
                sys.exit(1)
            if kind == "status_changed" and payload == "disconnected":
                emit({"event": "error", "stage": "clip", "reason": "session disconnected before the plan finished"})
                sys.exit(1)
            if kind != "message":
                continue

            msg_type = payload.get("type")
            data = payload.get("data") or {}

            if msg_type == "command_error":
                emit({"event": "error", "stage": "clip", "reason": f"command_error: {data}"})
                await safe_disconnect(reactor)
                sys.exit(1)
            if msg_type not in EVENT_STATE_BY_SDK_NAME:
                continue

            clip_uuid = data.get("clip_id")
            clip = uuid_to_clip.get(clip_uuid)
            if clip is None:
                log(f"{msg_type} for unknown clip uuid {clip_uuid!r}, ignoring")
                continue

            t = round(time.monotonic() - ready_t0, 1)
            state = EVENT_STATE_BY_SDK_NAME[msg_type]
            emit({"event": "clip", "id": clip.plan_id, "state": state, "t": t})

            if msg_type == "clip_failed":
                emit({"event": "error", "stage": "clip", "reason": f"clip {clip.plan_id} failed"})
                await safe_disconnect(reactor)
                sys.exit(1)

            idx = idx_of[clip.plan_id]

            if msg_type == "clip_started" and idx in first_clip_idx_to_segment:
                segment_start_t[first_clip_idx_to_segment[idx]] = t

            if msg_type == "clip_finished":
                if idx in last_clip_idx_to_segment:
                    name = last_clip_idx_to_segment[idx]
                    emit({"event": "segment", "name": name, "start_t": segment_start_t[name], "end_t": t})
                if idx == last_clip_index:
                    finished_last = True
                else:
                    await enqueue_next()
    except SystemExit:
        raise
    except Exception as exc:
        emit({"event": "error", "stage": "clip", "reason": str(exc)})
        await safe_disconnect(reactor)
        sys.exit(1)

    # Last clip finished: disconnect at once so billing stops, before fetching anything.
    # Read before disconnect (though disconnect() never clears it -- see module
    # docstring item 4): reactor._jwt is the only way to get this back.
    jwt = reactor._jwt  # noqa: SLF001 -- verified against reactor_sdk 1.5.0's own client.py: no public getter exists
    await reactor.disconnect()
    billed_s = round(time.monotonic() - ready_t0, 1)

    fetch_t0 = time.monotonic()
    mp4_path = os.path.join(work_dir, "session.mp4")
    try:
        # reactor_sdk.download_clip() already handles the fragmented-MP4 playlist
        # (init segment + .m4s fragments) and the 202/Retry-After poll -- see
        # module docstring item 5. `while_live` is left unset (None): the client
        # is already disconnected here, so `reactor.status` would read
        # "disconnected" and make the SDK's own while_live check fail a still-
        # assembling playlist immediately instead of waiting out RECORDING_MAX_202_S.
        await reactor_module.download_clip(
            recording_clip, mp4_path, jwt=jwt, ready_timeout=RECORDING_MAX_202_S
        )
    except TimeoutError as exc:
        emit({"event": "error", "stage": "recording", "reason": str(exc)})
        sys.exit(1)
    except Exception as exc:
        emit({"event": "error", "stage": "fetch", "reason": str(exc)})
        sys.exit(1)
    finally:
        reactor.close()
    fetch_s = round(time.monotonic() - fetch_t0, 1)

    emit({"event": "done", "recording": mp4_path, "billed_s": billed_s, "fetch_s": fetch_s})
    sys.exit(0)


def main():
    start_cmd = read_cmd()
    if start_cmd is None or start_cmd.get("cmd") != "start":
        log("expected a 'start' command first")
        sys.exit(1)

    # Imported lazily so `--selftest` (pure-logic checks) never needs reactor-sdk installed.
    # A missing wheel is the likeliest deploy failure (wrong REACTOR_PYTHON, venv not
    # built), so it answers in the protocol rather than as a traceback the engine
    # can only report as "exit 1".
    try:
        import reactor_sdk
    except ImportError as exc:
        emit({"event": "error", "stage": "connect", "reason": f"reactor-sdk is not installed for {sys.executable}: {exc}"})
        sys.exit(1)

    plan_cmd = read_cmd()
    if plan_cmd is None or plan_cmd.get("cmd") != "plan":
        emit({"event": "error", "stage": "clip", "reason": "expected a 'plan' command after 'start'"})
        sys.exit(1)

    asyncio.run(run(reactor_sdk, start_cmd, plan_cmd))


def selftest():
    """No network, no reactor-sdk: checks the pure plan-flattening and segment-
    boundary logic the whole protocol's `segment`/chaining correctness rests on.
    """
    segments = [
        {
            "name": "first",
            "clips": [
                {"id": f"f{i}", "prompt": "p", "seconds": 10, "starting_frame": None, "continue_from": None}
                for i in range(6)
            ],
        },
        {
            "name": "branch-0",
            "clips": [{"id": "b0-0", "prompt": "p", "seconds": 10, "starting_frame": None, "continue_from": "f5"}],
        },
        {
            "name": "branch-1",
            "clips": [{"id": "b1-0", "prompt": "p", "seconds": 10, "starting_frame": None, "continue_from": "f5"}],
        },
    ]
    clips, seg_bounds = flatten_plan(segments)

    assert [c.plan_id for c in clips] == ["f0", "f1", "f2", "f3", "f4", "f5", "b0-0", "b1-0"]
    assert seg_bounds["first"] == (0, 5)
    assert seg_bounds["branch-0"] == (6, 6)
    assert seg_bounds["branch-1"] == (7, 7)

    # Enqueue order is strictly the flattened order, so by the time each branch's
    # first clip is enqueued, "f5" (its continue_from target) was already
    # enqueued and would already carry a real uuid in the live run.
    idx_of = {c.plan_id: i for i, c in enumerate(clips)}
    assert idx_of["f5"] < idx_of["b0-0"] < idx_of["b1-0"]

    assert set(EVENT_STATE_BY_SDK_NAME.values()) == {"generated", "started", "finished", "failed"}

    print("selftest OK", file=sys.stderr)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
