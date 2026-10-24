import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { fromBase64Url, open, replyAad, requestAad, seal } from "./crypto";
import { PhoneSnapshotSchema, SyncRequestSchema } from "./schema";
import { imageRefs } from "./snapshot";

const fixtures = path.join(__dirname, "..", "..", "ios", "LockinKit", "Tests", "LockinKitTests", "Fixtures");
const fixture = (name: string) => JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));

describe("the sealed channel", () => {
  const v = fixture("crypto-vector.json");
  const key = fromBase64Url(v.keyBase64Url);

  it("matches the vector the iPhone app is tested against, byte for byte", () => {
    const sealed = seal(key, Buffer.from(v.plaintext, "utf8"), v.aad, Buffer.from(v.nonceHex, "hex"));
    expect(sealed.toString("hex")).toBe(v.sealedHex);
    expect(open(key, Buffer.from(v.sealedHex, "hex"), v.aad)?.toString("utf8")).toBe(v.plaintext);
  });

  it("refuses a message that was changed, sealed for something else, or with another key", () => {
    const sealed = Buffer.from(v.sealedHex, "hex");
    const changed = Buffer.from(sealed);
    changed[20] ^= 1;
    expect(open(key, changed, v.aad)).toBeNull();
    expect(open(key, sealed, requestAad("slide", "pairing-0001"))).toBeNull();
    expect(open(Buffer.alloc(32, 7), sealed, v.aad)).toBeNull();
    expect(open(key, sealed.subarray(0, 20), v.aad)).toBeNull();
  });

  it("binds requests and replies to what they are for", () => {
    expect(requestAad("sync", "abc")).toBe("lockin/1 request sync abc");
    expect(replyAad("slide", "r1")).toBe("lockin/1 reply slide r1");
  });
});

describe("the protocol's shapes", () => {
  it("accepts the snapshot fixture the iPhone app decodes", () => {
    const parsed = PhoneSnapshotSchema.safeParse(fixture("snapshot.json"));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("accepts the sync request fixture the iPhone app encodes", () => {
    const parsed = SyncRequestSchema.safeParse(fixture("sync-request.json"));
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    expect(parsed.data?.reviews[0].rating).toBe(3);
  });

  it("refuses ids and ratings that could do harm", () => {
    expect(SyncRequestSchema.safeParse({ reviews: [{ id: "x/../y", cardId: "c", version: 0, rating: 3, reviewedAt: "2026-01-01T00:00:00Z" }] }).success).toBe(false);
    expect(SyncRequestSchema.safeParse({ reviews: [{ id: "review01", cardId: "card0001", version: 0, rating: 9, reviewedAt: "2026-01-01T00:00:00Z" }] }).success).toBe(false);
  });
});

describe("picture references", () => {
  it("lists a lecture's own slide pictures, crops and all, and nothing else", () => {
    const html =
      '<img src="lockin-slide://L1/3?crop=0.1,0.2,0.5,0.4" alt="a"><img src="lockin-slide://L1/5" alt="b">' +
      '<img src="lockin-slide://L2/9" alt="c"><img src="https://example.com/x.png" alt="d">';
    expect(imageRefs(html, "L1")).toEqual(["3?crop=0.1,0.2,0.5,0.4", "5"]);
  });
});
