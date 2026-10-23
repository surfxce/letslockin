"use server";

import QRCode from "qrcode";

import { gatewayState, type GatewayState } from "@/lib/phone/gateway-state";
import {
  createPairing,
  listPairings,
  pairingLink,
  phoneHosts,
  phoneMayMarkWithKey,
  phonePort,
  removePairing,
  setPhoneMayMarkWithKey,
} from "@/lib/phone/pairing";
import { getSettings } from "@/lib/settings";

export interface PhoneStatus {
  phones: Array<{ id: string; deviceName: string | null; createdAt: string; lastSyncAt: string | null }>;
  /** Null when no desktop app is running a gateway (the web version, or `npm run phone` not started). */
  gateway: GatewayState | null;
  hosts: string[];
  port: number;
  /** Lockin marks with an API key, so the phone could too. */
  keyMarking: boolean;
  markWithKey: boolean;
}

/** Never includes a key: only the QR code carries one, once. */
export async function phoneStatus(): Promise<PhoneStatus> {
  const [pairings, settings, markWithKey] = await Promise.all([listPairings(), getSettings(), phoneMayMarkWithKey()]);
  return {
    phones: pairings.map(({ id, deviceName, createdAt, lastSyncAt }) => ({ id, deviceName, createdAt, lastSyncAt })),
    gateway: gatewayState(),
    hosts: phoneHosts(),
    port: gatewayState()?.port ?? phonePort(),
    keyMarking: settings.mode === "auto" && settings.cloudEngine === "api",
    markWithKey,
  };
}

/** A new pairing and its QR code. A pairing no phone has used yet can be shown again. */
export async function pairPhone(existingId?: string): Promise<{ id: string; link: string; svg: string }> {
  const pairings = await listPairings();
  const pairing = pairings.find((p) => p.id === existingId && !p.deviceName) ?? (await createPairing());
  // The port the gateway says it listens on, else the one it will.
  const link = pairingLink(pairing, phoneHosts(), gatewayState()?.port ?? phonePort());
  const svg = await QRCode.toString(link, { type: "svg", errorCorrectionLevel: "M", margin: 2, color: { dark: "#191919", light: "#ffffff" } });
  return { id: pairing.id, link, svg };
}

export async function unpairPhone(id: string) {
  await removePairing(id);
}

export async function setMarkWithKey(allowed: boolean) {
  await setPhoneMayMarkWithKey(allowed);
}
