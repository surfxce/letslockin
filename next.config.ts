import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Only native modules stay external — they have to be require()d from the app's
  // own node_modules (better-sqlite3 is rebuilt there against Electron's ABI; the
  // canvas that draws slide pictures ships prebuilt N-API binaries). The Prisma
  // adapter around SQLite is plain JavaScript and is bundled: listing it here makes
  // Turbopack emit a content-hashed external id that resolves to nothing once the
  // app is packaged.
  serverExternalPackages: ["better-sqlite3", "@napi-rs/canvas"],
};

export default nextConfig;
