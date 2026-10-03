// Read-only share links without a database: the saved brief travels in the link, compressed and
// HMAC-signed so a modified link cannot pass as a Qloo-backed result. Server-only (needs SHARE_SECRET).
import { createHmac, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";

/** Token kinds: "v1" = shared brief, "s1" = live run state. The kind is signed, so one cannot pass as the other. */
export type TokenKind = "v1" | "s1";
/** Keeps links usable in browsers and chat apps; a full brief compresses to well under this. */
export const MAX_TOKEN_LENGTH = 12_000;

function secret(): string {
  const s = process.env.SHARE_SECRET;
  if (!s || s.length < 32) throw new Error("SHARE_SECRET must be set to at least 32 characters");
  return s;
}

const sign = (kind: TokenKind, body: string) => createHmac("sha256", secret()).update(`${kind}.${body}`).digest("base64url");

export function encodeShare(payload: unknown, kind: TokenKind = "v1"): string {
  const body = deflateRawSync(Buffer.from(JSON.stringify(payload))).toString("base64url");
  const token = `${kind}.${body}.${sign(kind, body)}`;
  if (token.length > MAX_TOKEN_LENGTH) throw new Error(`Share payload too large (${token.length} chars)`);
  return token;
}

/** Returns the payload, or throws if the token is malformed, from another version, or tampered with. */
export function decodeShare<T = unknown>(token: string, kind: TokenKind = "v1"): T {
  const [version, body, mac] = token.split(".");
  if (version !== kind || !body || !mac) throw new Error("Unsupported share link");
  const expected = Buffer.from(sign(kind, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new Error("Share link signature mismatch");
  return JSON.parse(inflateRawSync(Buffer.from(body, "base64url")).toString("utf8")) as T;
}
