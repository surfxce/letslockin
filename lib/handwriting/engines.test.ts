import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AnthropicApiProvider, OpenAiCompatibleProvider } from "@/lib/llm/api";

const REPLY = JSON.stringify({ text: "IgA deposits in the mesangium", unclear: ["mesangium"] });

describe("photos of a handwritten answer, as each API is sent them", () => {
  let dir = "";
  let pages: string[] = [];
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "lockin-hw-"));
    pages = [path.join(dir, "page-1.jpg"), path.join(dir, "page-2.jpg")];
    await writeFile(pages[0], Buffer.from([0xff, 0xd8, 0xff, 1]));
    await writeFile(pages[1], Buffer.from([0xff, 0xd8, 0xff, 2]));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  });

  it("Claude gets each page as an image, in order, before the prompt", async () => {
    const provider = new AnthropicApiProvider("sk-test", "claude-sonnet-5-5");
    let sent: { messages: Array<{ content: Array<Record<string, unknown>> }> } | null = null;
    (provider as unknown as { client: unknown }).client = {
      beta: {
        messages: {
          stream: (params: typeof sent) => {
            sent = params;
            return { finalMessage: async () => ({ stop_reason: "end_turn", model: "claude-sonnet-5-5", content: [{ type: "text", text: REPLY }] }) };
          },
        },
      },
    };
    const read = await provider.readHandwriting({ question: "Explain IgA nephropathy.", pages });
    expect(read).toEqual({ text: "IgA deposits in the mesangium", unclear: ["mesangium"] });
    const content = sent!.messages[0].content;
    expect(content.map((b) => b.type)).toEqual(["image", "image", "text"]);
    expect(content[0].source).toEqual({ type: "base64", media_type: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 1]).toString("base64") });
    expect(String(content[2].text)).toMatch(/Explain IgA nephropathy\.[\s\S]*2 photos are attached, in page order/);
    expect(provider.lastPromptVersion).toBe("read-handwriting@1.0.0");
  });

  it("an OpenAI-style service gets them as image parts, when its model reads images", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ model: "gemini-3-pro", choices: [{ message: { content: REPLY } }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const provider = new OpenAiCompatibleProvider("Google Gemini", "https://example.test/v1", "key", "gemini-3-pro", true);
    await provider.readHandwriting({ question: "Explain IgA nephropathy.", pages });
    const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    const parts = body.messages[0].content as Array<{ type: string; image_url?: { url: string } }>;
    expect(parts.map((p) => p.type)).toEqual(["text", "image_url", "image_url"]);
    expect(parts[1].image_url!.url).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("a model that can't read images says so instead of guessing", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const provider = new OpenAiCompatibleProvider("OpenRouter", "https://example.test/v1", "key", "text-only", false);
    expect(() => provider.readHandwriting({ question: "Q", pages })).toThrow(/can't look at pictures/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
