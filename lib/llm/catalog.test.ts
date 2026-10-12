import { describe, expect, it } from "vitest";
import { LOCAL_MODELS, recommendModels, type MachineSpecs } from "./catalog";

const mac = (ramGb: number, cores = 8): MachineSpecs => ({ ramGb, cores, appleSilicon: true, kind: "Mac" });
const pc = (ramGb: number, cores: number): MachineSpecs => ({ ramGb, cores, appleSilicon: false, kind: "Windows PC" });
const ids = (s: MachineSpecs) => {
  const p = recommendModels(s);
  return [p.performance.id, p.recommended.id, p.quality.id];
};

describe("recommendModels", () => {
  it("puts the largest comfortable model in the middle, one size either side", () => {
    expect(ids(mac(8))).toEqual(["qwen-3.5-0.8b", "gemma-4-e2b", "gemma-4-e4b"]);
    expect(ids(mac(16, 10))).toEqual(["gemma-4-e4b", "gemma-4-12b", "gemma-4-26b-a4b"]);
    expect(ids(mac(32, 12))).toEqual(["gemma-4-12b", "gemma-4-26b-a4b", "gemma-4-31b"]);
  });

  it("never recommends the tiny model or the largest one", () => {
    expect(recommendModels(mac(4)).recommended.id).toBe("gemma-4-e2b");
    expect(recommendModels(mac(128, 24)).recommended.id).toBe("gemma-4-26b-a4b");
  });

  it("allows for memory the system reserves", () => {
    expect(recommendModels(mac(15.6)).recommended.id).toBe("gemma-4-12b");
  });

  it("drops a size on a CPU-only machine with few cores", () => {
    expect(recommendModels(pc(16, 6)).recommended.id).toBe("gemma-4-e4b");
    expect(recommendModels(pc(16, 16)).recommended.id).toBe("gemma-4-12b");
  });

  it("warns when the quality pick will not fit comfortably", () => {
    expect(recommendModels(mac(16)).caution).toMatch(/24 GB/);
    expect(recommendModels(mac(64)).caution).toBeNull();
    expect(recommendModels(mac(4)).caution).toMatch(/squeeze/);
  });

  it("keeps the ladder ordered by size, each with a resolvable link", () => {
    const sizes = LOCAL_MODELS.map((m) => m.downloadGb);
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
    for (const m of LOCAL_MODELS) expect(m.uri).toMatch(/^hf:[\w.-]+\/[\w.-]+:Q4_K_M$/);
  });
});
