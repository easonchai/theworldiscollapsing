/**
 * Ticket 25 build-rate reader. For every Reactor session in an engine log, reports how long Reactor
 * took to build the media, how much media that produced, the resulting build rate, and how many
 * other sessions were building alongside it.
 *
 *   pnpm --filter engine exec tsx scripts/build-rate.ts <engine.log>
 *
 * Reads nothing but the log, so it is free and safe to re-run long after the money was spent.
 * `collect-run.ts` is the sibling that also touches the database and the stored files.
 *
 * Concurrency is measured rather than assumed. Authoring latency varied from 44 s to 119 s across
 * the 2026-09-12 rounds, so N channels started together do not give N overlapping builds, and
 * labelling a session by how many channels the engine was running would have overstated it.
 */
import { readFile } from "node:fs/promises";

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: build-rate.ts <engine.log>");
  process.exit(1);
}

type Session = {
  work: string;
  channelId?: string;
  seq?: number;
  clips: number;
  /** Seconds since `ready` at which the last clip finished generating: the build clock. */
  lastGenT: number;
  /** Wall time of that same mark, used to overlap this build against its peers'. */
  lastGenAt: number;
  readyAt?: number;
  /** Sum of the segment spans, the fallback when `sidecar done` carries no `recording_s`. */
  segS: number;
  billedS?: number;
  recordingS?: number;
  fetchS?: number;
};

const sessions = new Map<string, Session>();
const of = (work: string): Session => {
  let s = sessions.get(work);
  if (!s) sessions.set(work, (s = { work, clips: 0, lastGenT: 0, lastGenAt: 0, segS: 0 }));
  return s;
};

/**
 * `rendered event` names the channel and seq but not the work directory, and `sidecar done` names
 * the directory but not the channel. They are adjacent for one session, so the done line parks the
 * session here for the render line that follows it to label.
 */
let awaitingLabel: Session | null = null;

for (const line of (await readFile(logPath, "utf8")).split("\n")) {
  const brace = line.indexOf("{");
  const space = line.indexOf(" ");
  if (brace < 0 || space < 0) continue;
  const at = Date.parse(line.slice(0, space));
  if (!Number.isFinite(at)) continue;
  const msg = line.slice(space + 1, brace).trim();
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line.slice(brace));
  } catch {
    continue;
  }
  const work = typeof j.work === "string" ? j.work.split("/").pop()! : null;

  if (msg === "sidecar clip" && work && j.state === "generated") {
    const s = of(work);
    const t = Number(j.t);
    s.clips++;
    if (t >= s.lastGenT) {
      s.lastGenT = t;
      s.lastGenAt = at;
    }
    // `t` is seconds since the session went ready, so one clip mark fixes the ready instant.
    s.readyAt ??= at - t * 1000;
  } else if (msg === "sidecar segment" && work) {
    of(work).segS += Number(j.end_t) - Number(j.start_t);
  } else if (msg === "sidecar done" && work) {
    const s = of(work);
    s.billedS = Number(j.billed_s);
    s.recordingS = j.recording_s === null ? undefined : Number(j.recording_s);
    s.fetchS = Number(j.fetch_s);
    awaitingLabel = s;
  } else if (msg === "rendered event" && awaitingLabel) {
    awaitingLabel.channelId = String(j.channelId);
    awaitingLabel.seq = Number(j.seq);
    awaitingLabel = null;
  }
}

/** Only sessions that both reached `ready` and reported `done` have a build window to measure. */
const done = [...sessions.values()]
  .filter((s): s is Session & { readyAt: number; billedS: number } => s.readyAt !== undefined && s.billedS !== undefined)
  .map((s) => ({ ...s, buildStart: s.readyAt, buildEnd: s.lastGenAt }));

const overlapMs = (a: (typeof done)[number], b: (typeof done)[number]): number =>
  Math.max(0, Math.min(a.buildEnd, b.buildEnd) - Math.max(a.buildStart, b.buildStart));

const r2 = (n: number) => Math.round(n * 100) / 100;

const rows = done.map((s) => {
  const spanMs = s.buildEnd - s.buildStart;
  const peers = done.filter((o) => o !== s);
  // Overlap-weighted average number of peers building during this build: 2.6 means this session
  // spent most of its build with three others in flight.
  const meanPeers = spanMs > 0 ? peers.reduce((n, o) => n + overlapMs(s, o), 0) / spanMs : 0;
  let peakPeers = 0;
  for (let t = s.buildStart; t <= s.buildEnd; t += 1000) {
    peakPeers = Math.max(peakPeers, peers.filter((o) => t >= o.buildStart && t <= o.buildEnd).length);
  }
  // Against media actually recorded, not the seconds the author asked for: the 6 s shot floor
  // stretches a 120 s plan to ~131 s, so the authored figure overstates the rate by ~10%.
  const mediaS = s.recordingS ?? s.segS;
  return {
    session: `${s.channelId ?? "?"}:${s.seq ?? "?"}`,
    clips: s.clips,
    build_s: r2(s.lastGenT),
    media_s: r2(mediaS),
    build_rate: mediaS > 0 ? r2(s.lastGenT / mediaS) : null,
    billed_s: s.billedS,
    fetch_s: s.fetchS ?? null,
    mean_peers: r2(meanPeers),
    peak_peers: peakPeers,
  };
});

rows.sort((a, b) => a.session.localeCompare(b.session));
console.log(JSON.stringify(rows, null, 2));
