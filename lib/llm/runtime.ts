/**
 * node-llama-cpp is ESM-only and ships native binaries, so it must be loaded from
 * node_modules at runtime, never bundled — by Next, or by esbuild for the packaged
 * worker (which is CommonJS, where a plain import() would be rewritten to require()).
 * Hiding the specifier from both keeps it a real dynamic import everywhere.
 */
export type NodeLlamaCpp = typeof import("node-llama-cpp");

const dynamicImport = new Function("specifier", "return import(specifier)") as (s: string) => Promise<unknown>;

let loaded: Promise<NodeLlamaCpp> | null = null;

export function importLlamaCpp(): Promise<NodeLlamaCpp> {
  loaded ??= dynamicImport("node-llama-cpp") as Promise<NodeLlamaCpp>;
  return loaded;
}
