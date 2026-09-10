import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Signal 0 is an existence check. EPERM means it exists and is not ours, which still counts. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Refuse to start next to a live engine, and leave our pid behind so the next start can name it.
 *
 * `pnpm --filter engine start` is three processes deep (pnpm → tsx → node); SIGKILL on the outer two
 * reparents the node grandchild to PID 1, where it keeps authoring, rendering, creating events on
 * chain and charging the OpenRouter key. Its only symptom was EADDRINUSE on the media port — and
 * with `MEDIA_STORE=blob` there is no media server, so there was no symptom at all.
 *
 * ponytail: pid reuse could name an innocent process; the file is rewritten on every clean start,
 * so the window is a restart wide. Swap in an flock if that ever bites.
 */
export function claimPidFile(file: string): () => void {
  mkdirSync(path.dirname(file), { recursive: true });
  const prev = Number(existsSync(file) ? readFileSync(file, "utf8").trim() : 0);
  if (prev && prev !== process.pid && alive(prev)) {
    throw new Error(`engine already running as pid ${prev} — stop it with \`kill ${prev}\` or \`pkill -f 'src/index.ts'\``);
  }
  writeFileSync(file, `${process.pid}\n`);
  return () => {
    try {
      if (Number(readFileSync(file, "utf8").trim()) === process.pid) unlinkSync(file);
    } catch {}
  };
}
