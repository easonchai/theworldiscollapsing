import {
  bytesToHex,
  cre,
  encodeCallMsg,
  getNetwork,
  hexToBase64,
  LATEST_BLOCK_NUMBER,
  ok,
  type EVMLog,
  type TeeRuntime,
} from "@chainlink/cre-sdk";
import {
  concat,
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  stringToHex,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import { arenaAbi } from "../contracts/abi/Arena";

export const configSchema = z.object({
  chainSelectorName: z.string(),
  arenaAddress: z.string(),
  /** The engine's `POST /internal/reveal-key` endpoint. */
  revealUrl: z.string(),
});
export type Config = z.infer<typeof configSchema>;

/** Vault DON secret ids. `../secrets.yaml` maps them to env vars when simulating. */
export const SEAL_ROOT = "BRANCH_SEAL_ROOT";
export const REVEAL_SECRET = "REVEAL_SECRET";

/** topics[0] of the log we subscribe to. */
export const RESOLVED_TOPIC: Hex = keccak256(stringToHex("Resolved(bytes32,uint8,bytes)"));

/**
 * Must stay byte-identical to `branchKey` in `apps/engine/src/seal.ts`:
 *
 *     key_i = keccak256(root ‖ eventId ‖ uint8(i))
 *
 * The engine seals branch i under this key. The root is only ever decrypted inside the enclave, so
 * the enclave is the only place any branch key can be computed — and it computes exactly one.
 */
export const branchKey = (root: Hex, eventId: Hex, index: number): Hex =>
  keccak256(concat([root, eventId, toHex(index, { size: 1 })]));

/**
 * Runs inside the enclave. The trigger and the chain read still execute on Workflow DON nodes (CRE
 * never runs those in a TEE); the secret, the derived key and the outbound release stay inside.
 */
export const onResolved = (runtime: TeeRuntime<Config>, log: EVMLog): string => {
  const config = runtime.config;

  // 1. Which event resolved? Decoded from the log the trigger delivered.
  const decoded = decodeEventLog({
    abi: arenaAbi,
    eventName: "Resolved",
    data: bytesToHex(log.data),
    topics: log.topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
  });
  const eventId = decoded.args.eventId;

  // 2. Take the outcome from chain state rather than the log payload alone. Chain reads always run
  //    on Workflow DON nodes, so cross out first — nothing confidential has been touched yet.
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const call = evmClient
    .callContract(runtime.usingTheDons(), {
      call: encodeCallMsg({
        from: zeroAddress,
        to: config.arenaAddress as Address,
        data: encodeFunctionData({ abi: arenaAbi, functionName: "events", args: [eventId] }),
      }),
      blockNumber: LATEST_BLOCK_NUMBER,
    })
    .result();
  const [, , , resolved, outcome] = decodeFunctionResult({
    abi: arenaAbi,
    functionName: "events",
    data: bytesToHex(call.data),
  });
  if (!resolved) throw new Error(`Arena says ${eventId} is not resolved`);

  // 3. The confidential part. The Vault DON releases the root into the enclave; the keys for the
  //    losing branches are never computed, let alone sent anywhere.
  const secrets = runtime.getSecrets([{ id: SEAL_ROOT }, { id: REVEAL_SECRET }]).result();
  const key = branchKey(secrets[SEAL_ROOT].value as Hex, eventId, outcome);

  // 4. Release the winning key to the engine, from inside the enclave.
  const response = new cre.capabilities.HTTPClient()
    .sendRequest(runtime, {
      url: config.revealUrl,
      method: "POST",
      multiHeaders: {
        Authorization: { values: [`Bearer ${secrets[REVEAL_SECRET].value}`] },
        "Content-Type": { values: ["application/json"] },
      },
      // hexToBase64(stringToHex(...)) rather than Buffer: QuickJS has no node:buffer.
      body: hexToBase64(stringToHex(JSON.stringify({ eventId, outcome, key }))),
    })
    .result();
  if (!ok(response)) throw new Error(`reveal-key rejected the release: status ${response.statusCode}`);

  // Never log the key or the root. The outcome itself is public the moment Resolved is emitted.
  runtime.log(`released branch key for outcome ${outcome}`);
  return `released ${eventId} outcome ${outcome}`;
};

export function initWorkflow(config: Config) {
  const network = getNetwork({ chainFamily: "evm", chainSelectorName: config.chainSelectorName, isTestnet: true });
  if (!network) throw new Error(`Network not found: ${config.chainSelectorName}`);
  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);

  return [
    // `{}` accepts any registered TEE in any region; AWS Nitro / us-west-2 is currently the only one.
    cre.handlerInTee(
      evmClient.logTrigger({
        addresses: [hexToBase64(config.arenaAddress as Hex)],
        topics: [{ values: [hexToBase64(RESOLVED_TOPIC)] }],
        // The reveal is the moment the audience is waiting for; don't wait for a safe/finalized tag.
        confidence: "CONFIDENCE_LEVEL_LATEST",
      }),
      onResolved,
      {},
    ),
  ];
}
