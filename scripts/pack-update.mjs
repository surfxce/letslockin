// After `npm run dmg`: packs Lockin's own code — not Electron or node_modules — into
// release/lockin-update.tar.gz, with release/update.json describing it. The desktop app
// downloads these to update itself in a few MB instead of the whole .dmg.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const RELEASE = "https://github.com/surfxce/letslockin/releases/download/mac-latest";
const stage = path.join("release", "update-stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

const copy = (from, to = from) => {
  if (!existsSync(from)) return;
  cpSync(from, path.join(stage, to), {
    recursive: true,
    filter: (src) => !/(^|[\\/])\.next[\\/](cache|dev)([\\/]|$)/.test(src),
  });
};
copy(".next");
copy("dist");
copy("public");
copy("package.json");
copy("next.config.ts");
copy("build-info.json");
copy("prompts");
copy(path.join("prisma", "migrations"), "migrations");

const archive = path.join("release", "lockin-update.tar.gz");
execFileSync("tar", ["-czf", archive, "-C", stage, "."]);
rmSync(stage, { recursive: true, force: true });

const info = JSON.parse(readFileSync("build-info.json", "utf8"));
const bytes = readFileSync(archive);
const manifest = {
  ...info,
  url: `${RELEASE}/lockin-update.tar.gz`,
  size: statSync(archive).size,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  dmg: `${RELEASE}/Lockin.dmg`,
};
writeFileSync(path.join("release", "update.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log("update", manifest);
