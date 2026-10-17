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
  /** Its llama.cpp (GGUF) download. Absent for a model offered on MLX only. */
  uri?: string;
  /** Its MLX copy on Hugging Face, for the Swift engine on Apple Silicon (lib/llm/mlx.ts). */
  mlx?: string;
  blurb: string;
  /** Takes images, so it can be shown the slides (lib/llm/vision.ts). */
  vision?: boolean;
  /** For an alternative: the main model it compares with, so it shows in that one's column. */
  like?: string;
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
    mlx: "mlx-community/Qwen3.5-0.8B-4bit",
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
    mlx: "mlx-community/gemma-4-e2b-it-4bit",
    vision: true,
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
    mlx: "mlx-community/gemma-4-e4b-it-4bit",
    vision: true,
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
    mlx: "mlx-community/gemma-4-12b-it-4bit",
    vision: true,
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
    mlx: "mlx-community/gemma-4-26b-a4b-it-4bit",
    vision: true,
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
    mlx: "mlx-community/gemma-4-31b-it-4bit",
    vision: true,
    blurb: "The most capable Gemma 4. Slow, but the most careful marker.",
  },
];

/**
 * Other models to choose from, on MLX only — every one is in mlx-swift-lm's own model
 * registry, so the engine is known to load it. Those that see images are offered as
 * alternatives beside the main three (`like`); the rest, tiny to enormous, are in the
 * full list. Sizes are the 4-bit downloads, roughly.
 */
const alt = (m: Omit<LocalModel, "blurb"> & { blurb?: string }): LocalModel => ({ blurb: "", ...m });
export const MORE_MODELS: readonly LocalModel[] = [
  // Sees slides
  alt({ id: "fastvlm-0.5b", name: "FastVLM 0.5B", maker: "Apple", params: "0.5B", downloadGb: 1.2, needsRamGb: 3, speed: 5, mlx: "mlx-community/FastVLM-0.5B-bf16", vision: true, like: "qwen-3.5-0.8b" }),
  alt({ id: "lfm2.5-vl-1.6b", name: "LFM2.5-VL 1.6B", maker: "Liquid AI", params: "1.6B", downloadGb: 1.0, needsRamGb: 3, speed: 5, mlx: "mlx-community/LFM2.5-VL-1.6B-4bit", vision: true, like: "gemma-4-e2b" }),
  alt({ id: "ministral-3-3b", name: "Ministral 3 3B", maker: "Mistral", params: "3B", downloadGb: 2.2, needsRamGb: 5, speed: 5, mlx: "mlx-community/Ministral-3-3B-Instruct-2512-4bit", vision: true, like: "gemma-4-e2b", blurb: "Small and quick, with a good eye for diagrams." }),
  alt({ id: "qwen3-vl-4b", name: "Qwen3-VL 4B", maker: "Alibaba", params: "4B", downloadGb: 4.6, needsRamGb: 8, speed: 4, mlx: "mlx-community/Qwen3-VL-4B-Instruct-8bit", vision: true, like: "gemma-4-e4b", blurb: "Qwen's vision model: strong at reading text in figures and tables." }),
  alt({ id: "qwen-3.8-27b", name: "Qwen 3.8 27B", maker: "Alibaba", params: "27B", downloadGb: 15.5, needsRamGb: 24, speed: 1, mlx: "mlx-community/Qwen3.8-27B-4bit", vision: true, like: "gemma-4-31b", blurb: "The newest Qwen at this size: careful and thorough, a strong marker." }),
  // Text only: slides are read as text
  alt({ id: "lille-130m", name: "Lille 130M", maker: "Nikita Martynov", params: "130M", downloadGb: 0.26, needsRamGb: 1, speed: 5, mlx: "mlx-community/lille-130m-instruct-bf16" }),
  alt({ id: "gpt-oss-20b", name: "gpt-oss 20B", maker: "OpenAI", params: "21B, 3.6B active", downloadGb: 12, needsRamGb: 16, speed: 4, mlx: "mlx-community/gpt-oss-20b-MXFP4-Q8" }),
  alt({ id: "qwen-3.6-27b", name: "Qwen 3.6 27B", maker: "Alibaba", params: "27B", downloadGb: 15.5, needsRamGb: 24, speed: 1, mlx: "mlx-community/Qwen3.6-27B-4bit" }),
  alt({ id: "deepseek-r1", name: "DeepSeek R1", maker: "DeepSeek", params: "671B, 37B active", downloadGb: 380, needsRamGb: 420, speed: 1, mlx: "mlx-community/DeepSeek-R1-4bit" }),
];

/**
 * A small model that sees the slides paired with a larger one that writes: the eye is
 * shown each slide and notes what is on it, then the writer writes the summary and
 * LAQs from those notes, as it would from Claude's. They run one after the other, so
 * the memory needed is the larger of the two. The eye runs on MLX.
 */
export interface ModelPair {
  eye: string;
  writer: string;
  blurb: string;
}

export const PAIRS: readonly ModelPair[] = [
  { eye: "fastvlm-0.5b", writer: "gemma-4-e4b", blurb: "Light: through the slides in no time, on a modest laptop." },
  { eye: "fastvlm-0.5b", writer: "gpt-oss-20b", blurb: "Quickest through the slides, and gpt-oss writes fast for its size." },
  { eye: "qwen3-vl-4b", writer: "gpt-oss-20b", blurb: "Reads labels, figures and tables well, and still writes quickly." },
  { eye: "qwen3-vl-4b", writer: "qwen-3.6-27b", blurb: "The most careful pair: slower, with thorough summaries and marking." },
];

/** "35B, 3B active" → 35e9; "135M" → 135e6 — for listing models smallest first. */
export function parameterCount(m: LocalModel): number {
  const match = m.params.match(/([\d.]+)\s*([BM])/i);
  if (!match) return 0;
  return Number(match[1]) * (match[2].toUpperCase() === "B" ? 1e9 : 1e6);
}

export function findModel(id: string | null | undefined): LocalModel | undefined {
  return LOCAL_MODELS.find((m) => m.id === id) ?? MORE_MODELS.find((m) => m.id === id);
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
