import assert from "node:assert/strict";
import { test } from "node:test";
import { deploymentFailures } from "../check-deployment.mjs";

const configured = {
  hyperdrive: [
    { binding: "HYPERDRIVE", id: "1234567890abcdef1234567890abcdef" },
  ],
  vars: {
    GITHUB_REPOSITORY: "synthetic-owner/repo",
    GITHUB_WORKFLOW_REF: "main",
  },
};

test("deployment precheck accepts JSONC comments and trailing commas", () => {
  const raw = `{
    // This is a legal Wrangler configuration.
    "hyperdrive": [{"binding":"HYPERDRIVE","id":"${configured.hyperdrive[0].id}",}],
    "vars": {"GITHUB_REPOSITORY":"synthetic-owner/repo","GITHUB_WORKFLOW_REF":"main",},
    "documentation": "https://example.invalid/a//b",
  }`;
  assert.deepEqual(deploymentFailures(raw), []);
  assert.deepEqual(deploymentFailures(JSON.stringify(configured)), []);
});

test("deployment precheck still rejects missing placeholders", () => {
  const raw = JSON.stringify({
    hyperdrive: [{ binding: "HYPERDRIVE", id: "0".repeat(32) }],
    vars: {},
  });
  assert.equal(deploymentFailures(raw).length, 3);
});

test("deployment precheck rejects malformed JSONC and non-object roots", () => {
  for (const raw of [
    "",
    "null",
    "[]",
    "1",
    "false",
    "{invalid}",
    "{} trailing",
    "/* incomplete",
  ])
    assert.deepEqual(deploymentFailures(raw), [
      "wrangler.jsonc 格式无效，请检查配置文件。",
    ]);
});

test("deployment errors never echo configuration values or raw exceptions", () => {
  const values = {
    hyperdrive: [
      null,
      false,
      { binding: "HYPERDRIVE", id: { secret: "synthetic-secret" } },
    ],
    vars: { GITHUB_REPOSITORY: "synthetic-secret", GITHUB_WORKFLOW_REF: 123 },
  };
  const errors = deploymentFailures(JSON.stringify(values));
  assert.equal(errors.length, 3);
  assert.ok(!JSON.stringify(errors).includes("synthetic-secret"));
  assert.equal(
    deploymentFailures(JSON.stringify({ hyperdrive: {}, vars: false })).length,
    3,
  );
});
