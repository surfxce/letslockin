import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Only the native module stays external — it has to be require()d from the app's
  // own node_modules, where electron-builder rebuilds it against Electron's ABI.
  // The Prisma adapter around it is plain JavaScript and is bundled: listing it here
  // makes Turbopack emit a content-hashed external id that resolves to nothing once
  // the app is packaged.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
