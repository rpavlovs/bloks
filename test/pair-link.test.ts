// Pairing through the relay: a link a headless computer prints, spent once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "bloks-pairlink-"));
let pairing: typeof import("../server/pairing.ts");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

before(async () => {
  process.env.HOME = home;
  mkdirSync(join(home, ".bloks"), { recursive: true });
  pairing = await import("../server/pairing.ts");
});
after(() => rmSync(home, { recursive: true, force: true }));

test("a link keeps only its secret's digest and pairs one device, once", () => {
  const { id, secret } = pairing.createPairLink();
  assert.ok(id.startsWith("pair_"));
  assert.equal(pairing.pairLinkSecret(id), digest(secret));
  const device = pairing.claimPairLink(id, "Laptop", digest("device token"));
  assert.ok(device);
  assert.equal(device!.name, "Laptop");
  // the device is recognised by its token, which never crossed the relay
  assert.equal(pairing.deviceForToken("device token")?.id, device!.id);
  // spent
  assert.equal(pairing.pairLinkSecret(id), null);
  assert.equal(pairing.claimPairLink(id, "Someone else", digest("other")), null);
});

test("an expired link opens nothing", () => {
  const { id } = pairing.createPairLink(-1);
  assert.equal(pairing.pairLinkSecret(id), null);
  assert.equal(pairing.claimPairLink(id, "Late", digest("x")), null);
});

test("a link made by another Bloks on the same folder can be spent here", () => {
  // The app and bloks-server often share one ~/.bloks. \`bloks-server pair\`
  // asks one of them for the link while the relay hands the claim to the
  // other, and a link known only in memory read as "already used".
  const file = join(home, ".bloks", "pair-links.json");
  const secret = "made-by-the-other-process";
  const id = "pair_otherprocess1";
  const existing = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify([...existing, { id, secretHash: digest(secret), expiresAt: Date.now() + 60_000 }]));
  assert.equal(pairing.pairLinkSecret(id), digest(secret));
  assert.ok(pairing.claimPairLink(id, "Phone", digest("phone token")));
  // spent for everyone sharing the folder, not just this process
  assert.equal(JSON.parse(readFileSync(file, "utf8")).some((l: { id: string }) => l.id === id), false);
  // and the file holds digests only, never a link's secret
  const { secret: kept } = pairing.createPairLink();
  assert.equal(readFileSync(file, "utf8").includes(kept), false);
});

test("only a real digest is accepted as the device's", () => {
  const { id } = pairing.createPairLink();
  assert.equal(pairing.claimPairLink(id, "Bad", "not-a-digest"), null);
  // a refusal for a malformed digest does not spend the link
  assert.ok(pairing.pairLinkSecret(id));
});

test("a headless server listens on loopback and treats the relay as its door", () => {
  process.env.BLOKS_LOOPBACK_ONLY = "1";
  try {
    assert.equal(pairing.bindHost(), "127.0.0.1");
    assert.equal(pairing.remoteEnabled(), true);
  } finally {
    delete process.env.BLOKS_LOOPBACK_ONLY;
  }
  assert.equal(pairing.remoteEnabled(), false);
});
