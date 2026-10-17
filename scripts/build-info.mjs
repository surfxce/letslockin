// Writes build-info.json: which build this is, and a fingerprint of everything an
// in-app update can't replace (the installed libraries and Electron). The desktop app
// reads it to say which version it is and whether an update can be applied in place.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const sha = process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD").toString().trim();
const subject = (() => {
  try {
    return execSync(`git log -1 --pretty=%s ${sha}`).toString().trim();
  } catch {
    return "";
  }
})();
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
// The MLX engine ships in the bundle, so a change to it also needs the full download.
const swiftFiles = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name);
    if (name.startsWith(".")) return [];
    return statSync(file).isDirectory() ? swiftFiles(file) : [file];
  });
const hash = createHash("sha256")
  .update(readFileSync("package-lock.json"))
  .update(String(pkg.devDependencies?.electron ?? ""));
for (const file of swiftFiles(path.join("swift", "LockinEngine")).sort()) hash.update(file).update(readFileSync(file));
const depsHash = hash.digest("hex").slice(0, 16);

// electron-builder copies engine/ into the app; it is empty when the engine wasn't built.
mkdirSync("engine", { recursive: true });

const info = { version: sha.slice(0, 7), builtAt: new Date().toISOString(), depsHash, notes: subject };
writeFileSync("build-info.json", JSON.stringify(info, null, 2) + "\n");
console.log("build-info", info);
