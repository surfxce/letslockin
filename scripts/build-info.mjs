// Writes build-info.json: which build this is, and a fingerprint of everything an
// in-app update can't replace (the installed libraries and Electron). The desktop app
// reads it to say which version it is and whether an update can be applied in place.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const sha = process.env.GITHUB_SHA ?? execSync("git rev-parse HEAD").toString().trim();
const subject = (() => {
  try {
    return execSync(`git log -1 --pretty=%s ${sha}`).toString().trim();
  } catch {
    return "";
  }
})();
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const depsHash = createHash("sha256")
  .update(readFileSync("package-lock.json"))
  .update(String(pkg.devDependencies?.electron ?? ""))
  .digest("hex")
  .slice(0, 16);

const info = { version: sha.slice(0, 7), builtAt: new Date().toISOString(), depsHash, notes: subject };
writeFileSync("build-info.json", JSON.stringify(info, null, 2) + "\n");
console.log("build-info", info);
