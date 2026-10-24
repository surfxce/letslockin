/**
 * Writes the Sparkle appcast (release/appcast.xml) for the Swift app's .dmg: one item
 * for the build just made, with the EdDSA signature sign_update printed. The appcast is
 * published beside the .dmg on the mac-latest release, which is where the app's
 * SUFeedURL points.
 *
 *   node scripts/sparkle-appcast.mjs \
 *     --dmg release/Lockin.dmg --signature "<sign_update output>" \
 *     --version 0.1.0 --build 42 --min-system 14.0 [--out release/appcast.xml]
 */
import { readFileSync, writeFileSync } from "node:fs";

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dmg = arg("dmg");
const signatureLine = arg("signature");
const version = arg("version");
const build = arg("build");
const minSystem = arg("min-system") ?? "14.0";
const out = arg("out") ?? "release/appcast.xml";

if (!dmg || !signatureLine || !version || !build) {
  console.error("usage: node scripts/sparkle-appcast.mjs --dmg <file> --signature <line> --version <v> --build <n>");
  process.exit(1);
}

// sign_update prints:  sparkle:edSignature="…" length="…" — pull the two out.
const signature = /sparkle:edSignature="([^"]+)"/.exec(signatureLine)?.[1];
const length = /length="(\d+)"/.exec(signatureLine)?.[1];
if (!signature || !length) {
  console.error(`could not read a signature out of: ${signatureLine.slice(0, 80)}…`);
  process.exit(1);
}

const size = readFileSync(dmg).length;
if (Number(length) !== size) {
  console.error(`sign_update said ${length} bytes but ${dmg} is ${size} — the archive changed after signing`);
  process.exit(1);
}

const url = "https://github.com/surfxce/letslockin/releases/download/mac-latest/Lockin.dmg";
const now = new Date().toUTCString();
const notes = `Built from ${process.env.GITHUB_SHA?.slice(0, 7) ?? "the latest sources"}. Open Lockin.dmg and drag Lockin into Applications.`;

const appcast = `<?xml version="1.0" standalone="yes"?>
<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>Lockin</title>
    <link>${url.replace("Lockin.dmg", "appcast.xml")}</link>
    <description>Lockin for Mac, latest build</description>
    <language>en</language>
    <item>
      <title>Version ${version} (build ${build})</title>
      <pubDate>${now}</pubDate>
      <sparkle:version>${build}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>${minSystem}</sparkle:minimumSystemVersion>
      <description><![CDATA[
        <p>${notes}</p>
      ]]></description>
      <enclosure url="${url}" length="${length}" type="application/x-bzip2" sparkle:edSignature="${signature}"/>
    </item>
  </channel>
</rss>
`;

writeFileSync(out, appcast);
console.log(`appcast written to ${out}: version ${version}, build ${build}, ${length} bytes`);
