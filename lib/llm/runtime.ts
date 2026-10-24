import { importAtRuntime } from "@/lib/runtime-import";

/**
 * node-llama-cpp is ESM-only and ships native binaries, so it must be loaded from
 * node_modules at runtime, never bundled — by Next, or by esbuild for the packaged
 * worker (see lib/runtime-import.ts).
 */
export type NodeLlamaCpp = typeof import("node-llama-cpp");

let loaded: Promise<NodeLlamaCpp> | null = null;

export function importLlamaCpp(): Promise<NodeLlamaCpp> {
  loaded ??= importAtRuntime<NodeLlamaCpp>("node-llama-cpp");
  return loaded;
}
