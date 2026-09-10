import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimPidFile } from "./pidfile.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "twic-pid-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A pid that has certainly exited: spawnSync reaps the child before it returns. */
const deadPid = () => spawnSync(process.execPath, ["-e", ""]).pid!;

describe("claimPidFile", () => {
  it("creates the directory and records our pid", () => {
    const file = path.join(dir, "nested", "engine.pid");
    const release = claimPidFile(file);
    expect(Number(readFileSync(file, "utf8").trim())).toBe(process.pid);
    release();
    expect(existsSync(file)).toBe(false);
  });

  // The whole point: a SIGKILLed `pnpm`/`tsx` wrapper leaves the node grandchild running, and the
  // next start must say so instead of racing it onto the chain and the spend counter.
  it("refuses to start next to a live pid and names it", () => {
    const file = path.join(dir, "live.pid");
    writeFileSync(file, `${process.ppid}\n`); // a live process that is not us
    expect(() => claimPidFile(file)).toThrow(new RegExp(`engine already running as pid ${process.ppid}`));
    expect(Number(readFileSync(file, "utf8").trim())).toBe(process.ppid); // never clobbers the live claim
  });

  it("re-claims a file that already holds our own pid", () => {
    const file = path.join(dir, "self.pid");
    writeFileSync(file, `${process.pid}\n`);
    claimPidFile(file)();
    expect(existsSync(file)).toBe(false);
  });

  it("takes over a pid file left by a process that is gone", () => {
    const file = path.join(dir, "stale.pid");
    writeFileSync(file, `${deadPid()}\n`);
    const release = claimPidFile(file);
    expect(Number(readFileSync(file, "utf8").trim())).toBe(process.pid);
    release();
  });

  it("release leaves someone else's pid file alone", () => {
    const file = path.join(dir, "handover.pid");
    const release = claimPidFile(file);
    writeFileSync(file, `${process.ppid}\n`); // a successor claimed it after us
    release();
    expect(Number(readFileSync(file, "utf8").trim())).toBe(process.ppid);
  });
});
