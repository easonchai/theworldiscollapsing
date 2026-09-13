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
  {"event":"disconnected","billed_s":250.4}
  {"event":"done","recording":"<work>/session.mp4","billed_s":250.4,"fetch_s":28.0,
    "first_media_t":3.2,"fetch_attempts":1,"recording_s":250.6,"recording_short_by_s":null}
  {"event":"error","stage":"clip"|"recording"|"fetch","reason":"..."}   (exit 1)

`t` and every `*_t`/`billed_s`/`fetch_s` field is seconds since `ready`. We call
`request_recording()` immediately after `ready` (before anything else), so we
treat that same instant as t=0 for the recording too -- there is no engine-
observable gap between the two. If a future SDK version makes that call slow
or async, this assumption needs revisiting.

`disconnected` fires right after `reactor.disconnect()` returns and before the download starts, so
the engine can free its Reactor session slot the moment billing stops instead of holding it through
the whole fetch (issue 27). A dropped download retries up to 3 times against the same recording
handle and JWT, both still valid after disconnect, before it reports `stage: "fetch"`; a
`TimeoutError` from the 202/Retry-After poll is not one of those retries and still reports `stage:
"recording"` (issue 24). The recording is a fragmented MP4 still being assembled when the fetch
starts, so after a successful download the sidecar ffprobes it against the last `segment`'s `end_t`
and re-downloads until it is covered or `COMPLETENESS_BUDGET_S` of waiting is spent; measured -0.55 s
and -14.51 s short on two sessions on 2026-09-12 before this existed (issue 26). That budget used to
be the same number as the per-download `ready_timeout` handed to `download_clip`
(`DOWNLOAD_READY_TIMEOUT_S` now), which made it impossible to raise one without the other; issue 32
split them, because there is no fixed recording ceiling (a probe recorded 162.0 s, well past the
131.70905 s that earlier looked like one) and the surviving suspect for a short tail is server-side
assembly still running behind under a contended load, not a vendor limit. `REACTOR_COMPLETENESS_BUDGET_S`
in the environment raises the budget per paid round with no rebuild -- exactly the experiment issue 32
leaves open. `fetch_attempts`, `recording_s` and `recording_short_by_s` on `done` make all of this
readable from the `done` lines alone, without grepping stderr.

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
import subprocess
import sys
import time

DOWNLOAD_READY_TIMEOUT_S = 60.0  # per download_clip() call: how long one 202/Retry-After poll waits
MAX_FETCH_ATTEMPTS = 3  # issue 24: a reset TCP connection is an ordinary event on a large CDN transfer
FETCH_BACKOFF_S = (2.0, 4.0)  # between attempts 1->2 and 2->3
COMPLETENESS_THRESHOLD_S = 0.5  # spec section 10's cut-error threshold
COMPLETENESS_RETRY_SLEEP_S = 2.0  # ponytail: fixed poll interval, shorten if 202 assembly is faster than this

# issue 32: ensure_recording_complete()'s own total wall-clock budget. Used to be the same constant as
# DOWNLOAD_READY_TIMEOUT_S above (RECORDING_MAX_202_S), so raising one always lengthened the other;
# split apart so the completeness budget can move without changing what one download_clip() call waits
# for. 180.0s clears both contended fetches issue 32 measured against the old 60s budget -- culture's
# 104.9s over 6 attempts, region's 176.7s over 3 -- so a paid four-channel round has enough room to
# test whether more budget actually recovers the missing tail, per the ticket's open experiment.
# REACTOR_COMPLETENESS_BUDGET_S overrides it per round with no rebuild (the engine spawns this with
# its own environment, so the engine's .env reaches here); a missing or unparseable value falls back
# to the default rather than crashing a paid session over a typo.
DEFAULT_COMPLETENESS_BUDGET_S = 180.0
try:
    COMPLETENESS_BUDGET_S = float(
        os.environ.get("REACTOR_COMPLETENESS_BUDGET_S", DEFAULT_COMPLETENESS_BUDGET_S)
    )
except (TypeError, ValueError):
    COMPLETENESS_BUDGET_S = DEFAULT_COMPLETENESS_BUDGET_S

EVENT_STATE_BY_SDK_NAME = {
    "clip_generated": "generated",
    "clip_started": "started",
    "clip_finished": "finished",
    "clip_failed": "failed",
}


