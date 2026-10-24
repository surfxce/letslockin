/**
 * What the desktop app's phone gateway (electron/phone-gateway.ts) last reported, for
 * Settings to show. Kept on globalThis: Next can load a module once per route bundle,
 * and the status route and the Settings page must see the same value.
 */
export interface GatewayState {
  /** "listening", "off", or "error: …". */
  state: string;
  port: number | null;
  at: number;
}

const store = globalThis as unknown as { __lockinPhoneGateway?: GatewayState };

export function reportGateway(state: string, port: number | null) {
  store.__lockinPhoneGateway = { state: state.slice(0, 300), port, at: Date.now() };
}

/** Null when no gateway has checked in for a while: the web version, or the desktop app closed. */
export function gatewayState(now = Date.now()): GatewayState | null {
  const s = store.__lockinPhoneGateway;
  return s && now - s.at < 15_000 ? s : null;
}
