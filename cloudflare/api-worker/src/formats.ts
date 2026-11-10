import YAML from "yaml";
import { SafeError } from "./crypto.js";
import {
  passwordProxy,
  passwordSingbox,
  passwordUri,
} from "./password-formats.js";
export type Identity = {
  protocol:
    "vless" | "vmess" | "shadowsocks" | "trojan" | "anytls" | "hysteria2";
  server_host: string;
  server_port: number;
  uuid?: string;
  password?: string;
  transport?: string;
  security?: string;
  tls?: Record<string, unknown>;
  transport_options?: Record<string, unknown>;
  protocol_options?: Record<string, unknown>;
  extensions?: Record<string, Record<string, unknown>>;
};
export type PublicNode = Record<string, unknown> & {
  id: string;
  name: string;
  short_id: string;
};
const reject = (): never => {
  throw new SafeError("RUNTIME_UNSUPPORTED");
};
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((k) => !allowed.includes(k))) reject();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return reject();
  return value as Record<string, unknown>;
}
export function proxy(d: Identity, name: string): Record<string, unknown> {
  if (d.protocol !== "vless" && d.protocol !== "vmess")
    return passwordProxy(d, name);
  const transport = d.transport ?? "tcp",
    security = d.security ?? "none",
    tls = d.tls ?? {},
    o = d.transport_options ?? {},
    p = d.protocol_options ?? {};
  if (
    !["vless", "vmess"].includes(d.protocol) ||
    !["tcp", "ws", "grpc"].includes(transport) ||
    !["none", "tls", "reality"].includes(security) ||
    (d.protocol === "vmess" && security === "reality")
  )
    reject();
  keys(tls, ["sni", "alpn", "client_fingerprint", "insecure", "reality"]);
  keys(o, ["host", "path", "service_name", "headers", "header_type"]);
  keys(p, ["flow", "encryption", "alter_id", "cipher", "allowed_network"]);
  if (
    o.header_type !== undefined &&
    o.header_type !== "" &&
    o.header_type !== "none"
  )
    reject();
  const out: Record<string, unknown> = {
    name,
    type: d.protocol,
    server: d.server_host,
    port: d.server_port,
    uuid: d.uuid,
    network: transport,
    tls: security !== "none",
  };
  for (const [a, b] of [
    ["sni", "servername"],
    ["alpn", "alpn"],
    ["client_fingerprint", "client-fingerprint"],
    ["insecure", "skip-cert-verify"],
  ])
    if (a in tls) out[b] = tls[a];
  if (tls.reality) {
    const r = object(tls.reality);
    keys(r, ["public_key", "short_id"]);
    if (security !== "reality" || !r.public_key) reject();
    out["reality-opts"] = Object.fromEntries(
      Object.entries(r).map(([k, v]) => [k.replaceAll("_", "-"), v]),
    );
  } else if (security === "reality") reject();
  if (transport === "ws") {
    const headers = { ...(o.headers ? object(o.headers) : {}) };
    if ("host" in o) headers.Host = o.host;
    out["ws-opts"] = {
      ...("path" in o ? { path: o.path } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  } else if (transport === "grpc") {
    if (["host", "path", "headers"].some((k) => k in o)) reject();
    out["grpc-opts"] =
      "service_name" in o ? { "grpc-service-name": o.service_name } : {};
  } else if (["host", "path", "headers", "service_name"].some((k) => k in o))
    reject();
  if (p.allowed_network !== undefined) {
    if (p.allowed_network !== "tcp") reject();
    out.udp = false;
  }
  for (const [a, b] of [
    ["flow", "flow"],
    ["encryption", "encryption"],
    ["alter_id", "alterId"],
    ["cipher", "cipher"],
  ])
    if (a in p) out[b] = p[a];
  if (d.protocol === "vmess") {
    out.alterId ??= 0;
    out.cipher ??= "auto";
  }
  for (const [dialect, extra] of Object.entries(d.extensions ?? {})) {
    if (dialect !== "clash") reject();
    const rest = { ...extra };
    if ("reality-opts" in rest) {
      const metadata = object(rest["reality-opts"]);
      keys(metadata, ["_spider-x"]);
      if (security !== "reality" || typeof metadata["_spider-x"] !== "string")
        reject();
      Object.assign(object(out["reality-opts"]), metadata);
      delete rest["reality-opts"];
    }
    keys(rest, [
      "udp",
      "packet-encoding",
      "smux",
      "global-padding",
      "authenticated-length",
      "tfo",
      "mptcp",
      "ip-version",
      "fingerprint",
      "name-cert-verify",
    ]);
    Object.assign(out, rest);
  }
  return out;
}
function singbox(d: Identity, name: string): Record<string, unknown> {
  if (d.protocol !== "vless" && d.protocol !== "vmess")
    return passwordSingbox(d, name);
  proxy(d, name);
  if (d.extensions && Object.keys(d.extensions).length) reject();
  const t = d.tls ?? {},
    o = d.transport_options ?? {},
    p = d.protocol_options ?? {},
    security = d.security ?? "none";
  const out: Record<string, unknown> = {
    type: d.protocol,
    tag: name,
    server: d.server_host,
    server_port: d.server_port,
    uuid: d.uuid,
  };
  if (security !== "none" || Object.keys(t).length) {
    const tls: Record<string, unknown> = { enabled: security !== "none" };
    for (const [a, b] of [
      ["sni", "server_name"],
      ["alpn", "alpn"],
      ["insecure", "insecure"],
    ])
      if (a in t) tls[b] = t[a];
    if ("client_fingerprint" in t)
      tls.utls = { enabled: true, fingerprint: t.client_fingerprint };
    if (t.reality) tls.reality = { enabled: true, ...object(t.reality) };
    out.tls = tls;
  }
  if ((d.transport ?? "tcp") !== "tcp") {
    const transport: Record<string, unknown> = { type: d.transport };
    for (const key of ["path", "service_name"])
      if (key in o) transport[key] = o[key];
    const headers = { ...(o.headers ? object(o.headers) : {}) };
    if ("host" in o) headers.Host = o.host;
    if (Object.keys(headers).length) transport.headers = headers;
    out.transport = transport;
  }
  if (d.protocol === "vless") {
    if (
      p.encryption !== undefined &&
      p.encryption !== "none" &&
      p.encryption !== ""
    )
      reject();
    if ("flow" in p) out.flow = p.flow;
  } else {
    out.security = p.cipher ?? "auto";
    out.alter_id = p.alter_id ?? 0;
  }
  if ("allowed_network" in p) out.network = p.allowed_network;
  return out;
}
function uri(d: Identity, name: string): string {
  if (d.protocol !== "vless" && d.protocol !== "vmess")
    return passwordUri(d, name);
  singbox(d, name);
  const t = d.tls ?? {},
    o = d.transport_options ?? {},
    p = d.protocol_options ?? {};
  if (o.headers || p.allowed_network !== undefined) reject();
  if (d.protocol === "vmess") {
    if (t.insecure !== undefined || o.service_name !== undefined) reject();
    const doc: Record<string, unknown> = {
      v: "2",
      ps: name,
      add: d.server_host,
      port: String(d.server_port),
      id: d.uuid,
      aid: String(p.alter_id ?? 0),
      scy: p.cipher ?? "auto",
      net: d.transport ?? "tcp",
      tls: d.security === "tls" ? "tls" : "",
    };
    for (const k of ["host", "path"]) if (k in o) doc[k] = o[k];
    if (t.sni !== undefined) doc.sni = t.sni;
    if (t.client_fingerprint !== undefined) doc.fp = t.client_fingerprint;
    if (Array.isArray(t.alpn)) doc.alpn = t.alpn.join(",");
    return "vmess://" + Buffer.from(JSON.stringify(doc)).toString("base64");
  }
  const query = new URLSearchParams({
    type: d.transport ?? "tcp",
    security: d.security ?? "none",
  });
  for (const [a, b] of [
    ["sni", "sni"],
    ["client_fingerprint", "fp"],
  ])
    if (a in t) query.set(b, String(t[a]));
  if (Array.isArray(t.alpn)) query.set("alpn", t.alpn.join(","));
  if ("insecure" in t) query.set("allowInsecure", t.insecure ? "1" : "0");
  for (const [a, b] of [
    ["public_key", "pbk"],
    ["short_id", "sid"],
  ]) {
    const r = t.reality ? object(t.reality) : {};
    if (a in r) query.set(b, String(r[a]));
  }
  for (const [a, b] of [
    ["host", "host"],
    ["path", "path"],
    ["service_name", "serviceName"],
  ])
    if (a in o) query.set(b, String(o[a]));
  for (const k of ["flow", "encryption"])
    if (k in p) query.set(k, String(p[k]));
  const host = d.server_host.includes(":")
    ? `[${d.server_host}]`
    : d.server_host;
  return `vless://${d.uuid}@${host}:${d.server_port}?${query}#${encodeURIComponent(name)}`;
}
export const formats: Record<string, [string, string]> = {
  mihomo: ["text/yaml", "yaml"],
  singbox: ["application/json", "json"],
  uri: ["text/plain", "txt"],
  json: ["application/json", "json"],
  csv: ["text/csv", "csv"],
};
const fields = [
  "first_seen_at",
  "age_days",
  "checked_days",
  "available_days",
  "lifetime_availability",
  "short_id",
  "name",
  "protocol",
  "server_host",
  "server_port",
  "status",
  "entry_country",
  "exit_country",
  "exit_asn",
  "http_duration_ms",
  "entry_asn",
  "grade",
  "confidence",
  "operator",
  "sample_count",
  "success_rate",
  "http_p50_ms",
  "http_p95_ms",
  "probe_key",
  "line_claim",
  "rule_version",
  "mainland_reachability",
  "timeout_rate",
  "evidence_level",
  "evidence_age_days",
  "evidence_updated_at",
];

export type ExportItem = { node: PublicNode; identity?: Identity };
export const MAX_EXPORT_BYTES = 10_485_760;
const reportFields = new Set([
  ...fields,
  "transport",
  "security",
  "exit_ip",
  "last_checked_at",
  "reasons",
  "tags",
]);
const csvEscape = (value: unknown) => {
  let valueText = String(value ?? "");
  if (/^[=+\-@\t\r]/.test(valueText)) valueText = "'" + valueText;
  return '"' + valueText.replaceAll('"', '""') + '"';
};

/** Bounded output, without retaining a complete collection of node identities. */
export class ExportRenderer {
  private parts: string[] = [];
  private bytes = 0;
  count = 0;

  constructor(private format: string) {
    if (!Object.hasOwn(formats, format))
      throw new SafeError("INVALID_EXPORT_FORMAT");
    this.push(
      format === "json"
        ? "["
        : format === "singbox"
          ? '{"outbounds":['
          : format === "mihomo"
            ? "proxies:\n"
            : format === "csv"
              ? "\ufeff" + fields.join(",") + "\r\n"
              : "",
    );
  }

  private push(part: string) {
    this.bytes += new TextEncoder().encode(part).byteLength;
    if (this.bytes > MAX_EXPORT_BYTES) throw new SafeError("EXPORT_TOO_LARGE");
    this.parts.push(part);
  }

  append({ node, identity }: ExportItem) {
    let part: string;
    if (this.format === "json") {
      part =
        (this.count ? "," : "") +
        JSON.stringify(
          Object.fromEntries(
            Object.entries(node).filter(([key]) => reportFields.has(key)),
          ),
        );
    } else if (this.format === "csv") {
      part = fields.map((key) => csvEscape(node[key])).join(",") + "\r\n";
    } else {
      if (!identity) throw new SafeError("DECRYPTION_FAILED", 500);
      part =
        this.format === "uri"
          ? uri(identity, node.name) + "\n"
          : this.format === "singbox"
            ? (this.count ? "," : "") +
              JSON.stringify(singbox(identity, node.name))
            : YAML.stringify({ proxies: [proxy(identity, node.name)] }).slice(
                "proxies:\n".length,
              );
    }
    this.push(part);
    this.count += 1;
  }

  finish(): string {
    this.push(
      this.format === "json" ? "]" : this.format === "singbox" ? "]}" : "",
    );
    if (!this.count && this.format === "mihomo") return "proxies: []\n";
    return this.parts.join("");
  }
}

export function render(format: string, items: ExportItem[]): string {
  const renderer = new ExportRenderer(format);
  for (const item of items) renderer.append(item);
  return renderer.finish();
}
