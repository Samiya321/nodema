import assert from "node:assert/strict";
import test from "node:test";
import { handle } from "../dist/index.js";

const origin = "https://dashboard.example";
const env = {
  ADMIN_PASSWORD: "synthetic-admin-key-for-browser-tests",
  MONITOR_TOKEN: "synthetic-monitor-key-for-browser-tests",
};
const authorization = `Bearer ${env.ADMIN_PASSWORD}`;

function request(path, { method = "GET", headers, host = origin } = {}, connect) {
  return handle(new Request(host + path, { method, headers }), env, connect);
}

test("Dashboard login is independent of PostgreSQL and uses a scoped session cookie", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const connect = t.mock.fn(async () => { throw new Error("no database"); });
  const session = (options) => request("/api/session", options, connect);

  assert.equal((await session()).status, 401);
  const invalid = await session({ method: "POST", headers: { Origin: origin, Authorization: "Bearer invalid" } });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error_code, "INVALID_ADMIN_TOKEN");
  assert.equal(invalid.headers.get("Set-Cookie"), null);
  assert.equal((await session({ method: "POST", headers: { Authorization: authorization } })).status, 403);

  const login = await session({ method: "POST", headers: { Origin: origin, Authorization: authorization } });
  assert.equal(login.status, 200);
  assert.equal(login.headers.get("Cache-Control"), "no-store");
  const cookie = login.headers.get("Set-Cookie");
  assert.match(cookie, /^__Host-nodema_session=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
  const Cookie = cookie.split(";")[0];
  const expiresIn = (await login.json()).expires_in;
  assert.equal(expiresIn, 8 * 60 * 60);
  assert.equal((await session({ headers: { Cookie } })).status, 200);
  assert.equal((await session({ headers: { Cookie }, host: "https://preview.example" })).status, 401);
  const modified = Cookie.slice(0, -1) + (Cookie.endsWith("A") ? "B" : "A");
  assert.equal((await session({ headers: { Cookie: modified } })).status, 401);
  assert.equal((await session({ method: "DELETE", headers: { Cookie } })).status, 403);
  const logout = await session({ method: "DELETE", headers: { Origin: origin, Cookie } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("Set-Cookie"), /^__Host-nodema_session=; .*Max-Age=0$/);
  now += expiresIn * 1000;
  assert.equal((await session({ headers: { Cookie } })).status, 401);
  assert.equal(connect.mock.callCount(), 0);
});

test("Cookie writes require the same origin and Bearer clients still reach the API", async (t) => {
  const login = await request("/api/session", { method: "POST", headers: { Origin: origin, Authorization: authorization } });
  const Cookie = login.headers.get("Set-Cookie").split(";")[0];
  const connect = t.mock.fn(async () => ({ end: async () => {} }));
  assert.equal((await request("/api/missing", { headers: { Cookie } }, connect)).status, 404);
  assert.equal((await request("/api/missing", { method: "POST", headers: { Cookie, Origin: "https://other.example" } }, connect)).status, 403);
  assert.equal((await request("/api/missing", { method: "POST", headers: { Cookie, Origin: origin } }, connect)).status, 404);
  assert.equal((await request("/api/missing", { method: "POST", headers: { Authorization: authorization } }, connect)).status, 404);
  assert.equal((await request("/api/missing", { headers: { Cookie, Authorization: "Bearer invalid" } }, connect)).status, 401);
  assert.equal((await request("/api/missing", { headers: { Authorization: `Bearer ${env.MONITOR_TOKEN}` } }, connect)).status, 401);
  assert.equal(connect.mock.callCount(), 3);
});
