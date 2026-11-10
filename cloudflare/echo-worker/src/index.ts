const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/" || url.search) {
      return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
        status: 404,
        headers,
      });
    }
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip)
      return new Response(JSON.stringify({ error: "METADATA_UNAVAILABLE" }), {
        status: 503,
        headers,
      });
    const cf = request.cf;
    return new Response(
      JSON.stringify({
        ip,
        country: typeof cf?.country === "string" ? cf.country : null,
        asn: typeof cf?.asn === "number" ? cf.asn : null,
      }),
      { headers },
    );
  },
} satisfies ExportedHandler;
