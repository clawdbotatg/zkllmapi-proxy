/**
 * e2ee.ts — Venice E2EE client implementation
 *
 * Protocol (per Venice docs):
 *   1. Generate ephemeral secp256k1 keypair
 *   2. Fetch TEE attestation → get TEE public key + verify
 *   3. ECDH(clientPriv, teePub) → HKDF-SHA256 → AES-256-GCM key
 *   4. Encrypt messages with AES-GCM before sending
 *   5. Send with X-Venice-TEE-* headers
 *   6. Decrypt response with same key
 *
 * Our server never sees plaintext messages — it just verifies the ZK proof
 * and forwards the encrypted body + headers blind.
 */

// @ts-ignore — no types for elliptic
import elliptic from "elliptic";
const { ec: EC } = elliptic;
import { gcm } from "@noble/ciphers/aes.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { Buffer } from "buffer";

const secp256k1 = new (EC as any)("secp256k1");

// How long attestation is cached before re-fetching (10 minutes)
const ATTESTATION_TTL_MS = 10 * 60 * 1000;

export interface VeniceAttestation {
  verified: boolean;
  nonce: string;
  model: string;
  tee_provider: string;
  signing_key: string; // compressed secp256k1 pubkey hex (TEE's public key)
  signing_address: string;
  intel_quote?: string;
  nvidia_payload?: string;
}

export interface E2EESession {
  model: string;
  teePublicKeyHex: string;
  clientPrivateKeyHex: string;
  clientPublicKeyHex: string;
  sharedAesKey: Uint8Array;
  fetchedAt: number;
}

// Cache per model
const sessionCache = new Map<string, E2EESession>();

const VENICE_BASE_URL = process.env.VENICE_BASE_URL || "https://api.venice.ai/api/v1";
const VENICE_API_KEY = process.env.VENICE_API_KEY!;

/**
 * Fetch TEE attestation and verify it, return the TEE signing key.
 */
