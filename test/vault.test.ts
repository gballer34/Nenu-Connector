/**
 * Dependency-free smoke test for the vault's scope enforcement and ledger.
 * Run with:  node --experimental-strip-types test/vault.test.ts
 */
import assert from "node:assert/strict";
import {
  buildApprovedBrief,
  getCandidateBrief,
  getLedger,
  revoke,
  _resetLedger,
} from "../src/vault.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

_resetLedger();

test("blocked fields are never offered to the host", () => {
  const brief = getCandidateBrief("travel");
  const keys = brief.fields.map((f) => f.key);
  assert.ok(!keys.includes("payment_card"), "payment_card (blocked) must be hidden");
  assert.ok(keys.includes("seat_preference"));
});

test("high-sensitivity values are masked (URL mode) in the candidate brief", () => {
  const brief = getCandidateBrief("travel");
  const passport = brief.fields.find((f) => f.key === "passport_number")!;
  assert.equal(passport.masked, true);
  assert.equal(passport.value, null, "raw high-sensitivity value must not leave the vault");
  const seat = brief.fields.find((f) => f.key === "seat_preference")!;
  assert.equal(seat.masked, false);
  assert.equal(seat.value, "Aisle, exit row when available");
});

test("approving normal fields returns values and logs the ledger", () => {
  _resetLedger();
  const brief = buildApprovedBrief("travel", ["seat_preference", "dietary"]);
  assert.equal(brief.fields.length, 2);
  assert.equal(brief.urlModeFields.length, 0);
  assert.equal(getLedger().length, 2);
  assert.ok(brief.text.includes("Aisle"));
  assert.ok(brief.ledger.every((r) => r.channel === "host"));
});

test("approving a high-sensitivity field shares via nenu.co, not the host", () => {
  _resetLedger();
  const brief = buildApprovedBrief("travel", ["passport_number"]);
  assert.equal(brief.fields.length, 0, "no raw value crosses the host");
  assert.equal(brief.urlModeFields.length, 1);
  assert.equal(brief.ledger[0].channel, "nenu_url");
  assert.ok(brief.text.toLowerCase().includes("nenu.co"));
});

test("vault gate is authoritative: approving a blocked field throws", () => {
  assert.throws(
    () => buildApprovedBrief("travel", ["payment_card"]),
    /blocked by vault scope/,
  );
});

test("edits override stored values for permitted fields", () => {
  _resetLedger();
  const brief = buildApprovedBrief("travel", ["seat_preference"], {
    seat_preference: "Window only",
  });
  assert.equal(brief.fields[0].value, "Window only");
});

test("declining shares nothing", () => {
  _resetLedger();
  const brief = buildApprovedBrief("travel", []);
  assert.equal(brief.fields.length, 0);
  assert.equal(getLedger().length, 0);
  assert.ok(brief.text.toLowerCase().includes("declined"));
});

test("revoke marks a ledger record revoked", () => {
  _resetLedger();
  const brief = buildApprovedBrief("travel", ["seat_preference"]);
  const id = brief.ledger[0].id;
  assert.equal(revoke(id), true);
  assert.equal(revoke("nope"), false);
  assert.equal(getLedger().find((r) => r.id === id)!.revoked, true);
});

console.log(`\n${passed} tests passed.`);
