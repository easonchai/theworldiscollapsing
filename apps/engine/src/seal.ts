import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { concat, hexToBytes, keccak256, toHex, type Hex } from "viem";
import type { MediaStore } from "./media.js";

/**
 * Branch sealing (`BRANCH_SEAL=1`). Every second-half branch is stored as AES-256-GCM ciphertext,
 * so `Event.branchUrls` point at files that are noise until the winning key is released.
 *
 * Key schedule — the key for branch `i` of event `id` is
 *
 *     key_i = keccak256(root ‖ eventId ‖ uint8(i))
 *
 * where `root` is 32 secret bytes that live in the engine's `BRANCH_SEAL_ROOT` env var and, on the
 * Chainlink CRE side, in the Vault DON secret of the same name. keccak256 is a sponge, so a secret
 * prefix is a sound PRF (no length-extension), the three fields are fixed-width so the encoding is
 * unambiguous, and releasing `key_outcome` says nothing about `key_j` for `j != outcome`.
 *
 * ponytail: derived, not a random key per branch shipped inside an encrypted record. The CRE
 * workflow runs in QuickJS (no `node:crypto`, no WebCrypto) and viem — whose `keccak256` this is —
 * is the only crypto library already on that path. Upgrade path if a cipher ever lands in the
 * workflow runtime: keep this file, add an X25519+AES-GCM envelope so the engine can forget `root`.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/** Everything on this path is 0x-hex, so the CRE workflow needs no base64 helpers in QuickJS. */
export function parseRoot(hex: string): Hex {
  if (!BYTES32.test(hex)) throw new Error("BRANCH_SEAL_ROOT must be 32 bytes as 0x-prefixed hex");
  return hex as Hex;
}

export function branchKey(root: Hex, eventId: Hex, index: number): Hex {
  if (!BYTES32.test(eventId)) throw new Error(`eventId must be 32 bytes of hex, got ${eventId}`);
  return keccak256(concat([root, eventId, toHex(index, { size: 1 })]));
}

/** iv(12) ‖ ciphertext ‖ tag(16) */
export function seal(plain: Buffer, key: Hex): Buffer {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", hexToBytes(key), iv);
  return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
}

export function unseal(sealed: Buffer, key: Hex): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) throw new Error("sealed file is too short");
  const d = createDecipheriv("aes-256-gcm", hexToBytes(key), sealed.subarray(0, IV_BYTES));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([d.update(sealed.subarray(IV_BYTES, sealed.length - TAG_BYTES)), d.final()]);
}

/** `branch-<i>-<32 hex>.mp4` as published by `branchFileName`; the plain form is still accepted. */
const BRANCH = /^branch-(\d+)(?:-[0-9a-f]{32})?\.mp4$/;

/**
 * Wraps a media store so `branch-<i>.mp4` is sealed on the way out and published as
 * `branch-<i>.mp4.enc`; the plaintext is deleted. Everything else (first.mp4, stills) is untouched.
 * Wrapping the store rather than the renderer covers the real renderer and the ffmpeg stub in one
 * place. ponytail: whole file in memory — branches are seconds long; stream if that ever changes.
 */
export function sealingStore(inner: MediaStore, root: Hex): MediaStore {
  return {
    async storeFile(eventId, name, localPath) {
      const m = BRANCH.exec(name);
      if (!m) return inner.storeFile(eventId, name, localPath);
      const enc = `${localPath}.enc`;
      await writeFile(enc, seal(await readFile(localPath), branchKey(root, eventId as Hex, Number(m[1]))));
      await rm(localPath, { force: true });
      return inner.storeFile(eventId, `${name}.enc`, enc);
    },
  };
}

/**
 * Decrypts one sealed branch in place under `dir/<eventId>/`, next to its ciphertext, and returns
 * the plaintext path. Called by the engine's `/internal/reveal-key` endpoint once the CRE workflow
 * has released the winning key.
 */
export async function revealBranch(dir: string, eventId: string, name: string, key: string): Promise<string> {
  // eventId and name come off the wire and become a path, so validate before joining.
  if (!BYTES32.test(eventId)) throw new Error("eventId must be 32 bytes as 0x-prefixed hex");
  if (!BRANCH.test(name)) throw new Error(`not a branch file: ${name}`);
  if (!BYTES32.test(key)) throw new Error("branch key must be 32 bytes as 0x-prefixed hex");
  const base = path.join(path.resolve(dir), eventId, name);
  const plain = unseal(await readFile(`${base}.enc`), key as Hex); // throws if the key is wrong (GCM tag)
  await writeFile(base, plain);
  return base;
}
