import { execFile, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Budget } from "./budget.js";
import { RenderFetchError, type EventRow, type Render } from "./machine.js";
import { branchFileName, type MediaStore } from "./media.js";
import { clipPrompt } from "./render.js";

// The Reactor `Render`: spawns the Python sidecar (`apps/engine/sidecar/reactor_sidecar.py` or, for
// soaks, `fake_reactor.py`) once per `render(ev)` call and drives it over the JSON-lines protocol
// documented in that file and in `.scratch/video-vendor/spec.md` sections 3 and 6.

const run = promisify(execFile);
/** Reactor's fast-h3 rate, confirmed in ticket 09's paid probe: $0.007 per billed second. */
const USD_PER_SEC = 0.007;
/** How long a sidecar gets to answer SIGTERM before SIGKILL, and then before we stop waiting. */
const SIGKILL_AFTER_MS = 3_000;
const REAP_GRACE_MS = 2_000;

type PlanClip = {
  id: string;
  prompt: string;
  seconds: number;
  starting_frame: null; // text-to-video seeds the first shot in this version; see spec section 6
  continue_from: string | null;
};
type PlanSegment = { name: string; clips: PlanClip[] };

/** Turns the authored script into the sidecar's plan: "first" plus one "branch-<i>" per outcome. */
function buildPlan(ev: EventRow): PlanSegment[] {
  const first = ev.script.firstHalf;
  const firstId = (i: number) => `f${i}`;
  const segments: PlanSegment[] = [
    {
      name: "first",
      clips: first.map((shot, i) => ({
        id: firstId(i),
        prompt: clipPrompt(ev.channelId, shot.prompt),
        seconds: shot.seconds,
        starting_frame: null,
        continue_from: i === 0 ? null : firstId(i - 1),
      })),
    },
  ];
  const lastFirstId = firstId(first.length - 1);
  ev.script.branches.forEach((shots, b) => {
    segments.push({
      name: `branch-${b}`,
      clips: shots.map((shot, j) => ({
        id: `b${b}-${j}`,
        prompt: clipPrompt(ev.channelId, shot.prompt),
        seconds: shot.seconds,
        starting_frame: null,
        continue_from: j === 0 ? lastFirstId : `b${b}-${j - 1}`,
      })),
    });
  });
  return segments;
}

/**
 * One permit per element of `REACTOR_SESSIONS`. Scoped to one `makeReactorRender` call rather than
 * true module scope (the whole process only ever makes one such call, so it behaves the same way in
 * production) so that separate test cases in the same file don't share waiters.
 */
function makeSemaphore(n: number) {
  let available = n;
  const queue: Array<() => void> = [];
  return {
    async acquire(): Promise<() => void> {
      if (available > 0) available--;
      else await new Promise<void>((resolve) => queue.push(resolve));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = queue.shift();
        if (next) next();
        else available++;
      };
    },
  };
}

/** A sidecar run that never reached `done`: a protocol `error`, an unexpected exit, or our own deadline. */
export class SidecarError extends Error {
  /** Seconds the sidecar had billed when this happened; null if `ready` never arrived (nothing billed). */
  constructor(
    message: string,
    public readonly billedS: number | null,
  ) {
    super(message);
    this.name = "SidecarError";
  }
}

type SidecarResult = {
  recording: string;
  billedS: number;
  fetchS: number;
  /** From the `done` line (ticket 24/27): how many download attempts the sidecar's retry took, and
   * how long the finished recording measures. Carried through only for logging; nothing here reads
   * them back, and an older sidecar that omits them just logs `undefined`. */
  fetchAttempts: number;
  recordingS: number | null;
  segments: Map<string, { start: number; end: number }>;
};

