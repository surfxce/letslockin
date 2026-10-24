/** Lecture recordings: which files count as one. Client-safe. */

export const RECORDING_EXTS = [".mp4", ".m4a", ".mp3", ".wav", ".mov", ".m4v", ".aac", ".webm", ".ogg", ".flac", ".aiff", ".caf"];

/** For a file input's `accept`. */
export const RECORDING_ACCEPT = RECORDING_EXTS.join(",");

const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
};

export function isRecording(name: string): boolean {
  return RECORDING_EXTS.includes(extOf(name));
}

/** Sound an AI that listens takes as it is, by its type; anything else is converted first. */
export function listenableType(name: string): string | null {
  const types: Record<string, string> = {
    ".aac": "audio/aac",
    ".mp3": "audio/mp3",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".aiff": "audio/aiff",
  };
  return types[extOf(name)] ?? null;
}

/** The largest recording Lockin takes: a long lecture filmed in high definition. */
export const MAX_RECORDING_BYTES = 6 * 1024 ** 3;
