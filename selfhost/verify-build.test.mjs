import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyBuild } from "./verify-build.mjs";

async function createBuildFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pob-web-build-"));
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await mkdir(path.join(root, "games/poe1/versions/v2.66.2"), { recursive: true });
  await writeFile(path.join(root, "index.html"), "<html></html>");
  await writeFile(path.join(root, "version.json"), '{"poe1":{"head":"v2.66.2"}}');
  await writeFile(path.join(root, "assets/app.js"), 'const assetPrefix = "";');
  await writeFile(path.join(root, "dist/driver.wasm"), "wasm");
  await writeFile(path.join(root, "games/poe1/versions/v2.66.2/root.zip"), "zip");
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("accepts a complete local PoE 1 build", async t => {
  const root = await createBuildFixture(t);
  const result = await verifyBuild(root, "v2.66.2");
  assert.deepEqual(result, { javascriptFiles: 1, wasmFiles: 1 });
});

test("rejects a build without its packed PoE 1 archive", async t => {
  const root = await createBuildFixture(t);
  await rm(path.join(root, "games/poe1/versions/v2.66.2/root.zip"));

  await assert.rejects(verifyBuild(root, "v2.66.2"), /root\.zip/);
});

test("rejects a build that still uses the hosted asset CDN", async t => {
  const root = await createBuildFixture(t);
  await writeFile(path.join(root, "assets/app.js"), 'const assetPrefix = "https://asset.pob.cool";');

  await assert.rejects(verifyBuild(root, "v2.66.2"), /asset\.pob\.cool/);
});

test("rejects a build without a WebAssembly driver", async t => {
  const root = await createBuildFixture(t);
  await rm(path.join(root, "dist/driver.wasm"));

  await assert.rejects(verifyBuild(root, "v2.66.2"), /WebAssembly/);
});
