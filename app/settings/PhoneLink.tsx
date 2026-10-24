"use client";

import { useEffect, useState, useTransition } from "react";

import { pairPhone, phoneStatus, setMarkWithKey, unpairPhone, type PhoneStatus } from "@/app/settings/phone-actions";
import { Icon } from "@/app/ui/Icon";

function ago(iso: string | null): string {
  if (!iso) return "never synced";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "synced just now";
  if (minutes < 60) return `synced ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `synced ${hours} h ago`;
  return `synced ${new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

/**
 * Pairing the iPhone app: a QR code with this computer's addresses and a new key. The
 * phone then syncs straight with this computer over the Wi-Fi, sealed with that key.
 */
export function PhoneLink({ initial }: { initial: PhoneStatus }) {
  const [status, setStatus] = useState(initial);
  const [qr, setQr] = useState<{ id: string; link: string; svg: string } | null>(null);
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);

  const refresh = async () => setStatus(await phoneStatus());

  // While a code is showing, watch for the phone to say hello; otherwise now and then.
  useEffect(() => {
    const t = setInterval(() => void refresh(), qr ? 2000 : 15_000);
    return () => clearInterval(t);
  }, [qr]);

  const pairedNow = qr ? status.phones.find((p) => p.id === qr.id && p.deviceName) : undefined;
  useEffect(() => {
    if (!pairedNow) return;
    const t = setTimeout(() => setQr(null), 2500);
    return () => clearTimeout(t);
  }, [pairedNow]);

  const gateway = status.gateway;
  const listening = gateway?.state === "listening";

  return (
    <>
      <div className="setting">
        <div>
          <div className="st">Study on your iPhone</div>
          <div className="sd">
            Read summaries, answer LAQs, review cards and sit exams on your phone. It syncs with this computer
            whenever both are on the same Wi-Fi.
          </div>
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setQr(await pairPhone());
              await refresh();
            })
          }
        >
          <Icon name="plus" size={14} /> Pair an iPhone
        </button>
      </div>

      {qr && (
        <div className="phone-pair">
          {/* Server-made SVG from the qrcode package: no user text in it but the link. */}
          <div className="phone-qr" dangerouslySetInnerHTML={{ __html: qr.svg }} />
          <div className="phone-pair-text">
            {pairedNow ? (
              <p className="phone-paired">
                <Icon name="check" size={16} /> Paired with {pairedNow.deviceName}.
              </p>
            ) : (
              <>
                <p>
                  <strong>On your iPhone, open Lockin and tap Scan</strong>, or point the Camera app at this code. Keep
                  the phone on the same Wi-Fi as this computer.
                </p>
                <p className="small muted">Only scan it with your own phone.</p>
                <p className="small">
                  {listening ? (
                    <span className="tag t-green">Waiting for your phone…</span>
                  ) : gateway?.state.startsWith("error") ? (
                    <span className="result err">{gateway.state.replace(/^error: /, "Can't listen for phones: ")}</span>
                  ) : gateway ? (
                    <span className="tag t-gray">Getting ready…</span>
                  ) : (
                    <span className="result err">Open the Lockin desktop app to pair a phone.</span>
                  )}
                </p>
                <p className="small muted">
                  <button
                    type="button"
                    className="btn quiet sm"
                    onClick={() => {
                      void navigator.clipboard?.writeText(qr.link);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                  >
                    {copied ? "Copied" : "Copy pairing link"}
                  </button>
                </p>
              </>
            )}
            <button type="button" className="btn sm" onClick={() => setQr(null)}>
              Done
            </button>
          </div>
        </div>
      )}

      {status.phones.length > 0 && (
        <div className="files" style={{ marginTop: 8 }}>
          {status.phones.map((p) => (
            <div key={p.id} className="file" style={{ alignItems: "center" }}>
              <Icon name="phone" size={15} />
              <span style={{ flex: 1 }}>
                <span className="fname">{p.deviceName ?? "Waiting for a phone to scan"}</span>{" "}
                <span className="small muted">· {p.deviceName ? ago(p.lastSyncAt) : "not used yet"}</span>
              </span>
              {!p.deviceName && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={pending}
                  onClick={() => start(async () => setQr(await pairPhone(p.id)))}
                >
                  Show code
                </button>
              )}
              <button
                type="button"
                className="btn quiet sm"
                disabled={pending}
                onClick={() => {
                  if (!p.deviceName || window.confirm(`Unpair ${p.deviceName}? It won't be able to sync until you pair it again.`)) {
                    start(async () => {
                      await unpairPhone(p.id);
                      if (qr?.id === p.id) setQr(null);
                      await refresh();
                    });
                  }
                }}
              >
                {p.deviceName ? "Unpair" : "Cancel"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="setting">
        <div>
          <div className="st">Mark answers on the phone</div>
          <div className="sd">
            {status.keyMarking
              ? "Your phone marks answers straight away, anywhere, using your API key. Off: they're marked here the next time your phone syncs."
              : "Answers from your phone are marked here the next time it syncs. With an API key (under Summaries and LAQs), the phone can mark them itself."}
          </div>
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={status.keyMarking && status.markWithKey}
            disabled={!status.keyMarking || pending}
            onChange={(e) => {
              const want = e.target.checked;
              setStatus({ ...status, markWithKey: want });
              start(() => setMarkWithKey(want));
            }}
            aria-label="Mark answers on the phone"
          />
          <span />
        </label>
      </div>
    </>
  );
}
