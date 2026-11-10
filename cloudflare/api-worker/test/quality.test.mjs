import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePolicy, validateAnnotation } from "../dist/quality.js";
import { filtersFromParams } from "../dist/catalog.js";

test("reference-policy validation never accepts fabricated mainland facts", () => {
  for (const value of [
    null,
    [],
    { secret: "private" },
    { min_samples: true },
    { min_samples: 8 },
    { poor_success_rate: NaN },
    { preferred_entry_asns: [true] },
    { preferred_entry_countries: ["hk"] },
    { preferred_protocols: ["other"] },
    { preferred_protocols: null },
    { operator_preferences: { CT: { preferred_entry_asns: null } } },
    { operator_preferences: { CT: { secret: "private" } } },
  ])
    assert.throws(() => validatePolicy(value), /INVALID_QUALITY_POLICY/);
  for (const value of [
    { tags: ["https://private.example/secret"] },
    { line_claim: ["IPLC"] },
    { evidence_level: "VERIFIED" },
    { operators: [] },
    { reference: "private\r\nsecret" },
    { reference: 123 },
    { reference: "private\x7f" },
    { mainland_reachability: "UP" },
  ])
    assert.throws(() => validateAnnotation(value), /INVALID_NODE_ANNOTATION/);
  assert.deepEqual(
    validatePolicy({ preferred_entry_countries: ["JP", "HK", "JP"] })
      .preferred_entry_countries,
    ["HK", "JP"],
  );
});

test("query parameters retain boolean and tag semantics", () => {
  assert.deepEqual(
    filtersFromParams(
      new URLSearchParams("eligible=false&tags=a,b&operator=CT&sort=grade:asc"),
    ),
    { eligible: false, tags: ["a", "b"], operator: "CT" },
  );
  assert.throws(
    () => filtersFromParams(new URLSearchParams("eligible=maybe")),
    /INVALID_NODE_QUERY/,
  );
  assert.throws(
    () => filtersFromParams(new URLSearchParams("secret=private")),
    /INVALID_NODE_QUERY/,
  );
});
