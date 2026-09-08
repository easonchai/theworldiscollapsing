import { describe, expect } from "bun:test";
import type { EVMLog, TeeRuntime } from "@chainlink/cre-sdk";
import { test } from "@chainlink/cre-sdk/test";
import { encodeAbiParameters, encodeEventTopics, hexToBytes, parseAbiParameters, type Hex } from "viem";
import { arenaAbi } from "../contracts/abi/Arena";
import { branchKey, initWorkflow, onResolved, RESOLVED_TOPIC, type Config } from "./workflow";

const ARENA = "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0";
const EVENT_ID = `0x${"ab".repeat(32)}` as Hex;
const ROOT = `0x${"07".repeat(32)}` as Hex;
const SECRET = "s3cret";
const OUTCOME = 1;

const config = (): Config => ({
  chainSelectorName: "anvil-devnet",
  arenaAddress: ARENA,
  revealUrl: "http://127.0.0.1:4002/internal/reveal-key",
});

const resolvedLog = (): EVMLog =>
  ({
    address: hexToBytes(ARENA as Hex),
    topics: encodeEventTopics({ abi: arenaAbi, eventName: "Resolved", args: { eventId: EVENT_ID } }).map((t) =>
      hexToBytes(t as Hex),
    ),
    data: hexToBytes(
      encodeAbiParameters(parseAbiParameters("uint8 outcome, bytes signature"), [OUTCOME, "0xbeef"]),
    ),
  }) as unknown as EVMLog;

/** The `events(bytes32)` return tuple, ABI-encoded the way callContract hands it back. */
const eventsReturn = (resolved: boolean, outcome: number) =>
  hexToBytes(
    encodeAbiParameters(
      parseAbiParameters("uint8 n, uint64 lock, uint64 round, bool resolved, uint8 outcome, bytes sig"),
      [2, 0n, 0n, resolved, outcome, "0x"],
    ),
  );

/**
 * The public test surface has no TEE runtime factory (`newTestRuntime` returns a DON `Runtime`),
 * so stand up the slice of `TeeRuntime` this handler actually uses — the same approach the
 * `hello-confidential-workflows-ts` template takes.
 */
const fakeTeeRuntime = (opts: { resolved?: boolean; outcome?: number; statusCode?: number } = {}) => {
  const sent: { url: string; headers: string[]; body: string }[] = [];
  const logs: string[] = [];
  let donCalls = 0;

  const runtime = {
    config: config(),
    getSecrets: (reqs: { id: string }[]) => ({
      result: () =>
        Object.fromEntries(
          reqs.map((r) => [r.id, { id: r.id, value: r.id === "BRANCH_SEAL_ROOT" ? ROOT : SECRET }]),
        ),
    }),
    // HTTPClient.sendRequest(teeRuntime, …) goes through callCapability on the runtime.
    callCapability: ({ payload }: { payload: Record<string, any> }) => {
      sent.push({
        url: payload.url,
        headers: (payload.multiHeaders?.Authorization?.values ?? []) as string[],
        body: payload.body as string,
      });
      return { result: () => ({ statusCode: opts.statusCode ?? 200, body: new Uint8Array() }) };
    },
    log: (m: string) => logs.push(m),
    usingTheDons: () => ({
      // The EVM read crosses out of the enclave onto the DON.
      callCapability: () => {
        donCalls++;
        return { result: () => ({ data: eventsReturn(opts.resolved ?? true, opts.outcome ?? OUTCOME) }) };
      },
    }),
  };
  return { runtime: runtime as unknown as TeeRuntime<Config>, sent, logs, donCalls: () => donCalls };
};

describe("onResolved", () => {
  test("releases exactly the winning branch key, derived from the enclave-only root", () => {
    const { runtime, sent, donCalls } = fakeTeeRuntime();

    expect(onResolved(runtime, resolvedLog())).toContain(EVENT_ID);
    expect(donCalls()).toBe(1); // it really read the chain

    expect(sent).toHaveLength(1);
    expect(sent[0].headers).toEqual([`Bearer ${SECRET}`]);
    const body = JSON.parse(new TextDecoder().decode(hexToBytes(`0x${Buffer.from(sent[0].body, "base64").toString("hex")}` as Hex)));
    expect(body).toEqual({ eventId: EVENT_ID, outcome: OUTCOME, key: branchKey(ROOT, EVENT_ID, OUTCOME) });
    // the losing branch's key is a different value and was never sent
    expect(body.key).not.toBe(branchKey(ROOT, EVENT_ID, 0));
  });

  test("takes the outcome from chain state, not from the log", () => {
    const { runtime, sent } = fakeTeeRuntime({ outcome: 0 });
    onResolved(runtime, resolvedLog()); // the log says outcome 1

    const body = JSON.parse(Buffer.from(sent[0].body, "base64").toString("utf8"));
    expect(body.outcome).toBe(0);
    expect(body.key).toBe(branchKey(ROOT, EVENT_ID, 0));
  });

  test("refuses to release anything when the chain says the event is unresolved", () => {
    const { runtime, sent } = fakeTeeRuntime({ resolved: false });
    expect(() => onResolved(runtime, resolvedLog())).toThrow(/not resolved/);
    expect(sent).toHaveLength(0);
  });

  test("throws when the engine rejects the release", () => {
    const { runtime } = fakeTeeRuntime({ statusCode: 401 });
    expect(() => onResolved(runtime, resolvedLog())).toThrow(/status 401/);
  });

  test("never logs the root or the released key", () => {
    const { runtime, logs } = fakeTeeRuntime();
    onResolved(runtime, resolvedLog());
    for (const line of logs) {
      expect(line).not.toContain(ROOT);
      expect(line).not.toContain(branchKey(ROOT, EVENT_ID, OUTCOME));
    }
  });
});

describe("branchKey", () => {
  // The whole scheme dies silently if these two implementations ever drift, so both sides assert
  // the same vectors: apps/engine/src/seal.test.ts holds the identical two constants.
  test("matches the engine's key schedule byte for byte", () => {
    expect(branchKey(ROOT, EVENT_ID, 0)).toBe("0x8f5ca72428d63b4a71ac46b28dde4c8279f099bc193db966f03ec0be900fb3cb");
    expect(branchKey(ROOT, EVENT_ID, 1)).toBe("0xc8d0be9d9fc04bf205029f2be501360f4aae319f53868c641358ce7e8b9129f1");
  });
});

describe("initWorkflow", () => {
  test("registers one TEE handler on the Arena Resolved topic", () => {
    const handlers = initWorkflow(config());
    expect(handlers).toHaveLength(1);
    expect(handlers[0].fn).toBe(onResolved);
    // handlerInTee attaches TEE requirements; cre.handler does not.
    expect((handlers[0] as { requirements?: unknown }).requirements).toBeDefined();
    expect(RESOLVED_TOPIC).toBe(
      encodeEventTopics({ abi: arenaAbi, eventName: "Resolved" })[0] as Hex,
    );
  });
});