/** Line-buffered JSON-per-line protocol client over one child process's stdio. */
function runSidecar(
  cfg: {
    python: string;
    sidecar: string;
    log: (msg: string, extra?: Record<string, unknown>) => void;
    /** Fired the instant the `disconnected` line arrives, so the caller can free the session slot
     * before the download that follows (ticket 27) rather than holding it through `deliver()`. */
    onDisconnected?: (billedS: number) => void;
  },
  work: string,
  segments: PlanSegment[],
  deadlineMs: number,
): Promise<SidecarResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cfg.python, [cfg.sidecar], { stdio: ["pipe", "pipe", "pipe"] });
    let readyAt: number | null = null;
    // Set once the `disconnected` line arrives. From that instant the session is provably closed
    // and billing has stopped, so it is the number to true up a fetch failure from (ticket 24):
    // wall-clock-since-ready would otherwise include the whole retrying download.
    let disconnectedBilledS: number | null = null;
    let outcome: { ok: true; value: SidecarResult } | { ok: false; error: SidecarError | RenderFetchError } | null = null;
    let stderrTail = "";
    const segResults = new Map<string, { start: number; end: number }>();

    const withStderr = (message: string) => (stderrTail ? `${message} | sidecar stderr: ${stderrTail.slice(-2000)}` : message);

    /**
     * Settle only once the child is really gone. A live sidecar holds a real Reactor session
     * billing $0.007 a second, and the caller frees its session slot the moment this promise
     * settles, so handing back early lets a zombie bill outside the REACTOR_SESSIONS count and
     * push the account past its 5-session cap.
     */
    let delivered = false;
    function deliver() {
      if (delivered || !outcome) return;
      delivered = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      clearTimeout(reapTimer);
      if (outcome.ok) resolve(outcome.value);
      else reject(outcome.error);
    }

    let killTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;
    function stopChild() {
      try {
        child.kill("SIGTERM");
      } catch {
        // already gone
      }
      // SIGTERM is a request. A sidecar wedged inside the SDK's native FFI will not answer it.
      killTimer = setTimeout(() => void child.kill("SIGKILL"), SIGKILL_AFTER_MS);
      // And if even that leaves nothing to reap, stop waiting rather than stall the channel.
      reapTimer = setTimeout(deliver, SIGKILL_AFTER_MS + REAP_GRACE_MS);
      killTimer.unref?.();
      reapTimer.unref?.();
    }

    function fail(message: string, billedSOverride?: number) {
      if (outcome) return;
      const billedS = readyAt === null ? null : (billedSOverride ?? (Date.now() - readyAt) / 1000);
      outcome = { ok: false, error: new SidecarError(withStderr(message), billedS) };
      stopChild();
    }

    function succeed(v: SidecarResult) {
      if (outcome) return;
      outcome = { ok: true, value: v };
      // The sidecar exits on its own right after `done`; deliver when it does.
    }

    // Spec section 6: SIGTERM at 2x the estimate's seconds plus 120s of wall clock, treated as an error.
    const deadlineTimer = setTimeout(() => fail(`sidecar deadline of ${deadlineMs}ms exceeded, SIGTERM sent`), deadlineMs);

    child.on("error", (e) => fail(`failed to spawn sidecar: ${e.message}`));
    child.stderr.on("data", (c: Buffer) => {
      // otherwise a sidecar crash surfaces as a bare exit code with no clue why
      stderrTail = (stderrTail + c.toString()).slice(-4000);
    });

    let buf = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) handleLine(line);
      }
    });

    function handleLine(line: string) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return; // not a protocol line; the sidecar's own logs go to stderr, not stdout
      }
      switch (msg.event) {
        case "ready":
          readyAt = Date.now();
          return;
        case "segment":
          segResults.set(msg.name as string, { start: msg.start_t as number, end: msg.end_t as number });
          // The only record of where a segment sat in the session recording: the work directory is
          // swept after the cut, so without this line the `-c copy` boundary error (spec section 10)
          // cannot be measured after the fact.
          cfg.log("sidecar segment", { work, name: msg.name, start_t: msg.start_t, end_t: msg.end_t });
          return;
        case "disconnected":
          // The session is provably closed the instant this line arrives (disconnect stops
          // billing before the download starts), which is what makes it safe to free the caller's
          // session slot here and nowhere else: the long comment above `deliver` still holds for
          // every other exit path, where a live sidecar can still be running up a bill.
          disconnectedBilledS = msg.billed_s as number;
          cfg.onDisconnected?.(disconnectedBilledS);
          return;
        case "done":
          // `first_media_t` says when the first frame existed, in the same clock the `segment`
          // offsets use. The recording is media-backed, so if it starts at that frame rather than
          // at `ready`, every `-ss` cut is shifted by it. Logged so the next run can measure which.
          // `fetch_attempts`/`recording_s` are new fields (ticket 24); an older sidecar that omits
          // them just logs `undefined` here, same as any other missing protocol field.
          cfg.log("sidecar done", {
            work,
            billed_s: msg.billed_s,
            fetch_s: msg.fetch_s,
            first_media_t: msg.first_media_t,
            fetch_attempts: msg.fetch_attempts,
            recording_s: msg.recording_s,
          });
          succeed({
            recording: msg.recording as string,
            billedS: msg.billed_s as number,
            fetchS: msg.fetch_s as number,
            fetchAttempts: msg.fetch_attempts as number,
            recordingS: (msg.recording_s as number | null) ?? null,
            segments: segResults,
          });
          return;
        case "error": {
          const stage = msg.stage as string | undefined;
          const reason = msg.reason as string | undefined;
          if (stage === "fetch") {
            // The build finished and Reactor was fully paid for; only the download failed (ticket
            // 24: a reset connection burned a second $0.92 session and then couldn't afford it, so
            // politics aired nothing on 2026-09-12). A re-render cannot help, so this must surface
            // as something other than the SidecarError produce() retries.
            if (outcome) return;
            // Prefer the disconnected line's billed_s: it is exactly what Reactor charged, where
            // wall-clock-since-ready would include the whole retrying download and overstate it.
            const billedS = disconnectedBilledS ?? (readyAt === null ? 0 : (Date.now() - readyAt) / 1000);
            outcome = { ok: false, error: new RenderFetchError(withStderr(`sidecar error at stage fetch: ${reason}`), billedS) };
            stopChild();
            return;
          }
          // The real protocol never carries billed_s on a non-fetch error event (only `done` and
          // `disconnected` do). We check for it anyway as a defensive, forward-compatible fallback;
          // when absent we approximate with our own wall clock since `ready`, which is what the
          // sidecar's own billed_s measures.
          fail(`sidecar error at stage ${stage}: ${reason}`, msg.billed_s as number | undefined);
          return;
        }
        case "clip":
          // Nothing to act on, but a clip's own build time is otherwise invisible to the engine:
          // `billed_s` is the whole session, and this is the only per-clip number Reactor gives us.
          cfg.log("sidecar clip", { work, id: msg.id, state: msg.state, t: msg.t });
          return;
        default:
          return;
      }
    }

    child.on("exit", (code, signal) => {
      if (!outcome) fail(`sidecar exited unexpectedly (code ${code}, signal ${signal})`);
      deliver();
    });

    child.stdin.write(`${JSON.stringify({ cmd: "start", model: "reactor/fast-h3", work, ready_timeout_s: 60 })}\n`);
    child.stdin.write(`${JSON.stringify({ cmd: "plan", segments })}\n`);
    child.stdin.end();
  });
}

