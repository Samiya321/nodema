import { createHmac, timingSafeEqual } from "node:crypto";
import { token } from "./crypto.js";

const COOKIE_NAME = "__Host-nodema_session";
const LIFETIME = 8 * 60 * 60;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function signature(password: string, origin: string, payload: string): Buffer {
  return createHmac("sha256", password)
    .update(`nodema:dashboard-session:v1\n${origin}\n${payload}`)
    .digest();
}

export function sessionCookie(value: string, clear = false): string {
  return `${COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict${clear ? "; Max-Age=0" : ""}`;
}

export function issueSession(password: string, origin: string) {
  const payload = `${nowSeconds() + LIFETIME}.${token()}`;
  return {
    cookie: sessionCookie(`${payload}.${signature(password, origin, payload).toString("base64url")}`),
    expiresIn: LIFETIME,
  };
}

export function sessionSeconds(request: Request, password: string, origin: string): number {
  const parts = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(COOKIE_NAME + "="));
  if (parts.length !== 1) return 0;
  const value = parts[0].slice(COOKIE_NAME.length + 1);
  const match = /^(\d{1,10}\.[A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) return 0;
  const [, payload, supplied] = match;
  const expiresIn = Number(payload.split(".")[0]) - nowSeconds();
  if (expiresIn <= 0 || expiresIn > LIFETIME) return 0;
  const received = Buffer.from(supplied);
  const expected = Buffer.from(signature(password, origin, payload).toString("base64url"));
  return timingSafeEqual(received, expected) ? expiresIn : 0;
}
