import { cp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../app/web/", import.meta.url));
const dist = new URL("dist/", import.meta.url);
await rm(new URL("assets/", dist), { recursive: true, force: true });
await mkdir(new URL("assets/", dist), { recursive: true });
await copyFile(root + "index.html", new URL("index.html", dist));
for (const name of ["style.css", "favicon.svg"])
  await copyFile(root + name, new URL("assets/" + name, dist));
// ES modules are loaded from /assets/js/ without a bundler.
await cp(root + "js", fileURLToPath(new URL("assets/js", dist)), { recursive: true });
await writeFile(
  new URL("_headers", dist),
  `/*
  Cache-Control: no-store
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
`,
);
