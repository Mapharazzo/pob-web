import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function walk(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

async function requireFile(filePath, description) {
  try {
    await access(filePath);
  } catch {
    throw new Error(`Missing ${description}: ${filePath}`);
  }
}

export async function verifyBuild(root, version) {
  const buildRoot = path.resolve(root);
  await requireFile(path.join(buildRoot, "index.html"), "index.html");
  await requireFile(path.join(buildRoot, "version.json"), "version.json");
  await requireFile(path.join(buildRoot, "games/poe1/versions", version, "root.zip"), `PoE 1 ${version} root.zip`);

  const files = await walk(buildRoot);
  const wasmFiles = files.filter(file => file.endsWith(".wasm"));
  if (wasmFiles.length === 0) {
    throw new Error("Build does not contain a WebAssembly driver");
  }

  const javascriptFiles = files.filter(file => file.endsWith(".js"));
  for (const file of javascriptFiles) {
    const source = await readFile(file, "utf8");
    if (source.includes("asset.pob.cool")) {
      throw new Error(`Build still references asset.pob.cool: ${file}`);
    }
  }

  return {
    javascriptFiles: javascriptFiles.length,
    wasmFiles: wasmFiles.length,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root, version] = process.argv.slice(2);
  if (!root || !version) {
    console.error("Usage: node selfhost/verify-build.mjs <build-root> <version>");
    process.exitCode = 2;
  } else {
    try {
      const result = await verifyBuild(root, version);
      console.log(
        `Verified local build: ${result.javascriptFiles} JavaScript files, ${result.wasmFiles} WebAssembly files`,
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
