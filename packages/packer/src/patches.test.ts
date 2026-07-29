import assert from "node:assert/strict";
import test from "node:test";
import { patchLuaModParserCache } from "./patches.ts";

test("returns both cached parser values when the first value is nil", () => {
  const source = `
return function(line, isComb)
	return unpack(copyTable(cache[line]))
end, cache
`;

  assert.equal(
    patchLuaModParserCache(source),
    `
return function(line, isComb)
	local cached = copyTable(cache[line])
	return cached[1], cached[2]
end, cache
`,
  );
});

test("fails when the expected upstream parser code is absent", () => {
  assert.throws(() => patchLuaModParserCache("return parseMod(line)"), /expected ModParser cache return/);
});
