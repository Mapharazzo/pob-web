import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MAX_BODY_BYTES = 16 * 1024 * 1024;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".zip", "application/zip"],
  [".zst", "application/zstd"],
]);

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

async function readBody(request) {
  const chunks = [];
  let length = 0;

  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_BODY_BYTES) {
      const error = new Error("request body is too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function containsPoeSession(headers) {
  return Object.entries(headers).some(
    ([name, value]) => name.toLowerCase().includes("poesessid") || String(value).toLowerCase().includes("poesessid"),
  );
}

async function handleProxy(request, response, fetchImpl) {
  if (request.method !== "POST") {
    send(response, 405, "method not allowed\n", { allow: "POST" });
    return;
  }

  let payload;
  try {
    payload = JSON.parse((await readBody(request)).toString("utf8"));
  } catch (error) {
    send(response, error.status ?? 400, `${error.message}\n`);
    return;
  }

  let target;
  try {
    target = new URL(payload.url);
  } catch {
    send(response, 400, "invalid target URL\n");
    return;
  }

  const headers = payload.headers ?? {};
  if (
    target.protocol !== "https:" ||
    typeof headers !== "object" ||
    Array.isArray(headers) ||
    containsPoeSession(headers)
  ) {
    send(response, 400, "unsafe proxy request\n");
    return;
  }

  try {
    const upstream = await fetchImpl(target.href, {
      method: payload.body === undefined ? "GET" : "POST",
      body: payload.body,
      headers,
      redirect: "follow",
    });
    const contentLength = Number(upstream.headers.get("content-length") ?? 0);
    if (contentLength > MAX_BODY_BYTES) {
      send(response, 502, "upstream response is too large\n");
      return;
    }

    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > MAX_BODY_BYTES) {
      send(response, 502, "upstream response is too large\n");
      return;
    }

    const upstreamHeaders = Object.fromEntries(upstream.headers.entries());
    const body = JSON.stringify({
      body: bytes.toString("utf8"),
      headers: upstreamHeaders,
      status: upstream.status,
    });
    send(response, 200, body, { "content-type": "application/json; charset=utf-8" });
  } catch (error) {
    const body = JSON.stringify({ headers: {}, error: error.message });
    send(response, 502, body, { "content-type": "application/json; charset=utf-8" });
  }
}

function resolveStaticPath(staticRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { status: 400 };
  }
  if (decoded.includes("\0") || decoded.includes("\\")) {
    return { status: 400 };
  }

  const relative = path.posix.normalize(decoded).replace(/^\/+/, "");
  if (relative === ".." || relative.startsWith("../")) {
    return { status: 400 };
  }

  const resolved = path.resolve(staticRoot, relative || "index.html");
  const rootPrefix = `${path.resolve(staticRoot)}${path.sep}`;
  if (resolved !== path.resolve(staticRoot) && !resolved.startsWith(rootPrefix)) {
    return { status: 400 };
  }
  return { path: resolved, relative };
}

async function handleStatic(request, response, staticRoot, pathname) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "method not allowed\n", { allow: "GET, HEAD" });
    return;
  }

  const resolved = resolveStaticPath(staticRoot, pathname);
  if (!resolved.path) {
    send(response, resolved.status, "bad request\n");
    return;
  }

  let filePath = resolved.path;
  let fileStat;
  try {
    fileStat = await stat(filePath);
    if (fileStat.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      fileStat = await stat(filePath);
    }
  } catch {
    if (MIME_TYPES.has(path.extname(resolved.relative).toLowerCase())) {
      send(response, 404, "not found\n");
      return;
    }
    filePath = path.join(staticRoot, "index.html");
    try {
      fileStat = await stat(filePath);
    } catch {
      send(response, 404, "not found\n");
      return;
    }
  }

  const extension = path.extname(filePath).toLowerCase();
  const isMutable = extension === ".html" || path.basename(filePath) === "version.json";
  response.writeHead(200, {
    "content-type": MIME_TYPES.get(extension) ?? "application/octet-stream",
    "content-length": fileStat.size,
    "cache-control": isMutable ? "no-cache" : "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(filePath).pipe(response);
}

export function createApp({ staticRoot, fetchImpl = globalThis.fetch }) {
  const root = path.resolve(staticRoot);
  return async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/healthz") {
        send(response, 200, "ok\n");
      } else if (url.pathname === "/api/fetch") {
        await handleProxy(request, response, fetchImpl);
      } else {
        await handleStatic(request, response, root, url.pathname);
      }
    } catch (error) {
      console.error(error);
      if (!response.headersSent) {
        send(response, 500, "internal server error\n");
      } else {
        response.destroy();
      }
    }
  };
}

export function startServer({
  staticRoot = process.env.STATIC_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "public"),
  port = Number(process.env.PORT ?? 3000),
} = {}) {
  const server = http.createServer(createApp({ staticRoot }));
  server.listen(port, "0.0.0.0", () => {
    console.log(`PoB Web listening on 0.0.0.0:${port}`);
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
