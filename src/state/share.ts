// Shared links: `https://sqlsnob.com/s/<id>#<key>`.
//
// The query is gzipped and encrypted (AES-256-GCM) here, with a fresh key per link, and only the
// ciphertext is uploaded. The key is in the URL's fragment, which the browser never sends to the
// server, so whoever has the link can read the query and the server can't.

type Bytes = Uint8Array<ArrayBuffer>;

interface Payload {
  v: 1;
  sql: string;
}

/** Upload an encrypted copy of `sql` and return its link. */
export async function shareQuery(sql: string): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = await gzip(new TextEncoder().encode(JSON.stringify({ v: 1, sql } satisfies Payload)));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const blob = new Uint8Array(iv.length + ct.length);
  blob.set(iv);
  blob.set(ct, iv.length);

  const res = await fetch("/api/share", { method: "POST", body: blob, headers: { "content-type": "application/octet-stream" } });
  if (!res.ok) throw new Error(res.status === 413 ? "That query is too big to share." : `Sharing failed (${res.status}).`);
  const { id } = (await res.json()) as { id: string };
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  return `${location.origin}/s/${id}#${b64url(raw)}`;
}

/** Fetch and decrypt a shared query. Throws if it's gone or the key doesn't fit. */
export async function openShared(id: string, keyText: string): Promise<string> {
  const res = await fetch(`/api/share/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(res.status === 404 ? "gone" : `HTTP ${res.status}`);
  const blob = new Uint8Array(await res.arrayBuffer());
  const key = await crypto.subtle.importKey("raw", unb64url(keyText), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: blob.slice(0, 12) }, key, blob.slice(12));
  const p = JSON.parse(new TextDecoder().decode(await gunzip(new Uint8Array(plain)))) as Payload;
  if (p.v !== 1 || typeof p.sql !== "string") throw new Error("unknown format");
  return p.sql;
}

async function gzip(data: Bytes): Promise<Bytes> {
  return pipe(data, new CompressionStream("gzip"));
}
async function gunzip(data: Bytes): Promise<Bytes> {
  return pipe(data, new DecompressionStream("gzip"));
}
async function pipe(data: Bytes, t: CompressionStream | DecompressionStream): Promise<Bytes> {
  const out = new Response(new Blob([data]).stream().pipeThrough(t));
  return new Uint8Array(await out.arrayBuffer());
}

function b64url(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Bytes {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
