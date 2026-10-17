import { describe, expect, it } from "vitest";

import { mmprojRepos, pickAsset, pickMmproj } from "./vision";
import { withSlideNotes } from "../sources";

describe("pickAsset", () => {
  const names = [
    "cudart-llama-bin-win-cuda-12.4-x64.zip",
    "llama-b7000-bin-macos-arm64.tar.gz",
    "llama-b7000-bin-macos-x64.tar.gz",
    "llama-b7000-bin-ubuntu-x64.zip",
    "llama-b7000-bin-ubuntu-vulkan-x64.zip",
    "llama-b7000-bin-win-cpu-x64.zip",
    "llama-b7000-bin-win-cuda-12.4-x64.zip",
    "llama-b7000-xcframework.zip",
  ];
  it("picks this computer's build", () => {
    expect(pickAsset(names, "darwin", "arm64")).toBe("llama-b7000-bin-macos-arm64.tar.gz");
    expect(pickAsset(names, "darwin", "x64")).toBe("llama-b7000-bin-macos-x64.tar.gz");
    expect(pickAsset(names, "win32", "x64")).toBe("llama-b7000-bin-win-cpu-x64.zip");
    expect(pickAsset(names, "linux", "x64")).toBe("llama-b7000-bin-ubuntu-x64.zip");
    expect(pickAsset(names, "linux", "arm64")).toBeNull();
  });
});

describe("pickMmproj", () => {
  it("prefers the smaller good-quality vision part", () => {
    expect(pickMmproj(["model-Q4_K_M.gguf", "mmproj-F16.gguf", "mmproj-BF16.gguf", "mmproj-F32.gguf"])).toBe("mmproj-F16.gguf");
    expect(pickMmproj(["mmproj-gemma-Q8_0.gguf", "mmproj-gemma-f16.gguf"])).toBe("mmproj-gemma-Q8_0.gguf");
    expect(pickMmproj(["model.gguf", "README.md"])).toBeNull();
  });
  it("looks in the model's own repository first", () => {
    expect(mmprojRepos("hf:giladgd/gemma-4-E4B-it-GGUF:Q4_K_M")).toEqual([
      "giladgd/gemma-4-E4B-it-GGUF",
      "ggml-org/gemma-4-E4B-it-GGUF",
      "unsloth/gemma-4-E4B-it-GGUF",
    ]);
  });
});

describe("withSlideNotes", () => {
  it("writes what was seen under each slide, and adds slides that had no text", () => {
    const text = "--- Slide 1 ---\nGlucose\n\n--- Slide 2 ---\nInsulin";
    const out = withSlideNotes(text, [
      { slide: 2, notes: "A graph of insulin rising after a meal." },
      { slide: 3, notes: "A diagram of a beta cell." },
    ])!;
    expect(out).toContain("--- Slide 1 ---\nGlucose\n");
    expect(out).toContain("--- Slide 2 ---\nInsulin\n[On this slide: A graph of insulin rising after a meal.]");
    expect(out).toContain("--- Slide 3 ---\nA diagram of a beta cell.");
  });
  it("stands in for slides with no text at all", () => {
    expect(withSlideNotes(undefined, [{ slide: 1, notes: "A title." }])).toBe("--- Slide 1 ---\nA title.");
    expect(withSlideNotes("--- Slide 1 ---\nx", [])).toBe("--- Slide 1 ---\nx");
  });
});