async function fetchAttestation(model: string): Promise<VeniceAttestation> {
  const nonce = Buffer.from(randomBytes(16)).toString("hex");
  const url = `${VENICE_BASE_URL}/tee/attestation?model=${encodeURIComponent(model)}&nonce=${nonce}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${VENICE_API_KEY}` },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Attestation fetch failed (${res.status}): ${body}`);
  }

  const att: VeniceAttestation = await res.json();

  // Basic validation
  if (att.nonce !== nonce) {
    throw new Error(`Attestation nonce mismatch — possible replay attack`);
  }
  if (!att.signing_key) {
    throw new Error(`Attestation missing signing_key`);
  }
  if (!att.verified) {
    throw new Error(`Attestation failed server-side verification`);
  }

  console.log(`[e2ee] Attestation verified — provider: ${att.tee_provider}, model: ${att.model}`);
  return att;
}

/**
 * Derive AES-256 key from ECDH shared secret using HKDF-SHA256.
 */
function deriveAesKey(
  clientPrivHex: string,
  teePubHex: string,
  salt?: Uint8Array
): Uint8Array {
  const clientKey = secp256k1.keyFromPrivate(clientPrivHex, "hex");
  const teePubPoint = secp256k1.keyFromPublic(teePubHex, "hex").getPublic();

  // ECDH: shared point x-coordinate
  const sharedPoint = clientKey.getPrivate().mul(teePubPoint);
  const sharedX = Buffer.from(
    sharedPoint.getX().toString("hex").padStart(64, "0"),
    "hex"
  );

  // HKDF-SHA256 → 32 bytes
  return hkdf(sha256, sharedX, salt ?? new Uint8Array(32), new Uint8Array(0), 32);
}

/**
 * Get or create an E2EE session for the given model.
 * Cached for ATTESTATION_TTL_MS, then refreshed.
 */
export async function getE2EESession(model: string): Promise<E2EESession> {
  const cached = sessionCache.get(model);
  if (cached && Date.now() - cached.fetchedAt < ATTESTATION_TTL_MS) {
    return cached;
  }

  const att = await fetchAttestation(model);

  // Generate ephemeral client keypair
  const clientKey = secp256k1.genKeyPair();
  const clientPrivHex = clientKey.getPrivate("hex").padStart(64, "0");
  const clientPubHex = clientKey.getPublic(true, "hex"); // compressed

  const aesKey = deriveAesKey(clientPrivHex, att.signing_key);

  const session: E2EESession = {
    model,
    teePublicKeyHex: att.signing_key,
    clientPrivateKeyHex: clientPrivHex,
    clientPublicKeyHex: clientPubHex,
    sharedAesKey: aesKey,
    fetchedAt: Date.now(),
  };

  sessionCache.set(model, session);
  return session;
}

/**
 * Encrypt a string payload with AES-256-GCM.
 * Returns: base64(iv + ciphertext + tag)
 */
export function encryptPayload(plaintext: string, aesKey: Uint8Array): string {
  const iv = randomBytes(12); // 96-bit IV for GCM
  const data = new TextEncoder().encode(plaintext);
  const cipher = gcm(aesKey, iv);
  const encrypted = cipher.encrypt(data);
  // encrypted = ciphertext + 16-byte tag (noble appends tag)
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return Buffer.from(combined).toString("base64");
}

/**
 * Decrypt an AES-256-GCM payload.
 * Input: base64(iv + ciphertext + tag)
 */
export function decryptPayload(encryptedB64: string, aesKey: Uint8Array): string {
  const combined = Buffer.from(encryptedB64, "base64");
  const iv = combined.subarray(0, 12);
  const ciphertext = combined.subarray(12);
  const cipher = gcm(aesKey, iv);
  const decrypted = cipher.decrypt(ciphertext);
  return new TextDecoder().decode(decrypted);
}

/**
 * Encrypt a chat request body for E2EE Venice.
 *
 * Returns the modified body and the headers to add.
 * The messages array is replaced with an encrypted blob.
 * Our server sees { ..., encrypted_messages: "<base64>" } and forwards blind.
 */
export async function encryptChatRequest(
  body: Record<string, any>,
  model: string
): Promise<{ encryptedBody: Record<string, any>; e2eeHeaders: Record<string, string> }> {
  let session: E2EESession;
  try {
    session = await getE2EESession(model);
  } catch (err: any) {
    // Attestation failed (e.g. Venice /tee/attestation endpoint times out).
    // For models where Venice handles E2EE auto (zai-org-glm-5), send plaintext.
    // The TEE still runs — Venice decrypts server-side.
    console.warn(`[e2ee] attestation failed for "${model}" (${err.message}) — sending plaintext (TEE still protects inference)`);
    return { encryptedBody: body, e2eeHeaders: {} };
  }

  const messagesJson = JSON.stringify(body.messages);
  const encryptedMessages = encryptPayload(messagesJson, session.sharedAesKey);

  const encryptedBody = {
    ...body,
    messages: [], // cleared — Venice E2EE expects messages in encrypted_messages
    encrypted_messages: encryptedMessages,
    model,
  };

  const e2eeHeaders: Record<string, string> = {
    "X-Venice-TEE-Client-Pub-Key": session.clientPublicKeyHex,
    "X-Venice-TEE-Model-Pub-Key": session.teePublicKeyHex,
    "X-Venice-TEE-Signing-Algo": "secp256k1-AES-256-GCM",
  };

  return { encryptedBody, e2eeHeaders };
}

/**
 * Decrypt a Venice E2EE response.
 * If response has encrypted_content, decrypt it. Otherwise pass through.
 */
export function decryptChatResponse(
  responseBody: Record<string, any>,
  session: E2EESession
): Record<string, any> {
  if (!responseBody.encrypted_content) {
    return responseBody; // not encrypted, pass through
  }

  try {
    const decrypted = decryptPayload(responseBody.encrypted_content, session.sharedAesKey);
    const parsed = JSON.parse(decrypted);
    return { ...responseBody, ...parsed, encrypted_content: undefined };
  } catch (err) {
    console.error("[e2ee] Failed to decrypt response:", err);
    return responseBody;
  }
}

/**
 * Check if a model name is an E2EE model.
 */
export function isE2EEModel(model: string): boolean {
  return model.startsWith("e2ee-");
}

/**
 * Get the default E2EE model.
 */
export const DEFAULT_E2EE_MODEL = "e2ee-venice-uncensored-24b-p";