def clip_id_of(data):
    """The clip uuid out of a clip event's `data`, whichever shape it arrives in.

    The `enqueue` reply nests it at `data.clip.clip_id`, so this read the flat `data.clip_id` for
    clip events on the assumption they differed. Against live Reactor on 2026-09-12 the flat key
    was absent and every clip event was dropped, so check both rather than pick a side.
    """
    nested = data.get("clip")
    if isinstance(nested, dict) and nested.get("clip_id"):
        return nested["clip_id"]
    return data.get("clip_id") or data.get("id")


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


async def fetch_with_retry(reactor_module, recording_clip, mp4_path, jwt):
    """Downloads the recording, retrying a dropped transfer against the same
    handle and JWT (both stay valid after disconnect, see issue 24). A
    TimeoutError from download_clip's own 202/Retry-After poll means the
    recording itself never finished assembling, not a network blip, so it is
    raised straight through instead of retried, and the caller still reports
    it as `stage: "recording"`. Returns the number of download_clip calls made.
    """
    for attempt in range(1, MAX_FETCH_ATTEMPTS + 1):
        log(f"fetch attempt {attempt}/{MAX_FETCH_ATTEMPTS}")
        try:
            await reactor_module.download_clip(
                recording_clip, mp4_path, jwt=jwt, ready_timeout=DOWNLOAD_READY_TIMEOUT_S
            )
            return attempt
        except TimeoutError:
            raise
        except Exception as exc:
            log(f"fetch attempt {attempt}/{MAX_FETCH_ATTEMPTS} failed: {exc}")
            if attempt == MAX_FETCH_ATTEMPTS:
                raise
            await asyncio.sleep(FETCH_BACKOFF_S[attempt - 1])
    raise AssertionError("unreachable")  # loop above always returns or raises


def parse_ffprobe_duration(stdout_text):
    """ffprobe's `-of csv=p=0` duration output, parsed to a float. None if it
    doesn't parse (empty output, "N/A", a stray warning line) -- a confused
    ffprobe should not fail a paid session (issue 26)."""
    try:
        return float(stdout_text.strip())
    except (ValueError, AttributeError):
        return None


