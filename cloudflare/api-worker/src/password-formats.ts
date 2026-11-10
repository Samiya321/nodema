import { SafeError } from "./crypto.js";
import type { Identity } from "./formats.js";
type Row = Record<string, unknown>;
const ciphers = new Set([
  "aes-128-gcm",
  "aes-192-gcm",
  "aes-256-gcm",
  "chacha20-ietf-poly1305",
  "xchacha20-ietf-poly1305",
  "2022-blake3-aes-128-gcm",
  "2022-blake3-aes-256-gcm",
  "2022-blake3-chacha20-poly1305",
  "none",
]);
const reject = (): never => {
  throw new SafeError("RUNTIME_UNSUPPORTED");
};
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return reject();
  return value as Row;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) return reject();
  return value;
}
function keys(value: Row, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k))) reject();
}
function pluginString(value: unknown): string {
  const plugin = object(value),
    options = object(plugin.options);
  keys(plugin, ["name", "options"]);
  const escape = (v: unknown) => String(v).replace(/[\\;=:]/g, "\\$&");
  const parts = [String(plugin.name)];
  for (const k of Object.keys(options).sort()) {
    const v = options[k];
    if (v === false || !["string", "boolean"].includes(typeof v)) reject();
    parts.push(escape(k) + (v === true ? "" : "=" + escape(v)));
  }
  return parts.join(";");
}
function pluginProxy(value: unknown): [string, Row] {
  const p = object(value),
    o = object(p.options ?? {});
  keys(p, ["name", "options"]);
  if (p.name === "obfs-local") {
    keys(o, ["obfs", "obfs-host"]);
    if (!["http", "tls"].includes(String(o.obfs))) reject();
    return [
      "obfs",
      Object.fromEntries(
        Object.entries(o).map(([k, v]) => [k === "obfs" ? "mode" : "host", v]),
      ),
    ];
  }
  if (p.name === "v2ray-plugin") {
    keys(o, ["tls", "host", "path", "mux"]);
    if (["tls", "mux"].some((k) => k in o && typeof o[k] !== "boolean"))
      reject();
    return ["v2ray-plugin", { mode: "websocket", ...o }];
  }
  return reject();
}
function tlsProxy(t: Row, security: string): Row {
  keys(t, ["sni", "alpn", "client_fingerprint", "insecure", "reality"]);
  const out: Row = {};
  for (const [a, b] of [
    ["sni", "sni"],
    ["alpn", "alpn"],
    ["client_fingerprint", "client-fingerprint"],
    ["insecure", "skip-cert-verify"],
  ])
    if (a in t) out[b] = t[a];
  if ("reality" in t) {
    const r = object(t.reality);
    keys(r, ["public_key", "short_id"]);
    if (security !== "reality" || !r.public_key) reject();
    out["reality-opts"] = Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k.replaceAll("_", "-"), v]),
    );
  } else if (security === "reality") reject();
  return out;
}
function transportProxy(o: Row, transport: string): Row {
  keys(o, ["host", "path", "service_name", "headers", "header_type"]);
  if (
    o.header_type !== undefined &&
    o.header_type !== "" &&
    o.header_type !== "none"
  )
    reject();
  if (transport === "ws") {
    if ("service_name" in o) reject();
    const headers = { ...(o.headers ? object(o.headers) : {}) };
    if ("host" in o) headers.Host = o.host;
    return {
      "ws-opts": {
        ...("path" in o ? { path: o.path } : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      },
    };
  }
  if (transport === "grpc") {
    if (
      Object.keys(o).some((k) => !["service_name", "header_type"].includes(k))
    )
      reject();
    return {
      "grpc-opts":
        "service_name" in o ? { "grpc-service-name": o.service_name } : {},
    };
  }
  if (Object.keys(o).some((k) => k !== "header_type")) reject();
  return {};
}
export function passwordProxy(d: Identity, name: string): Row {
  const protocol = d.protocol,
    p = d.protocol_options ?? {},
    t = d.tls ?? {},
    o = d.transport_options ?? {};
  const transport = d.transport ?? (protocol === "hysteria2" ? "quic" : "tcp"),
    security = d.security ?? (protocol === "shadowsocks" ? "none" : "tls");
  if (typeof d.password !== "string" || !d.password) reject();
  const out: Row = {
    name,
    type: protocol === "shadowsocks" ? "ss" : protocol,
    server: d.server_host,
    port: d.server_port,
    password: d.password,
  };
  if (p.allowed_network !== undefined && p.allowed_network !== "tcp") reject();
  if (p.allowed_network === "tcp") out.udp = false;
  if (protocol === "shadowsocks") {
    keys(p, ["cipher", "plugin", "allowed_network"]);
    if (
      transport !== "tcp" ||
      security !== "none" ||
      (Object.keys(t).length &&
        (Object.keys(t).length !== 1 || t.insecure !== false)) ||
      Object.keys(o).length ||
      !ciphers.has(String(p.cipher))
    )
      reject();
    if (Object.keys(t).length) out["skip-cert-verify"] = false;
    out.cipher = p.cipher;
    if ("plugin" in p) [out.plugin, out["plugin-opts"]] = pluginProxy(p.plugin);
  } else {
    if (
      !(protocol === "trojan" ? ["tls", "reality"] : ["tls"]).includes(security)
    )
      reject();
    Object.assign(out, tlsProxy(t, security));
    if (protocol === "trojan") {
      keys(p, ["allowed_network"]);
      if (!["tcp", "ws", "grpc"].includes(transport)) reject();
      out.network = transport;
      Object.assign(out, transportProxy(o, transport));
    } else if (protocol === "anytls") {
      keys(p, [
        "idle_check_seconds",
        "idle_timeout_seconds",
        "min_idle_session",
        "client_metadata",
        "allowed_network",
      ]);
      if (transport !== "tcp" || Object.keys(o).length) reject();
      for (const [a, b] of [
        ["idle_check_seconds", "idle-session-check-interval"],
        ["idle_timeout_seconds", "idle-session-timeout"],
        ["min_idle_session", "min-idle-session"],
        ["client_metadata", "client-metadata"],
      ]) {
        if (!(a in p)) continue;
        if (
          a !== "client_metadata" &&
          (!Number.isInteger(p[a]) || Number(p[a]) < 0 || Number(p[a]) > 86400)
        )
          reject();
        out[b] = p[a];
      }
    } else if (protocol === "hysteria2") {
      keys(p, [
        "server_ports",
        "hop_seconds",
        "up_mbps",
        "down_mbps",
        "obfs",
        "allowed_network",
      ]);
      if (
        transport !== "quic" ||
        Object.keys(o).length ||
        "client_fingerprint" in t
      )
        reject();
      if ("server_ports" in p) {
        if (!Array.isArray(p.server_ports)) reject();
        out.ports = list(p.server_ports).join(",");
      }
      for (const [a, b] of [
        ["hop_seconds", "hop-interval"],
        ["up_mbps", "up"],
        ["down_mbps", "down"],
      ])
        if (a in p) out[b] = p[a];
      if ("obfs" in p) {
        const obfs = object(p.obfs);
        keys(obfs, ["type", "password"]);
        if (
          obfs.type !== "salamander" ||
          typeof obfs.password !== "string" ||
          !obfs.password
        )
          reject();
        out.obfs = obfs.type;
        out["obfs-password"] = obfs.password;
      }
    } else reject();
  }
  for (const [dialect, extra] of Object.entries(d.extensions ?? {})) {
    if (dialect !== "clash") reject();
    keys(extra, [
      "udp",
      "tfo",
      "mptcp",
      "ip-version",
      "fingerprint",
      "name-cert-verify",
      "smux",
    ]);
    Object.assign(out, extra);
  }
  return out;
}
export function passwordSingbox(d: Identity, name: string): Row {
  passwordProxy(d, name);
  if (d.extensions && Object.keys(d.extensions).length) reject();
  if (d.protocol === "shadowsocks" && Object.keys(d.tls ?? {}).length) reject();
  const protocol = d.protocol,
    p = d.protocol_options ?? {},
    t = d.tls ?? {};
  const out: Row = {
    type: protocol,
    tag: name,
    server: d.server_host,
    server_port: d.server_port,
    password: d.password,
  };
  if (protocol === "shadowsocks") {
    out.method = p.cipher;
    if ("plugin" in p) {
      const plugin = pluginString(p.plugin),
        index = plugin.indexOf(";");
      out.plugin = index < 0 ? plugin : plugin.slice(0, index);
      out.plugin_opts = index < 0 ? "" : plugin.slice(index + 1);
    }
  } else {
    const tls: Row = { enabled: true };
    for (const [a, b] of [
      ["sni", "server_name"],
      ["alpn", "alpn"],
      ["insecure", "insecure"],
    ])
      if (a in t) tls[b] = t[a];
    if ("client_fingerprint" in t)
      tls.utls = { enabled: true, fingerprint: t.client_fingerprint };
    if ("reality" in t) tls.reality = { enabled: true, ...object(t.reality) };
    out.tls = tls;
    if (protocol === "trojan" && (d.transport ?? "tcp") !== "tcp") {
      const o = d.transport_options ?? {},
        transport: Row = { type: d.transport };
      for (const k of ["path", "service_name"]) if (k in o) transport[k] = o[k];
      const headers = { ...(o.headers ? object(o.headers) : {}) };
      if ("host" in o) headers.Host = o.host;
      if (Object.keys(headers).length) transport.headers = headers;
      out.transport = transport;
    } else if (protocol === "anytls") {
      for (const [a, b] of [
        ["idle_check_seconds", "idle_session_check_interval"],
        ["idle_timeout_seconds", "idle_session_timeout"],
        ["min_idle_session", "min_idle_session"],
        ["client_metadata", "client_metadata"],
      ])
        if (a in p) out[b] = a.endsWith("seconds") ? `${p[a]}s` : p[a];
    } else if (protocol === "hysteria2") {
      for (const k of ["up_mbps", "down_mbps", "obfs"])
        if (k in p) out[k] = p[k];
      if ("server_ports" in p) {
        if (!Array.isArray(p.server_ports)) reject();
        delete out.server_port;
        out.server_ports = list(p.server_ports).map((v) =>
          String(v).replaceAll("-", ":"),
        );
      }
      if ("hop_seconds" in p) out.hop_interval = `${p.hop_seconds}s`;
    }
  }
  if ("allowed_network" in p) {
    if (protocol === "anytls") reject();
    out.network = p.allowed_network;
  }
  return out;
}
export function passwordUri(d: Identity, name: string): string {
  passwordProxy(d, name);
  if (d.extensions && Object.keys(d.extensions).length) reject();
  if (d.protocol === "shadowsocks" && Object.keys(d.tls ?? {}).length) reject();
  const protocol = d.protocol,
    p = d.protocol_options ?? {},
    t = d.tls ?? {},
    o = d.transport_options ?? {};
  const host = d.server_host.includes(":")
    ? `[${d.server_host}]`
    : d.server_host;
  let authority = `${host}:${d.server_port}`,
    scheme: string = protocol;
  let auth = encodeURIComponent(d.password!);
  const query = new URLSearchParams();
  if (protocol === "shadowsocks") {
    keys(p, ["cipher", "plugin"]);
    auth = String(p.cipher).startsWith("2022-")
      ? `${encodeURIComponent(String(p.cipher))}:${auth}`
      : Buffer.from(`${p.cipher}:${d.password}`).toString("base64url");
    if ("plugin" in p) query.set("plugin", pluginString(p.plugin));
    scheme = "ss";
  } else {
    for (const [a, b] of [
      ["sni", "sni"],
      ["client_fingerprint", "fp"],
    ])
      if (a in t) query.set(b, String(t[a]));
    if ("alpn" in t) {
      if (!Array.isArray(t.alpn)) reject();
      query.set("alpn", list(t.alpn).join(","));
    }
    if ("insecure" in t) query.set("insecure", t.insecure ? "1" : "0");
    if (protocol === "trojan") {
      keys(p, []);
      query.set("type", d.transport ?? "tcp");
      query.set("security", d.security ?? "tls");
      for (const [a, b] of [
        ["host", "host"],
        ["path", "path"],
        ["service_name", "serviceName"],
      ])
        if (a in o) query.set(b, String(o[a]));
      if (o.headers) reject();
      if ("reality" in t) {
        const r = object(t.reality);
        for (const [a, b] of [
          ["public_key", "pbk"],
          ["short_id", "sid"],
        ])
          if (a in r) query.set(b, String(r[a]));
      }
    } else if (protocol === "anytls") keys(p, []);
    else if (protocol === "hysteria2") {
      keys(p, ["server_ports", "obfs"]);
      if ("server_ports" in p) {
        if (!Array.isArray(p.server_ports)) reject();
        authority = host + ":" + list(p.server_ports).join(",");
      }
      if ("obfs" in p) {
        const obfs = object(p.obfs);
        query.set("obfs", String(obfs.type));
        query.set("obfs-password", String(obfs.password));
      }
    }
  }
  return `${scheme}://${auth}@${authority}/${query.size ? "?" + query : ""}#${encodeURIComponent(name)}`;
}
