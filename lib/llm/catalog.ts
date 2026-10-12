/**
 * The models Lockin offers to run on this computer, smallest first. Download links
 * are Hugging Face URIs that node-llama-cpp resolves to the right file, taken from the
 * list node-llama-cpp itself vets (its CLI's recommendedModels), at the Q4_K_M
 * quantisation: the usual balance of size and quality.
 *
 * Sizes are approximate until a download starts and the real size is known.
 * Client-safe: no imports, plain data.
 */

export interface LocalModel {
  id: string;
  name: string;
  maker: string;
  /** "8B, 4.5B active" — what the card shows under the name. */
  params: string;
  /** Approximate download, GB. */
  downloadGb: number;
  /** Memory for the model plus a lecture-length context, GB. Below this it will crawl or fail. */
  needsRamGb: number;
  /** Relative speed on the same machine, 1 (slowest) to 5 (fastest). */
  speed: number;
  uri: string;
  blurb: string;
}

export const LOCAL_MODELS: readonly LocalModel[] = [
  {
    id: "qwen-3.5-0.8b",
    name: "Qwen 3.5 0.8B",
    maker: "Alibaba",
    params: "0.8B",
    downloadGb: 0.6,
    needsRamGb: 4,
    speed: 5,
    uri: "hf:unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M",
    blurb: "Tiny and quick. Fine for summaries; its questions are simpler.",
  },
  {
    id: "gemma-4-e2b",
    name: "Gemma 4 E2B",
    maker: "Google",
    params: "5B, 2.3B active",
    downloadGb: 3.1,
    needsRamGb: 6,
    speed: 4,
    uri: "hf:giladgd/gemma-4-E2B-it-GGUF:Q4_K_M",
    blurb: "Google's smallest Gemma 4. Good summaries on modest laptops.",
  },
  {
    id: "gemma-4-e4b",
    name: "Gemma 4 E4B",
    maker: "Google",
    params: "8B, 4.5B active",
    downloadGb: 5,
    needsRamGb: 10,
    speed: 3,
    uri: "hf:giladgd/gemma-4-E4B-it-GGUF:Q4_K_M",
    blurb: "A solid all-rounder: clear summaries and fair exam questions.",
  },
  {
    id: "gemma-4-12b",
    name: "Gemma 4 12B",
    maker: "Google",
    params: "12B",
    downloadGb: 7.3,
    needsRamGb: 16,
    speed: 2,
    uri: "hf:giladgd/gemma-4-12B-it-GGUF:Q4_K_M",
    blurb: "A real step up in detail, marking and question quality.",
  },
  {
    id: "gemma-4-26b-a4b",
    name: "Gemma 4 26B",
    maker: "Google",
    params: "26B, 3.8B active",
    downloadGb: 15.5,
    needsRamGb: 24,
    speed: 3,
    uri: "hf:giladgd/gemma-4-26B-A4B-it-GGUF:Q4_K_M",
    blurb: "Near-flagship quality, and quick for its size — it only runs part of itself per word.",
  },
  {
    id: "gemma-4-31b",
    name: "Gemma 4 31B",
    maker: "Google",
    params: "31B",
    downloadGb: 18.7,
    needsRamGb: 32,
    speed: 1,
    uri: "hf:giladgd/gemma-4-31B-it-GGUF:Q4_K_M",
    blurb: "The most capable Gemma 4. Slow, but the most careful marker.",
  },
];

export function findModel(id: string | null | undefined): LocalModel | undefined {
  return LOCAL_MODELS.find((m) => m.id === id);
}

export interface MachineSpecs {
  ramGb: number;
  cores: number;
  /** Unified memory and a GPU llama.cpp uses via Metal: much faster per GB. */
  appleSilicon: boolean;
  /** "Mac", "Windows PC", "Linux PC" — for the sentence on the card. */
  kind: string;
}

export interface ModelPicks {
  performance: LocalModel;
  recommended: LocalModel;
  quality: LocalModel;
  /** One line on why, for the onboarding card. */
  why: string;
  /** A warning when even the recommendation is a stretch, or quality will crawl. */
  caution: string | null;
}

/**
 * Three choices around what this computer can comfortably run: the largest model
 * that fits its memory in the middle, one size down for speed, one up for quality.
 * Without Apple Silicon or a lot of cores, everything runs on the CPU, so the middle
 * pick drops a size to stay usable.
 */
export function recommendModels(specs: MachineSpecs): ModelPicks {
  const ladder = LOCAL_MODELS;
  const lowest = 1; // the tiny model is only ever the fast option, never the default
  const highest = ladder.length - 2; // the largest is only ever the quality option

  let rec = lowest;
  // Half a GB of slack: a "16 GB" machine can report 15.6 once the system takes its share.
  for (let i = lowest; i <= highest; i++) if (ladder[i].needsRamGb <= specs.ramGb + 0.5) rec = i;
  const cpuOnly = !specs.appleSilicon && specs.cores < 8;
  if (cpuOnly) rec = Math.max(lowest, rec - 1);

  const picks = { performance: ladder[rec - 1], recommended: ladder[rec], quality: ladder[rec + 1] };
  const ram = `${Math.round(specs.ramGb)} GB memory`;
  const chip = specs.appleSilicon ? "Apple Silicon" : `${specs.cores} cores`;
  const why = cpuOnly
    ? `Your ${specs.kind} has ${ram} and ${chip}, and will run models on its processor — so a size down keeps each lecture to minutes, not hours.`
    : `Your ${specs.kind} has ${ram} and ${chip}: this is the largest model that runs comfortably on it.`;

  let caution: string | null = null;
  if (specs.ramGb < picks.recommended.needsRamGb) {
    caution = `With ${ram}, even the recommended model is a squeeze — close other apps while it works, or use Performance.`;
  } else if (specs.ramGb < picks.quality.needsRamGb) {
    caution = `Quality wants about ${picks.quality.needsRamGb} GB of memory; on this computer it will be slow.`;
  }
  return { ...picks, why, caution };
}
