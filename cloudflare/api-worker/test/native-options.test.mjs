import assert from "node:assert/strict";
import { test } from "node:test";
import YAML from "yaml";
import { render } from "../dist/formats.js";

const node = { id: "synthetic", short_id: "N000001", name: "synthetic" };

test("Sub-Store Reality metadata preserves public key and short ID", () => {
  const identity = {
    protocol: "vless",
    server_host: "reality.example",
    server_port: 443,
    uuid: "00000000-0000-4000-8000-000000000001",
    security: "reality",
    tls: {
      reality: { public_key: "A".repeat(43), short_id: "0123456789abcdef" },
    },
    extensions: { clash: { "reality-opts": { "_spider-x": "/" } } },
  };
  const before = JSON.stringify(identity);
  const result = YAML.parse(render("mihomo", [{ node, identity }])).proxies[0];
  assert.deepEqual(result["reality-opts"], {
    "public-key": "A".repeat(43),
    "short-id": "0123456789abcdef",
    "_spider-x": "/",
  });
  assert.equal(JSON.stringify(identity), before);
  const bad = structuredClone(identity);
  bad.extensions.clash["reality-opts"]["public-key"] = "B".repeat(43);
  assert.throws(
    () => render("mihomo", [{ node, identity: bad }]),
    /RUNTIME_UNSUPPORTED/,
  );
});

test("SS verification false is kept in YAML and never silently dropped in other formats", () => {
  const identity = {
    protocol: "shadowsocks",
    server_host: "ss.example",
    server_port: 443,
    password: "synthetic",
    tls: { insecure: false },
    protocol_options: { cipher: "aes-128-gcm" },
  };
  assert.equal(
    YAML.parse(render("mihomo", [{ node, identity }])).proxies[0][
      "skip-cert-verify"
    ],
    false,
  );
  for (const format of ["singbox", "uri"])
    assert.throws(
      () => render(format, [{ node, identity }]),
      /RUNTIME_UNSUPPORTED/,
    );
  assert.throws(
    () =>
      render("mihomo", [
        { node, identity: { ...identity, tls: { insecure: true } } },
      ]),
    /RUNTIME_UNSUPPORTED/,
  );
});
