import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * The phone and the computer share a 256-bit key from the pairing QR code, and every
 * request and reply between them is sealed with AES-256-GCM: unreadable to anyone else
 * on the Wi-Fi, and rejected if changed or made without the key. No certificates, no
 * cloud server.
 *
 * A sealed message is nonce (12 bytes) ‖ ciphertext ‖ tag (16 bytes) — the same layout
 * as CryptoKit's AES.GCM.SealedBox.combined, which the iPhone app uses. The additional
 * data binds a message to what it is for (which request, which reply), so one can't be
 * replayed as another.
 */
const NONCE = 12;
const TAG = 16;

export function seal(key: Buffer, plaintext: Buffer, aad: string, nonce: Buffer = randomBytes(NONCE)): Buffer {
  if (key.length !== 32) throw new Error("the key must be 32 bytes");
  if (nonce.length !== NONCE) throw new Error("the nonce must be 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

/** The plaintext, or null when the message wasn't sealed with this key for this purpose. */
export function open(key: Buffer, sealed: Buffer, aad: string): Buffer | null {
  if (key.length !== 32 || sealed.length < NONCE + TAG) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, NONCE));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
    return Buffer.concat([decipher.update(sealed.subarray(NONCE, sealed.length - TAG)), decipher.final()]);
  } catch {
    return null;
  }
}

export function toBase64Url(bytes: Buffer): string {
  return bytes.toString("base64url");
}

export function fromBase64Url(text: string): Buffer {
  return Buffer.from(text, "base64url");
}

/** What a request and its reply are bound to. The iPhone app builds the same strings. */
export const requestAad = (op: string, pairingId: string) => `lockin/1 request ${op} ${pairingId}`;
export const replyAad = (op: string, requestId: string) => `lockin/1 reply ${op} ${requestId}`;
