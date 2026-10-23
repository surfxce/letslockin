"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Icon } from "@/app/ui/Icon";
import { RECORDING_ACCEPT } from "@/lib/recordings/media";

/**
 * Adds a lecture recording. Sent straight to the server as it's read, with progress,
 * since a filmed lecture can take a while even over this computer's own connection.
 */
export function RecordingUpload({ lectureId, via }: { lectureId: string; via: string }) {
  const router = useRouter();
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function send(file: File) {
    setMessage(null);
    setProgress(0);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/lectures/${lectureId}/recording`);
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total);
    xhr.onload = () => {
      setProgress(null);
      let body: { error?: string; added?: boolean } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Shown as a plain failure below.
      }
      if (xhr.status >= 400) setMessage({ ok: false, text: body.error ?? "Couldn't add that recording." });
      else setMessage({ ok: true, text: body.added ? `Added — ${via}.` : "That recording is already here." });
      router.refresh();
    };
    xhr.onerror = () => {
      setProgress(null);
      setMessage({ ok: false, text: "Couldn't add that recording." });
    };
    xhr.send(file);
  }

  return (
    <div className="recording-upload">
      <label className={`btn${progress !== null ? " disabled" : ""}`} aria-disabled={progress !== null}>
        <Icon name="upload" size={15} /> {progress !== null ? `Adding… ${Math.round(progress * 100)}%` : "Add a recording"}
        <input
          type="file"
          hidden
          accept={RECORDING_ACCEPT}
          disabled={progress !== null}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) send(file);
          }}
        />
      </label>
      <span className="small muted">Audio or video of the lecture (.mp4 .m4a .mp3 .mov…) — Lockin writes the transcript.</span>
      {message && <p className={`small ${message.ok ? "muted" : "error-text"}`}>{message.text}</p>}
    </div>
  );
}
