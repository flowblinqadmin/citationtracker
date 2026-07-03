// Unit tests for _shared/ip-hash.ts.
//
// Verifies the HMAC-SHA256 ip-hash helper closes the ES-090 §b.1 COMP-2 gap:
// dormant ipHash column on geoPageViews / geoCrawlLogs starts getting written
// by every beacon insert.

import { assertEquals, assertMatch, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { hmacSha256Hex, hashIp } from "../ip-hash.ts";

Deno.test("ip-hash: produces 64 lowercase hex chars", async () => {
  const h = await hmacSha256Hex("test-secret", "1.2.3.4");
  assertMatch(h, /^[0-9a-f]{64}$/);
  assertEquals(h.length, 64);
});

Deno.test("ip-hash: deterministic for same (secret, input)", async () => {
  const a = await hmacSha256Hex("s", "10.0.0.1");
  const b = await hmacSha256Hex("s", "10.0.0.1");
  assertEquals(a, b);
});

Deno.test("ip-hash: different IPs produce different hashes", async () => {
  const a = await hmacSha256Hex("s", "10.0.0.1");
  const b = await hmacSha256Hex("s", "10.0.0.2");
  assertNotEquals(a, b);
});

Deno.test("ip-hash: secret rotation invalidates prior pseudonymization", async () => {
  // Two different secrets → different output for the same IP. This is the
  // documented rotation behavior: the column becomes non-correlatable across
  // a rotation, by design.
  const a = await hmacSha256Hex("secret-v1", "10.0.0.1");
  const b = await hmacSha256Hex("secret-v2", "10.0.0.1");
  assertNotEquals(a, b);
});

Deno.test("ip-hash: matches RFC 4231 test vector for HMAC-SHA256", async () => {
  // RFC 4231 Test Case 1: key=0x0b*20, data="Hi There"
  // Expected: b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
  // We pass the raw bytes as a binary string via TextDecoder("latin1") so
  // the hex encodings match the canonical test vector.
  const key = String.fromCharCode(...new Uint8Array(20).fill(0x0b));
  const data = "Hi There";
  const h = await hmacSha256Hex(key, data);
  assertEquals(
    h,
    "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
  );
});

Deno.test("hashIp: reads IP_HASH_SECRET from env", async () => {
  const prev = Deno.env.get("IP_HASH_SECRET");
  Deno.env.set("IP_HASH_SECRET", "unit-test-secret");
  try {
    const h = await hashIp("1.2.3.4");
    assertMatch(h ?? "", /^[0-9a-f]{64}$/);
    // Determinism check using the secret we just set
    const h2 = await hmacSha256Hex("unit-test-secret", "1.2.3.4");
    assertEquals(h, h2);
  } finally {
    if (prev !== undefined) Deno.env.set("IP_HASH_SECRET", prev);
    else Deno.env.delete("IP_HASH_SECRET");
  }
});

Deno.test("hashIp: returns null when ip is null/empty", async () => {
  Deno.env.set("IP_HASH_SECRET", "unit-test-secret");
  assertEquals(await hashIp(null), null);
  assertEquals(await hashIp(""), null);
});

Deno.test("hashIp: returns null when IP_HASH_SECRET is unset", async () => {
  const prev = Deno.env.get("IP_HASH_SECRET");
  Deno.env.delete("IP_HASH_SECRET");
  try {
    // Falsy secret should not crash the beacon — return null and let the
    // insert proceed with ipHash=null. We log a warning so operations
    // notices the misconfiguration.
    const h = await hashIp("1.2.3.4");
    assertEquals(h, null);
  } finally {
    if (prev !== undefined) Deno.env.set("IP_HASH_SECRET", prev);
  }
});
