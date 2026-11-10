import assert from "node:assert/strict";
import { test } from "node:test";
import YAML from "yaml";
import { render, ExportRenderer, MAX_EXPORT_BYTES } from "../dist/formats.js";

const identity = {
  protocol: "vless",
  server_host: "synthetic.example",
  server_port: 443,
  uuid: "00000000-0000-4000-8000-000000000001",
  security: "tls",
};
const node = { id: "synthetic", short_id: "N000001", name: "synthetic" };

test("incremental exports remain valid for empty and multiple items", () => {
  assert.deepEqual(YAML.parse(render("mihomo", [])), { proxies: [] });
  assert.deepEqual(JSON.parse(render("singbox", [])), { outbounds: [] });
  assert.deepEqual(JSON.parse(render("json", [])), []);
  for (const format of ["mihomo", "singbox", "uri", "json", "csv"]) {
    const items = ["first", "second"].map((name) => ({
      node: { ...node, name },
      identity,
    }));
    const payload = render(format, items);
    if (format === "mihomo")
      assert.deepEqual(
        YAML.parse(payload).proxies.map((p) => p.name),
        ["first", "second"],
      );
    else if (format === "singbox")
      assert.deepEqual(
        JSON.parse(payload).outbounds.map((p) => p.tag),
        ["first", "second"],
      );
    else if (format === "json")
      assert.deepEqual(
        JSON.parse(payload).map((p) => p.name),
        ["first", "second"],
      );
    else
      assert.equal(
        payload.trim().split(/\r?\n/).length,
        format === "csv" ? 3 : 2,
      );
  }
});

test("output limits count UTF-8 bytes during append, before an oversized result is retained", () => {
  const renderer = new ExportRenderer("json");
  const item = { node: { ...node, name: "界".repeat(10000) } };
  let appended = 0;
  assert.throws(() => {
    for (let i = 0; i < 1000; i++) {
      renderer.append(item);
      appended++;
    }
  }, /EXPORT_TOO_LARGE/);
  assert.ok(appended < 400 && appended > 300);
  assert.throws(
    () => new ExportRenderer("constructor"),
    /INVALID_EXPORT_FORMAT/,
  );
  assert.throws(
    () =>
      render("json", [
        { node: { ...node, name: "x".repeat(MAX_EXPORT_BYTES) } },
      ]),
    /EXPORT_TOO_LARGE/,
  );
  assert.ok(
    render("csv", [{ node: { ...node, name: "=1+1" } }]).includes('"\'=1+1"'),
  );
});