const round = (n: number) => Math.round(n * 100) / 100;

export function makeReactorRender(cfg: {
  /** Interpreter that runs the sidecar (REACTOR_PYTHON, default python3). */
  python: string;
  /** Absolute path to the sidecar script: reactor_sidecar.py or fake_reactor.py. */
  sidecar: string;
  /** REACTOR_SESSIONS: global concurrent-session ceiling. */
  sessions: number;
  workDir: string;
  store: MediaStore;
  budget: Budget;
  /** ponytail: ticket 14's boundary-error measurement on `-c copy` was never run (paid probe still
   * owed). Stream copy is the default; flip this once that measurement says it isn't accurate enough. */
  reencode?: boolean;
  /** Runs one ffmpeg invocation; injectable so tests can record commands instead of shelling out. */
  ffmpeg?: (args: string[]) => Promise<void>;
  /** Seconds-since-ready estimate -> ms before SIGTERM. Overridable so tests don't wait out the real formula. */
  deadlineMs?: (estimateSec: number) => number;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}): Render {
  const sem = makeSemaphore(cfg.sessions);
  const ffmpeg = cfg.ffmpeg ?? (async (args: string[]) => void (await run("ffmpeg", args)));
  // estimateUsd / USD_PER_SEC is exactly estimateSec, so this restates the spec formula in seconds.
  const deadlineMs = cfg.deadlineMs ?? ((estimateSec: number) => (2 * estimateSec + 120) * 1000);

  async function cut(sessionMp4: string, seg: { start: number; end: number }, out: string): Promise<void> {
    const codec = cfg.reencode ? ["-c:v", "libx264", "-preset", "veryfast"] : ["-c", "copy"];
    await ffmpeg(["-y", "-loglevel", "error", "-ss", String(seg.start), "-to", String(seg.end), "-i", sessionMp4, "-an", ...codec, out]);
  }

  return {
    async render(ev) {
      const firstHalfSec = ev.script.firstHalf.reduce((n, s) => n + s.seconds, 0);
      // The formula's "nOutcomes x secondHalfSec" is the total second-half seconds across every
      // branch; summing each branch's real shot list is that same quantity without assuming the
      // branches are exactly uniform, and it comes from ev.script rather than a timing constant.
      const secondHalfSec = ev.script.branches.reduce((n, shots) => n + shots.reduce((m, s) => m + s.seconds, 0), 0);
      const estimateSec = 9 + firstHalfSec + secondHalfSec + 3;
      const estimateUsd = estimateSec * USD_PER_SEC;

      cfg.budget.assertAffordable(estimateUsd, "reactor session");

      // Ticket 20: reserving the estimate and truing up after the session left the real ceiling
      // on a session's cost as the watchdog deadline, since nothing samples spend mid-session. A
      // stalled DEMO session rode a 234 s deadline to $1.58 against a $1.35 cap on 2026-09-12, and
      // it got worse under concurrency: on the four-channel REAL round the same day, each session
      // computed its bound from spent() as it stood at its own start, and another session's true-up
      // landed later and made that bound too generous by exactly the true-up's size. World.spendUsd
      // finished at $6.563 against a $6.50 cap. Reserving the worst case up front instead of the
      // estimate, and refunding the difference on true-up, commits the money before any session
      // starts, so a later true-up can no longer invalidate a bound another session already used.
      //
      // spent() here does not yet include this session (nothing has been charged for it yet), so
      // the cap can still afford exactly capUsd - spent() more. Unlike the superseded formula,
      // there is no "+ estimateUsd" term to add back: this session has not reserved anything yet
      // for that term to be undoing.
      const affordableSec = (cfg.budget.capUsd - cfg.budget.spent()) / USD_PER_SEC;
      const cappedMs = Math.max(1_000, Math.min(deadlineMs(estimateSec), Math.floor(affordableSec * 1000)));
      if (cappedMs < deadlineMs(estimateSec)) {
        cfg.log("session deadline bounded by budget", {
          channelId: ev.channelId,
          seq: ev.seq,
          deadlineMs: cappedMs,
          wouldHaveBeenMs: deadlineMs(estimateSec),
        });
      }
      // The worst case that bounded deadline permits, billed at the full USD_PER_SEC rate.
      // assertAffordable above already guarantees capUsd - spent() >= estimateUsd, so
      // affordableSec >= estimateSec, which is always far past the 1s floor above; the floor can
      // therefore never push reservedUsd past what assertAffordable already gated on, and no
      // separate refusal check is needed here.
      const reservedUsd = (cappedMs / 1000) * USD_PER_SEC;

      // No await between reading spent() (in affordableSec above) and this charge: charge()
      // updates `spent` synchronously before its own first await, and Node is single-threaded, so
      // a reservation computed and charged in one synchronous run cannot be interleaved by another
      // channel's session. That gap is exactly what let the four concurrent REAL sessions overshoot
      // the cap above. This looks like a removable line; it is the whole fix, so do not add one.
      await cfg.budget.charge(reservedUsd, "reactor session reserve");

      const waitStart = Date.now();
      const release = await sem.acquire();
      const acquiredAt = Date.now();
      const waitedMs = acquiredAt - waitStart;
      if (waitedMs > 1000) cfg.log("session slot wait", { channelId: ev.channelId, seq: ev.seq, waitedMs });

      // Ticket 27: freed the moment the sidecar's `disconnected` line arrives (see the comment in
      // runSidecar), instead of being held through the download that follows. The `finally` call
      // below stays as the backstop for a sidecar that never emits the line (the fake, an old
      // sidecar, a crash before disconnect); it is a no-op there since makeSemaphore's release
      // guards on `released`, but it still records when the slot was actually freed.
      let slotReleasedAt: number | null = null;
      function releaseSlot() {
        if (slotReleasedAt === null) slotReleasedAt = Date.now();
        release();
      }

      const dir = path.join(cfg.workDir, ev.id);
      try {
        await mkdir(dir, { recursive: true });

        let result: SidecarResult;
        try {
          result = await runSidecar(
            { python: cfg.python, sidecar: cfg.sidecar, log: cfg.log, onDisconnected: releaseSlot },
            dir,
            buildPlan(ev),
            cappedMs,
          );
        } catch (e) {
          // RenderFetchError also carries a real billedS (never null: the fetch stage is only
          // reached after `ready` and disconnect), so a fetch failure trues up the same way a
          // build failure does rather than refunding money Reactor actually charged.
          const billedS = e instanceof SidecarError ? e.billedS : e instanceof RenderFetchError ? e.billedS : null;
          // Trues up against what was actually reserved, not the estimate: under the new ordering
          // reservedUsd is usually well above the estimate, so a failure that billed little is
          // now usually a large refund rather than a small top-up.
          const trueUp = billedS === null ? -reservedUsd : billedS * USD_PER_SEC - reservedUsd;
          await cfg.budget.charge(trueUp, "reactor session true-up (error)");
          throw e;
        }

        // True up against what Reactor actually billed as soon as it's known, independent of
        // whether the local cut/store steps below succeed.
        const usd = result.billedS * USD_PER_SEC;
        await cfg.budget.charge(usd - reservedUsd, "reactor session true-up");

        const firstSeg = result.segments.get("first");
        if (!firstSeg) throw new Error("sidecar finished without a 'first' segment offset");
        const firstOut = path.join(dir, "first.mp4");
        await cut(result.recording, firstSeg, firstOut);
        const firstHalfUrl = await cfg.store.storeFile(ev.id, "first.mp4", firstOut);

        const branchUrls: string[] = [];
        for (let i = 0; i < ev.script.branches.length; i++) {
          const seg = result.segments.get(`branch-${i}`);
          if (!seg) throw new Error(`sidecar finished without a 'branch-${i}' segment offset`);
          const out = path.join(dir, `branch-${i}.mp4`);
          await cut(result.recording, seg, out);
          branchUrls.push(await cfg.store.storeFile(ev.id, branchFileName(i), out));
        }

        // slotReleasedAt is already set here whenever `disconnected` fired (well before this line,
        // since cut/store above only run after the whole download finished); Date.now() is a proxy
        // for the rare sidecar that never emits it, in which case the slot is about to be freed by
        // the `finally` below anyway. Ticket 27: this is the number that shows whether a slot wait
        // is attributable to a download, which `fetch_s` alone conflated.
        const slotHeldMs = (slotReleasedAt ?? Date.now()) - acquiredAt;
        cfg.log("rendered event", {
          channelId: ev.channelId,
          seq: ev.seq,
          billed_s: result.billedS,
          fetch_s: result.fetchS,
          fetch_attempts: result.fetchAttempts,
          recording_s: result.recordingS,
          slotHeldMs,
          usd: round(usd),
          estimateUsd: round(estimateUsd),
        });
        return { firstHalfUrl, branchUrls, costUsd: usd };
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        releaseSlot();
      }
    },
  };
}
