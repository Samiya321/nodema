// Share links are stored without a name (Python renders them once per node);
// the current display name is added when the dashboard asks for a QR code.
export function withName(uri: string, name: string): string {
  if (uri.startsWith("vmess://")) {
    const doc = JSON.parse(
      Buffer.from(uri.slice("vmess://".length), "base64").toString("utf8"),
    ) as Record<string, unknown>;
    doc.ps = name;
    return (
      "vmess://" + Buffer.from(JSON.stringify(doc), "utf8").toString("base64")
    );
  }
  const hash = uri.indexOf("#");
  return (hash < 0 ? uri : uri.slice(0, hash)) + "#" + encodeURIComponent(name);
}
