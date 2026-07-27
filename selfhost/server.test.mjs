import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createApp } from "./server.mjs";

async function createFixture(t, fetchImpl = globalThis.fetch) {
  const staticRoot = await mkdtemp(path.join(os.tmpdir(), "pob-web-server-"));
  await mkdir(path.join(staticRoot, "assets"), { recursive: true });
  await mkdir(path.join(staticRoot, "games/poe1/versions/v2.66.2"), { recursive: true });
  await writeFile(path.join(staticRoot, "index.html"), "<h1>PoB</h1>");
  await writeFile(path.join(staticRoot, "assets/app.abc123.js"), "app");
  await writeFile(path.join(staticRoot, "games/poe1/versions/v2.66.2/root.zip"), "zip");
  await writeFile(path.join(staticRoot, "driver.wasm"), "wasm");
  await writeFile(path.join(staticRoot, "version.json"), '{"poe1":{"head":"v2.66.2"}}');

  const server = http.createServer(createApp({ staticRoot, fetchImpl }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(staticRoot, { recursive: true, force: true });
  });

  return {
    request: (pathname, init) => fetch(`${origin}${pathname}`, init),
    proxy: body =>
      fetch(`${origin}/api/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
  };
}

test("serves health, static assets, and SPA fallback", async t => {
  const { request } = await createFixture(t);

  const health = await request("/healthz");
  assert.equal(health.status, 200);
  assert.equal(await health.text(), "ok\n");

  const asset = await request("/assets/app.abc123.js");
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("content-type"), "text/javascript; charset=utf-8");
  assert.match(asset.headers.get("cache-control"), /immutable/);
  assert.equal(await asset.text(), "app");

  const spa = await request("/poe1");
  assert.equal(spa.status, 200);
  assert.equal(spa.headers.get("cache-control"), "no-cache");
  assert.equal(await spa.text(), "<h1>PoB</h1>");
});

test("serves browser-critical content types and HEAD requests", async t => {
  const { request } = await createFixture(t);

  const wasm = await request("/driver.wasm");
  assert.equal(wasm.headers.get("content-type"), "application/wasm");

  const zip = await request("/games/poe1/versions/v2.66.2/root.zip", { method: "HEAD" });
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get("content-type"), "application/zip");
  assert.equal(await zip.text(), "");

  const version = await request("/version.json");
  assert.equal(version.headers.get("cache-control"), "no-cache");
});

test("proxies HTTPS requests using the upstream response envelope", async t => {
  let capturedRequest;
  const fetchImpl = async (url, init) => {
    capturedRequest = { url, init };
    return new Response("payload", {
      status: 202,
      headers: { "content-type": "text/plain", "x-upstream": "yes" },
    });
  };
  const { proxy } = await createFixture(t, fetchImpl);

  const response = await proxy({
    url: "https://example.test/data",
    body: "request-body",
    headers: { accept: "text/plain" },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    body: "payload",
    headers: { "content-type": "text/plain", "x-upstream": "yes" },
    status: 202,
  });
  assert.equal(capturedRequest.url, "https://example.test/data");
  assert.equal(capturedRequest.init.method, "POST");
  assert.equal(capturedRequest.init.body, "request-body");
});

test("rejects unsafe proxy requests", async t => {
  let fetchCalls = 0;
  const { request, proxy } = await createFixture(t, async () => {
    fetchCalls += 1;
    return new Response("unexpected");
  });

  assert.equal((await proxy({ url: "http://example.test", headers: {} })).status, 400);
  assert.equal(
    (
      await proxy({
        url: "https://example.test",
        headers: { Cookie: "POESESSID=secret" },
      })
    ).status,
    400,
  );
  assert.equal((await request("/api/fetch")).status, 405);
  assert.equal(
    (
      await request("/api/fetch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
  assert.equal(fetchCalls, 0);
});

test("rejects malformed static paths", async t => {
  const { request } = await createFixture(t);

  assert.equal((await request("/%00")).status, 400);
  assert.equal((await request("/missing.js")).status, 404);
});
