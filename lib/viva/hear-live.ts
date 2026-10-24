"use client";

import { joinChunks, pcm16, streamDownsampler } from "@/lib/viva/wav";

export interface LiveText {
  /** Words that won't change now. */
  confirmed: string;
  /** The end of what's been said so far, which still may. */
  tentative: string;
  /** What Whisper is doing before it can hear (downloading, loading), else null. */
  preparing: string | null;
  /** Why the words stopped coming, when they did; the whole answer is heard at the end instead. */
  stalled: string | null;
}

/**
 * A spoken answer sent to be heard while it's said: the microphone's sound goes to this
 * computer a piece at a time — one request at a time, each carrying whatever came while
 * the last was out — and what Whisper has heard so far comes back each time.
 */
export class LiveAnswer {
  private readonly id = crypto.randomUUID();
  private downsample: ((piece: Float32Array) => Float32Array) | null = null;
  private waiting: Float32Array[] = [];
  private out: Promise<void> | null = null;
  private started = false;
  private failed: string | null = null;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly vivaId: string,
    private readonly onText: (text: LiveText) => void,
  ) {
    this.timer = setInterval(() => this.tick(), 400);
  }

  /** Sound from the microphone, at its own rate. */
  add(piece: Float32Array, rate: number) {
    this.downsample ??= streamDownsampler(rate);
    this.waiting.push(this.downsample(piece));
  }

  /** The whole text, once the end has been heard; throws when it couldn't be heard live. */
  async finish(): Promise<string> {
    clearInterval(this.timer);
    await this.out;
    if (this.failed) throw new Error(this.failed);
    const body = await this.post(true);
    if (typeof body.text !== "string") throw new Error(body.error ?? "Nothing came back.");
    return body.text;
  }

  /** Stops sending; the computer drops it when the next answer starts. */
  cancel() {
    clearInterval(this.timer);
    this.failed ??= "Cancelled.";
  }

  private tick() {
    if (this.out || this.failed || !this.waiting.length) return;
    this.out = this.post(false)
      .then((body) => {
        if (body.error) throw new Error(body.error);
        this.onText({ confirmed: body.confirmed ?? "", tentative: body.tentative ?? "", preparing: body.preparing ?? null, stalled: null });
      })
      .catch((err: unknown) => {
        this.failed = err instanceof Error ? err.message : String(err);
        this.onText({ confirmed: "", tentative: "", preparing: null, stalled: this.failed });
      })
      .finally(() => {
        this.out = null;
      });
  }

  private async post(end: boolean): Promise<{ confirmed?: string; tentative?: string; preparing?: string | null; text?: string; error?: string }> {
    const sound = pcm16(joinChunks(this.waiting));
    this.waiting = [];
    const query = new URLSearchParams({ answer: this.id });
    if (!this.started) query.set("start", "1");
    if (end) query.set("end", "1");
    this.started = true;
    const res = await fetch(`/api/viva/${this.vivaId}/live?${query}`, { method: "POST", body: sound });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return res.ok ? body : { error: body.error ?? `the computer answered ${res.status}` };
  }
}