def probe_duration_s(path):
    """The file's duration per ffprobe, or None if ffprobe is missing or its
    output can't be read. ffprobe is already a hard dependency of this system
    (the engine shells out to ffmpeg to cut segments), but a paid recording
    should not be failed over a missing probe binary."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=10, check=True,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log(f"ffprobe unavailable, proceeding without a completeness check: {exc}")
        return None
    return parse_ffprobe_duration(result.stdout)


def is_recording_short(measured_s, required_end_t, threshold_s=COMPLETENESS_THRESHOLD_S):
    """True when the file falls short of the last segment's `end_t` by more
    than `threshold_s` (issue 26). Never short when there is nothing to
    compare: `measured_s` is None (ffprobe unavailable) or `required_end_t` is
    None (no segment was ever emitted).
    """
    if measured_s is None or required_end_t is None:
        return False
    return (required_end_t - measured_s) > threshold_s


def recording_short_by_s(measured_s, required_end_t, threshold_s=COMPLETENESS_THRESHOLD_S):
    """How many seconds the final recording falls short of the last segment's
    `end_t`, for the `done` event's `recording_short_by_s` key (issue 32: the
    four-channel experiment needs this readable from `done` alone). `None`
    whenever `is_recording_short` says it isn't short -- same threshold, same
    None-input rule (ffprobe unavailable, or no segment ever emitted) -- so the
    two never disagree.
    """
    if not is_recording_short(measured_s, required_end_t, threshold_s):
        return None
    return round(required_end_t - measured_s, 2)


async def ensure_recording_complete(reactor_module, recording_clip, mp4_path, jwt, required_end_t):
    """After a successful download, re-downloads against the same handle
    until ffprobe says the file covers `required_end_t` or
    `COMPLETENESS_BUDGET_S` of waiting has passed (issue 26): the recording is a
    fragmented MP4 still being assembled when the fetch starts, so the first
    download can land short. Never raises -- a short recording still yields
    most of the event, so the caller reports `done` either way. Returns
    (measured_duration_or_None, extra_download_clip_calls).
    """
    measured = probe_duration_s(mp4_path)
    log(f"recording duration {measured}s, required at least {required_end_t}s")
    deadline = time.monotonic() + COMPLETENESS_BUDGET_S
    attempts = 0
    while is_recording_short(measured, required_end_t) and time.monotonic() < deadline:
        attempts += 1
        log(f"recording short of {required_end_t}s (have {measured}s), re-downloading (attempt {attempts})")
        await asyncio.sleep(COMPLETENESS_RETRY_SLEEP_S)
        try:
            await reactor_module.download_clip(
                recording_clip, mp4_path, jwt=jwt, ready_timeout=DOWNLOAD_READY_TIMEOUT_S
            )
        except Exception as exc:
            log(f"completeness re-download failed, keeping what's on disk: {exc}")
            break
        measured = probe_duration_s(mp4_path)
        log(f"recording duration after re-download: {measured}s")
    if is_recording_short(measured, required_end_t):
        log(f"completeness budget exhausted, recording still short: {measured}s vs {required_end_t}s")
    return measured, attempts


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
    first_media_t = None
    max_end_t = None  # largest segment end_t emitted; issue 26 checks the download against this

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

            clip_uuid = clip_id_of(data)
            clip = uuid_to_clip.get(clip_uuid)
            if clip is None:
                # Ignoring these used to mean the session stalled: `enqueue_next` only runs on a
                # matched `clip_finished`, so an unreadable id deadlocks the queue at BUILD_LEAD
                # clips and burns the whole watchdog deadline building nothing fetchable. That
                # cost one 235 s session on 2026-09-12. Fail on the first miss instead, and put the
                # payload in the reason so the real key is one run away, not one session away.
                emit({
                    "event": "error",
                    "stage": "clip",
                    "reason": (
                        f"{msg_type} carried no clip id this sidecar can read "
                        f"(uuid={clip_uuid!r}, known={sorted(uuid_to_clip)}): payload={data!r}"
                    ),
                })
                await safe_disconnect(reactor)
                sys.exit(1)

            t = round(time.monotonic() - ready_t0, 1)
            state = EVENT_STATE_BY_SDK_NAME[msg_type]
            emit({"event": "clip", "id": clip.plan_id, "state": state, "t": t})

            if msg_type == "clip_failed":
                emit({"event": "error", "stage": "clip", "reason": f"clip {clip.plan_id} failed"})
                await safe_disconnect(reactor)
                sys.exit(1)

            idx = idx_of[clip.plan_id]

            if msg_type == "clip_started":
                if first_media_t is None:
                    first_media_t = t
                if idx in first_clip_idx_to_segment:
                    segment_start_t[first_clip_idx_to_segment[idx]] = t

            if msg_type == "clip_finished":
                if idx in last_clip_idx_to_segment:
                    name = last_clip_idx_to_segment[idx]
                    # `segment` offsets index into the recording, whose clock starts at the first
                    # frame of media, not at `ready` -- measured 2026-09-12: with ready-relative
                    # offsets the first three cuts matched on duration but held content 5.9 s late,
                    # and the last branch ran off the end of a 46.4 s file and came out 3.49 s long.
                    # Clip `t` stays ready-relative; that is the billing clock.
                    end_t = round(t - first_media_t, 1)
                    max_end_t = end_t if max_end_t is None else max(max_end_t, end_t)
                    emit({
                        "event": "segment",
                        "name": name,
                        "start_t": round(segment_start_t[name] - first_media_t, 1),
                        "end_t": end_t,
                    })
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

    # `request_recording()` returns "a clip covering the entire session up to now", so it only
    # exists once media does: calling it right after `ready` (as this did until 2026-09-12) asks
    # for a clip covering nothing, and live Reactor refuses with
    # "[INTERNAL_ERROR] recording error (INTERNAL_ERROR): no media generated yet".
    # It has to be the last thing before disconnect, after the final clip.
    try:
        recording_clip = await reactor.request_recording()
    except Exception as exc:
        emit({"event": "error", "stage": "recording", "reason": f"request_recording failed: {exc}"})
        await safe_disconnect(reactor)
        sys.exit(1)

    # Last clip finished: disconnect at once so billing stops, before fetching anything.
    # Read before disconnect (though disconnect() never clears it -- see module
    # docstring item 4): reactor._jwt is the only way to get this back.
    jwt = reactor._jwt  # noqa: SLF001 -- verified against reactor_sdk 1.5.0's own client.py: no public getter exists
    await reactor.disconnect()
    billed_s = round(time.monotonic() - ready_t0, 1)
    # issue 27: the engine frees its Reactor session slot on this line, before the download starts.
    emit({"event": "disconnected", "billed_s": billed_s})

    fetch_t0 = time.monotonic()
    mp4_path = os.path.join(work_dir, "session.mp4")
    try:
        # reactor_sdk.download_clip() already handles the fragmented-MP4 playlist
        # (init segment + .m4s fragments) and the 202/Retry-After poll -- see
        # module docstring item 5. `while_live` is left unset (None): the client
        # is already disconnected here, so `reactor.status` would read
        # "disconnected" and make the SDK's own while_live check fail a still-
        # assembling playlist immediately instead of waiting out DOWNLOAD_READY_TIMEOUT_S.
        fetch_attempts = await fetch_with_retry(reactor_module, recording_clip, mp4_path, jwt)
    except TimeoutError as exc:
        emit({"event": "error", "stage": "recording", "reason": str(exc)})
        sys.exit(1)
    except Exception as exc:
        emit({
            "event": "error",
            "stage": "fetch",
            "reason": (
                f"session built fine ({billed_s}s billed) but downloading the recording failed "
                f"after {MAX_FETCH_ATTEMPTS} attempts: {exc}"
            ),
        })
        sys.exit(1)
    finally:
        reactor.close()

    # issue 26: the playlist can still be assembling when the download above returns.
    recording_s, extra_attempts = await ensure_recording_complete(
        reactor_module, recording_clip, mp4_path, jwt, max_end_t
    )
    fetch_attempts += extra_attempts
    # After the completeness wait, not before it: spec section 10 reads `fetch_s` as how long the
    # whole fetch stage takes, and the re-downloads are part of that stage. Measuring only the first
    # download would report the 66.7 s culture fetch as fast while it waited out a short playlist.
    fetch_s = round(time.monotonic() - fetch_t0, 1)
    short_by_s = recording_short_by_s(recording_s, max_end_t)  # issue 32: readable from `done` alone

    emit({
        "event": "done",
        "recording": mp4_path,
        "billed_s": billed_s,
        "fetch_s": fetch_s,
        "first_media_t": first_media_t,
        "fetch_attempts": fetch_attempts,
        "recording_s": recording_s,
        "recording_short_by_s": short_by_s,
    })
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

    # issue 24: fixed, bounded backoff between fetch attempts
    assert FETCH_BACKOFF_S == (2.0, 4.0)
    assert len(FETCH_BACKOFF_S) == MAX_FETCH_ATTEMPTS - 1

    # issue 26: short exactly on the sessions the ticket measured, not on -c copy's normal jitter
    assert is_recording_short(29.75, 30.3) is True  # real region branch-2: -0.55s
    assert is_recording_short(20.79, 35.3) is True  # real culture branch-2: -14.51s
    assert is_recording_short(30.28, 30.3) is False  # -0.02s keyframe jitter, under threshold
    assert is_recording_short(None, 30.3) is False  # ffprobe unavailable: never fail a session over it
    assert is_recording_short(30.0, None) is False  # no segment ever emitted: nothing to compare

    # issue 32: recording_short_by_s on `done`, same round D numbers as issue 26's validation
    assert recording_short_by_s(124.075717, 124.6) == 0.52  # culture seq 50, budget exhausted
    assert recording_short_by_s(131.70905, 142.0) == 10.29  # region seq 47, budget exhausted
    assert recording_short_by_s(131.70905, 131.4) is None  # sports/politics seq: full, not short
    assert recording_short_by_s(None, 131.4) is None  # ffprobe unavailable: nothing to compare
    assert recording_short_by_s(131.70905, None) is None  # no segment ever emitted: nothing to compare

    assert parse_ffprobe_duration("29.752000\n") == 29.752
    assert parse_ffprobe_duration("N/A\n") is None
    assert parse_ffprobe_duration("") is None

    print("selftest OK", file=sys.stderr)


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        selftest()
    else:
        main()
