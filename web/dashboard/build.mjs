import {mkdir,copyFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../../app/web/",import.meta.url));
await mkdir(new URL("dist/assets/",import.meta.url),{recursive:true});
for(const name of ["index.html","app.js","style.css","favicon.svg"]){await copyFile(root+name,new URL("dist/"+(name==="index.html"?name:"assets/"+name),import.meta.url));}
await writeFile(new URL("dist/_headers",import.meta.url),`/*
  Cache-Control: no-store
  Referrer-Policy: no-referrer
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'
`);
