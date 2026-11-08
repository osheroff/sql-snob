// sqlsnob.com Worker: static assets, plus a tiny store for shared queries.
//
//   POST /api/share        body: an encrypted blob (≤ MAX_BYTES)  ->  { "id": "<id>" }
//   GET  /api/share/<id>   ->  the blob, or 404
//
// Queries are encrypted in the browser and the key only ever travels in the link's `#fragment`,
// which browsers don't send to servers: this Worker (and Cloudflare) only see opaque bytes.
// Everything that isn't /api/* is served from the assets (wrangler.jsonc: `run_worker_first`).

interface KV {
  get(key: string, type: "arrayBuffer"): Promise<ArrayBuffer | null>;
  put(key: string, value: ArrayBuffer, opts?: { expirationTtl?: number }): Promise<void>;
}
interface Env {
  SHARES: KV;
  ASSETS: { fetch(req: Request): Promise<Response> };
}

/** Biggest blob accepted: SQL is compressed before it's encrypted, so this is a lot of SQL. */
const MAX_BYTES = 512 * 1024;
/** Shared links expire this long after they're made. */
const TTL_SECONDS = 90 * 24 * 3600;
const ID_RE = /^[A-Za-z0-9]{10}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/share" && req.method === "POST") return create(req, env);
    const m = /^\/api\/share\/([^/]+)$/.exec(url.pathname);
    if (m && req.method === "GET") return read(m[1], env);
    if (url.pathname.startsWith("/api/")) return json({ error: "not found" }, 404);
    return env.ASSETS.fetch(req);
  },
};

async function create(req: Request, env: Env): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? NaN);
  if (len > MAX_BYTES) return json({ error: "too large" }, 413);
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return json({ error: "too large" }, 413);
  // 12-byte IV + at least the 16-byte AES-GCM tag.
  if (body.byteLength < 28) return json({ error: "bad request" }, 400);
  const id = newId();
  await env.SHARES.put(id, body, { expirationTtl: TTL_SECONDS });
  return json({ id }, 201);
}

async function read(id: string, env: Env): Promise<Response> {
  if (!ID_RE.test(id)) return json({ error: "not found" }, 404);
  const blob = await env.SHARES.get(id, "arrayBuffer");
  if (!blob) return json({ error: "not found" }, 404);
  return new Response(blob, {
    headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=86400" },
  });
}

/** 10 random base62 characters (~59 bits): not guessable, short enough to paste. */
function newId(): string {
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  while (s.length < 10) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && s.length < 10) s += abc[b % 62]; // 248 = 4 * 62: no modulo bias
    }
  }
  return s;
}

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
}
