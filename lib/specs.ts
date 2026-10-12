import os from "node:os";

import type { MachineSpecs } from "@/lib/llm/catalog";

/**
 * What this computer has, for choosing a local model. Deliberately simple — memory,
 * cores, and whether it is Apple Silicon (unified memory with a GPU llama.cpp uses) —
 * because that is most of what decides which model runs well.
 */
export function machineSpecs(): MachineSpecs {
  const cpus = os.cpus();
  const model = cpus[0]?.model ?? "";
  const platform = process.platform;
  return {
    ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    cores: cpus.length,
    // arch alone misses a Mac running an x64 Node under Rosetta.
    appleSilicon: platform === "darwin" && (process.arch === "arm64" || /apple/i.test(model)),
    kind: platform === "darwin" ? "Mac" : platform === "win32" ? "Windows PC" : "computer",
  };
}
