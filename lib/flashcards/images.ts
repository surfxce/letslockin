import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { materialsDir } from "@/lib/paths";

/** Pictures added to cards by hand: drawn on, cropped, or covered up for cover-up cards. */
export const CARD_IMAGE_NAME = /^[a-f0-9]{24}\.(png|jpg|webp|gif)$/;
export const CARD_IMAGE_PATH = "/api/ak/images/";
export const MAX_CARD_IMAGE_BYTES = 15 * 1024 * 1024;

const TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" } as const;
type Ext = keyof typeof TYPES;

export function cardImagesDir(): string {
  return path.join(materialsDir(), "ak");
}

/** What the bytes are, from their first few, whatever the upload claimed. */
export function sniffImage(bytes: Uint8Array): Ext | null {
  const at = (i: number, ...b: number[]) => b.every((v, k) => bytes[i + k] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

export async function saveCardImage(bytes: Uint8Array): Promise<{ name: string; url: string }> {
  if (bytes.length > MAX_CARD_IMAGE_BYTES) throw new Error("That picture is too big (15 MB at most).");
  const ext = sniffImage(bytes);
  if (!ext) throw new Error("That isn't a picture Lockin can show (PNG, JPEG, WebP or GIF).");
  const name = `${randomBytes(12).toString("hex")}.${ext}`;
  await mkdir(cardImagesDir(), { recursive: true });
  await writeFile(path.join(cardImagesDir(), name), bytes);
  return { name, url: CARD_IMAGE_PATH + name };
}

export async function readCardImage(name: string): Promise<{ bytes: Buffer; type: string } | null> {
  const m = CARD_IMAGE_NAME.exec(name);
  if (!m) return null;
  try {
    return { bytes: await readFile(path.join(cardImagesDir(), name)), type: TYPES[m[1] as Ext] };
  } catch {
    return null;
  }
}
