/**
 * Builds the app icons from build/icon-source.webp (square artwork):
 *   build/icon.png   1024² in the macOS shape — the artwork in a rounded square,
 *                    inset as Apple's template has it, with a soft shadow
 *   build/icon.icns  the same at every size macOS asks for
 *   app/icon.png     the browser tab's icon
 * Run with `npx tsx scripts/make-icon.mts` after changing the artwork.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createCanvas, loadImage, type Image } from "@napi-rs/canvas";

const art = await loadImage(await readFile("build/icon-source.webp"));

function draw(size: number, image: Image, framed: boolean) {
  const c = createCanvas(size, size);
  const g = c.getContext("2d");
  const inset = framed ? size * (100 / 1024) : 0;
  const side = size - inset * 2;
  const r = framed ? side * 0.225 : size * 0.2;
  const shape = () => {
    g.beginPath();
    g.roundRect(inset, inset, side, side, r);
  };
  if (framed) {
    g.save();
    g.shadowColor = "rgba(0,0,0,0.28)";
    g.shadowBlur = size * 0.03;
    g.shadowOffsetY = size * 0.01;
    shape();
    g.fillStyle = "#f7f3ea";
    g.fill();
    g.restore();
  }
  g.save();
  shape();
  g.clip();
  g.drawImage(image, inset, inset, side, side);
  g.restore();
  return c.encode("png");
}

const master = await draw(1024, art, true);
await writeFile("build/icon.png", master);
await writeFile("app/icon.png", await draw(256, art, false));

// ICNS: "icns", total length, then [type, length, PNG] for each size.
const sizes: Array<[string, number]> = [
  ["icp4", 16], ["icp5", 32], ["icp6", 64], ["ic07", 128], ["ic08", 256], ["ic09", 512], ["ic10", 1024],
  ["ic11", 32], ["ic12", 64], ["ic13", 256], ["ic14", 512],
];
const framedMaster = await loadImage(master);
const parts: Buffer[] = [];
for (const [type, px] of sizes) {
  const c = createCanvas(px, px);
  c.getContext("2d").drawImage(framedMaster, 0, 0, px, px);
  const png = await c.encode("png");
  const head = Buffer.alloc(8);
  head.write(type, 0, "ascii");
  head.writeUInt32BE(png.length + 8, 4);
  parts.push(head, png);
}
const body = Buffer.concat(parts);
const head = Buffer.alloc(8);
head.write("icns", 0, "ascii");
head.writeUInt32BE(body.length + 8, 4);
await writeFile("build/icon.icns", Buffer.concat([head, body]));
console.log("icons written");
