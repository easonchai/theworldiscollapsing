/**
 * Ticket 18 measurement collector. Reads one paid round's engine log plus the database, copies the
 * round's finished video flat into `.scratch/video-vendor/clips/`, and appends the `runs.csv` and
 * `sessions.csv` rows that ticket asks for.
 *
 *   pnpm --filter engine exec tsx scripts/collect-run.ts <round> <engine.log> <since-iso> [--dry]
 *
 * Nothing here talks to a vendor: every number comes from the log the run already wrote, from the
 * database rows the run already stored, or from ffprobe on the files it already produced. So it is
 * safe to re-run, and safe to run long after the money was spent.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, stat, appendFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { makePrisma } from "db";
import type { Authored, Shot } from "../src/authored.js";
import { clipPrompt } from "../src/render.js";

const run = promisify(execFile);

/** Reactor fast-h3, the same constant `reactor.ts` bills against. */
const USD_PER_SEC = 0.007;
const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const CLIPS = path.join(REPO, ".scratch", "video-vendor", "clips");
const MEDIA = path.resolve(import.meta.dirname, "..", "media");

const [round, logPath, sinceIso, ...rest] = process.argv.slice(2);
if (!round || !logPath || !sinceIso) {
  console.error("usage: collect-run.ts <round> <engine.log> <since-iso> [--dry]");
  process.exit(1);
}
const dry = rest.includes("--dry");

type ClipEvent = { id: string; state: string; t: number };
type Seg = { start: number; end: number };

/** Per-event facts recovered from the log, keyed by event id (the sidecar work directory's name). */
type LogEvent = {
  clips: ClipEvent[];
  segments: Map<string, Seg>;
};
/** Per-production facts the log reports by channel and seq rather than by event id. */
type LogRender = { billedS: number; fetchS: number; usd: number; estimateUsd: number; at: number };

const logEvents = new Map<string, LogEvent>();
const renders = new Map<string, LogRender>();
const slotWaits = new Map<string, number>();
const authoredAt = new Map<string, number>();
const onChainAt = new Map<string, number>();
const spendLines: Array<{ what: string; usd: number; totalUsd: number }> = [];

const since = Date.parse(sinceIso);
const ofEvent = (id: string): LogEvent => {
  let e = logEvents.get(id);
  if (!e) logEvents.set(id, (e = { clips: [], segments: new Map() }));
  return e;
};

for (const line of (await readFile(logPath, "utf8")).split("\n")) {
  const brace = line.indexOf("{");
  if (brace < 0) continue;
  const space = line.indexOf(" ");
  const at = Date.parse(line.slice(0, space));
  if (!Number.isFinite(at) || at < since) continue;
  const msg = line.slice(space + 1, brace).trim();
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line.slice(brace));
  } catch {
    continue;
  }
  const key = `${j.channelId}:${j.seq}`;
  switch (msg) {
    case "sidecar clip":
      ofEvent(path.basename(String(j.work))).clips.push({ id: String(j.id), state: String(j.state), t: Number(j.t) });
      break;
    case "sidecar segment":
      ofEvent(path.basename(String(j.work))).segments.set(String(j.name), { start: Number(j.start_t), end: Number(j.end_t) });
      break;
    case "rendered event":
      renders.set(key, {
        billedS: Number(j.billed_s),
        fetchS: Number(j.fetch_s),
        usd: Number(j.usd),
        estimateUsd: Number(j.estimateUsd),
        at,
      });
      break;
    case "session slot wait":
      slotWaits.set(key, Number(j.waitedMs));
      break;
    case "authored":
      authoredAt.set(key, at);
      break;
    case "on-chain":
      onChainAt.set(key, at);
      break;
    case "spend":
      spendLines.push({ what: String(j.what), usd: Number(j.usd), totalUsd: Number(j.totalUsd) });
      break;
  }
}

const prisma = makePrisma(process.env.DATABASE_URL ?? "");
const rows = await prisma.event.findMany({ where: { createdAt: { gte: new Date(since) } }, orderBy: [{ channelId: "asc" }, { seq: "asc" }] });
const world = await prisma.world.findUnique({ where: { id: 1 } });

const probeDuration = async (file: string): Promise<number> => {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return Number(stdout.trim());
};
const q = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

const runRows: string[] = [];
const sessionRows: string[] = [];
const cutErrors: Array<{ file: string; requested: number; actual: number; error: number }> = [];
const report: Array<Record<string, unknown>> = [];

await mkdir(CLIPS, { recursive: true });

