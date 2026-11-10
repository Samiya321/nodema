import assert from "node:assert/strict";
import test from "node:test";
import worker from "../dist/index.js";

test("returns only observed metadata and disables caching", async () => {
  const request = new Request("https://echo.example/", {
    headers: { "CF-Connecting-IP": "198.51.100.20" },
  });
  Object.defineProperty(request, "cf", {
    value: {
      country: "JP",
      asn: 64501,
      asOrganization: "Example Network",
      city: "not-exported",
    },
  });
  const response = await worker.fetch(request);
  assert.deepEqual(await response.json(), {
    ip: "198.51.100.20",
    country: "JP",
    asn: 64501,
    org: "Example Network",
  });
  assert.match(response.headers.get("Cache-Control"), /no-store/);
});
test("does not accept forwarding URLs", async () => {
  const response = await worker.fetch(
    new Request("https://echo.example/?url=https://private.example"),
  );
  assert.equal(response.status, 404);
});
test("missing real platform metadata fails explicitly", async () => {
  assert.equal(
    (await worker.fetch(new Request("https://echo.example/"))).status,
    503,
  );
});
