/**
 * Draws the .dmg window's background (build/background.png and @2x): cream, with a soft
 * glow in the icon's colours behind Lockin, an arrow to Applications, and the one thing
 * to know on first launch. Positions match package.json's "dmg" contents.
 * Run with `npx tsx scripts/make-dmg-background.mts`.
 */
import { writeFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";

const W = 660;
const H = 400;
const APP = { x: 180, y: 205 };
const APPS = { x: 480, y: 205 };

async function draw(scale: number, file: string) {
  const c = createCanvas(W * scale, H * scale);
  const g = c.getContext("2d");
  g.scale(scale, scale);

  g.fillStyle = "#f7f3ea";
  g.fillRect(0, 0, W, H);
  // The icon's glow, behind Lockin.
  const glow = g.createRadialGradient(APP.x, APP.y, 10, APP.x, APP.y, 190);
  glow.addColorStop(0, "rgba(236, 98, 64, 0.38)");
  glow.addColorStop(0.45, "rgba(240, 140, 90, 0.16)");
  glow.addColorStop(1, "rgba(240, 140, 90, 0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, W, H);

  g.fillStyle = "#37352f";
  g.textAlign = "center";
  g.font = "600 22px Inter";
  g.fillText("Drag Lockin into Applications", W / 2, 62);

  // A soft arrow between the two icons.
  g.strokeStyle = "rgba(55, 53, 47, 0.35)";
  g.lineWidth = 3;
  g.lineCap = "round";
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(APP.x + 82, APP.y);
  g.lineTo(APPS.x - 82, APPS.y);
  g.moveTo(APPS.x - 96, APPS.y - 14);
  g.lineTo(APPS.x - 82, APPS.y);
  g.lineTo(APPS.x - 96, APPS.y + 14);
  g.stroke();

  g.fillStyle = "rgba(55, 53, 47, 0.62)";
  g.font = "400 12.5px Inter";
  g.fillText("First time you open it, macOS can't verify Lockin (it isn't signed by Apple).", W / 2, H - 52);
  g.fillText("System Settings → Privacy & Security → Open Anyway — once. Updates never ask again.", W / 2, H - 33);

  await writeFile(file, await c.encode("png"));
}

await draw(1, "build/background.png");
await draw(2, "build/background@2x.png");
console.log("dmg background written");