for (const row of rows) {
  const key = `${row.channelId}:${row.seq}`;
  const le = logEvents.get(row.id);
  const rd = renders.get(key);
  const script = row.script as Authored;
  if (!le || !rd) {
    report.push({ channel: row.channelId, seq: row.seq, state: row.state, note: "no completed render in this log window", error: row.error });
    continue;
  }

  // Plan ids, exactly as `reactor.ts`'s buildPlan numbers them, so the log's clip ids line up.
  const planned: Array<{ id: string; segment: string; shot: Shot; continueFrom: string | null }> = [];
  script.firstHalf.forEach((shot, i) => planned.push({ id: `f${i}`, segment: "first", shot, continueFrom: i === 0 ? null : `f${i - 1}` }));
  const lastFirst = `f${script.firstHalf.length - 1}`;
  script.branches.forEach((shots, b) =>
    shots.forEach((shot, j) => planned.push({ id: `b${b}-${j}`, segment: `branch-${b}`, shot, continueFrom: j === 0 ? lastFirst : `b${b}-${j - 1}` })),
  );

  // Segment name -> the flat file this round publishes it as.
  const urls = (row.branchUrls as string[] | null) ?? [];
  const sources = new Map<string, string>([["first", path.join(MEDIA, row.id, "first.mp4")]]);
  urls.forEach((u, b) => sources.set(`branch-${b}`, path.join(MEDIA, row.id, path.basename(new URL(u).pathname))));

  let bytes = 0;
  const published = new Map<string, string>();
  for (const [segment, src] of sources) {
    const name = `${round}-${row.channelId}-${segment}.mp4`;
    const dest = path.join(CLIPS, name);
    try {
      bytes += (await stat(src)).size;
    } catch {
      report.push({ channel: row.channelId, seq: row.seq, segment, note: "stored file missing", src });
      continue;
    }
    if (!dry) await copyFile(src, dest);
    published.set(segment, name);
    const seg = le.segments.get(segment);
    if (seg) {
      const actual = await probeDuration(src);
      cutErrors.push({ file: name, requested: r2(seg.end - seg.start), actual: r2(actual), error: r2(actual - (seg.end - seg.start)) });
    }
  }

  const tOf = (id: string, state: string) => le.clips.find((c) => c.id === id && c.state === state)?.t ?? null;
  let prevGenerated = 0;
  for (const p of planned) {
    const generated = tOf(p.id, "generated");
    const started = tOf(p.id, "started");
    const finished = tOf(p.id, "finished");
    // build_s: how long Reactor took to build this clip, as the gap between consecutive `generated`
    // marks. That ratio against the clip's own seconds is spec section 10's "chained build slower
    // than 1.0x" check. Falls back to blank when the sidecar never reported `generated`.
    const buildS = generated === null ? "" : r2(generated - prevGenerated);
    if (generated !== null) prevGenerated = generated;
    // billed_s: the clip's own share of the session's billed seconds.
    const billedS = started !== null && finished !== null ? r2(finished - started) : "";
    runRows.push(
      [
        "fast-h3",
        "engine",
        row.channelId,
        q(clipPrompt(row.channelId, p.shot.prompt)),
        "",
        buildS,
        billedS,
        billedS === "" ? "" : r4(Number(billedS) * USD_PER_SEC),
        rd.fetchS,
        published.get(p.segment) ?? "",
      ].join(","),
    );
  }

  const lastClip = planned[planned.length - 1]!.id;
  const waitedMs = slotWaits.get(key) ?? 0;
  const cutForThis = cutErrors.filter((c) => c.file.startsWith(`${round}-${row.channelId}-`));
  const worstCut = cutForThis.reduce((m, c) => Math.max(m, Math.abs(c.error)), 0);
  const note = `slot_wait_ms=${waitedMs}; estimate=$${rd.estimateUsd}; worst_cut_err_s=${r2(worstCut)}; outcome=${row.outcome}`;
  sessionRows.push(
    [
      `${round}-${row.channelId}`,
      planned.length,
      rd.billedS,
      r4(rd.billedS * USD_PER_SEC),
      tOf(lastClip, "generated") ?? "",
      tOf(lastClip, "finished") ?? "",
      "True",
      "",
      rd.fetchS,
      bytes,
      q(note),
      published.get("first") ?? "",
    ].join(","),
  );

  const authored = authoredAt.get(key);
  const onChain = onChainAt.get(key);
  report.push({
    channel: row.channelId,
    seq: row.seq,
    state: row.state,
    billed_s: rd.billedS,
    fetch_s: rd.fetchS,
    usd: rd.usd,
    estimate_usd: rd.estimateUsd,
    slot_wait_ms: waitedMs,
    clips: planned.length,
    production_s: authored ? r2((rd.at - authored) / 1000) : null,
    author_to_onchain_s: authored && onChain ? r2((onChain - authored) / 1000) : null,
    cost_usd_row: row.costUsd,
    worst_cut_err_s: r2(worstCut),
  });
}

// On-air gap: the wall goes dark from the moment one event's second half ends until the next
// event's first half starts. Only measurable where a channel aired two events in a row.
const secondHalfMs = Number(process.env.SECOND_HALF_MS ?? (process.env.DEMO_MODE === "1" ? 10_000 : 30_000));
const gaps: Array<{ channel: string; from: number; to: number; gap_s: number }> = [];
const byChannel = new Map<string, typeof rows>();
for (const row of rows) byChannel.set(row.channelId, [...(byChannel.get(row.channelId) ?? []), row]);
for (const [channel, list] of byChannel) {
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]!;
    const next = list[i]!;
    if (!prev.revealTime || !next.startTime) continue;
    gaps.push({
      channel,
      from: prev.seq,
      to: next.seq,
      gap_s: r2((next.startTime.getTime() - (prev.revealTime.getTime() + secondHalfMs)) / 1000),
    });
  }
}

if (!dry) {
  if (runRows.length) await appendFile(path.join(CLIPS, "runs.csv"), `${runRows.join("\n")}\n`);
  if (sessionRows.length) await appendFile(path.join(CLIPS, "sessions.csv"), `${sessionRows.join("\n")}\n`);
}

console.log(
  JSON.stringify(
    {
      round,
      dry,
      events: report,
      cut_errors: cutErrors,
      on_air_gaps: gaps,
      spend_total_from_log: spendLines.length ? spendLines[spendLines.length - 1]!.totalUsd : null,
      world_spend_usd: world?.spendUsd ?? null,
      rows_appended: { runs: runRows.length, sessions: sessionRows.length },
    },
    null,
    2,
  ),
);

await prisma.$disconnect();
