import { randomBytes } from "node:crypto";
import { hostname, networkInterfaces } from "node:os";

import { prisma } from "@/lib/db";
import { fromBase64Url, toBase64Url } from "@/lib/phone/crypto";

/**
 * Phones paired with this computer. Each pairing is a random id and a 256-bit key,
 * shown once as a QR code and kept here; the phone keeps its copy in the Keychain.
 * Unpairing deletes the key, and with it the phone's access.
 */
export interface Pairing {
  id: string;
  /** base64url, 32 bytes. Never sent anywhere but the QR code. */
  key: string;
  createdAt: string;
  /** What the phone calls itself, from its first hello; null until it has connected. */
  deviceName: string | null;
  lastSyncAt: string | null;
}

const PAIRINGS = "phone.pairings";
const MARK_WITH_KEY = "phone.markWithKey";

/** The port the desktop app listens on for phones (electron/phone-gateway.ts). */
export function phonePort(): number {
  const port = Number(process.env.LOCKIN_PHONE_PORT ?? 47821);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 47821;
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, value: unknown) {
  const json = JSON.stringify(value);
  await prisma.setting.upsert({ where: { key }, update: { value: json }, create: { key, value: json } });
}

export async function listPairings(): Promise<Pairing[]> {
  const list = await readJson<unknown>(PAIRINGS, []);
  if (!Array.isArray(list)) return [];
  return list.filter(
    (p): p is Pairing =>
      !!p && typeof p.id === "string" && typeof p.key === "string" && fromBase64Url(p.key).length === 32,
  );
}

export async function findPairing(id: string | null | undefined): Promise<Pairing | null> {
  if (!id) return null;
  return (await listPairings()).find((p) => p.id === id) ?? null;
}

export async function createPairing(): Promise<Pairing> {
  const pairing: Pairing = {
    id: toBase64Url(randomBytes(12)),
    key: toBase64Url(randomBytes(32)),
    createdAt: new Date().toISOString(),
    deviceName: null,
    lastSyncAt: null,
  };
  await writeJson(PAIRINGS, [...(await listPairings()), pairing]);
  return pairing;
}

export async function removePairing(id: string) {
  await writeJson(
    PAIRINGS,
    (await listPairings()).filter((p) => p.id !== id),
  );
}

/** Records that a phone was in touch, and what it is called. */
export async function touchPairing(id: string, update: { deviceName?: string | null; synced?: boolean }) {
  const list = await listPairings();
  const now = new Date().toISOString();
  await writeJson(
    PAIRINGS,
    list.map((p) =>
      p.id !== id
        ? p
        : {
            ...p,
            deviceName: update.deviceName?.trim().slice(0, 80) || p.deviceName,
            lastSyncAt: update.synced ? now : p.lastSyncAt,
          },
    ),
  );
}

/** Whether the phone may mark answers itself with this computer's API key. On unless turned off. */
export async function phoneMayMarkWithKey(): Promise<boolean> {
  return (await readJson<unknown>(MARK_WITH_KEY, true)) !== false;
}

export async function setPhoneMayMarkWithKey(allowed: boolean) {
  await writeJson(MARK_WITH_KEY, allowed);
}

/** This computer's name, as the phone shows it. */
export function computerName(): string {
  return hostname().replace(/\.local\.?$/i, "") || "Computer";
}

/**
 * Where a phone on the same network can reach this computer: its IPv4 addresses on
 * Wi-Fi and Ethernet first, then its Bonjour name, which keeps working when the
 * router hands out a new address.
 */
export function phoneHosts(): string[] {
  const ips: Array<{ name: string; address: string }> = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      // Link-local (no DHCP) and VPN or virtual-machine interfaces aren't reachable from a phone.
      if (a.address.startsWith("169.254.") || /^(utun|awdl|llw|bridge|vmnet|docker|veth|tun|tap)/i.test(name)) continue;
      ips.push({ name, address: a.address });
    }
  }
  // en0 / en1 (a Mac's Wi-Fi and Ethernet), eth0 and wlan0 first.
  ips.sort((a, b) => Number(!/^(en|eth|wlan)\d/.test(a.name)) - Number(!/^(en|eth|wlan)\d/.test(b.name)));
  const bonjour = `${computerName().replace(/\s+/g, "-")}.local`;
  return [...new Set([...ips.map((i) => i.address), bonjour])];
}

/** What the QR code says: everything the phone needs to find and talk to this computer. */
export function pairingLink(pairing: Pairing, hosts = phoneHosts(), port = phonePort()): string {
  const data = { v: 1, id: pairing.id, k: pairing.key, n: computerName(), h: hosts, p: port };
  return `lockin://pair?d=${Buffer.from(JSON.stringify(data), "utf8").toString("base64url")}`;
}
