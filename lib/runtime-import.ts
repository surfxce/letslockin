/**
 * Imports a package from node_modules when the code runs, out of sight of every
 * bundler — Next's, and esbuild's for the packaged worker. For packages that only work
 * as they ship: native binaries (node-llama-cpp, the canvas that draws slides), or ESM
 * that finds its own files through import.meta.url (the PDF renderer inside unpdf, which
 * loads that canvas itself). Bundled, those break — and some only on a page with a
 * picture, long after a text-only test has passed.
 *
 * In a CommonJS bundle a plain import() is rewritten to require(); hiding the specifier
 * in a Function keeps it a real dynamic import everywhere.
 */
const load = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

export function importAtRuntime<T>(specifier: string): Promise<T> {
  return load(specifier) as Promise<T>;
}
