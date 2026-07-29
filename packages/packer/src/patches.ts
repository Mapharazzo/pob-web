const modParserCacheReturn = "return unpack(copyTable(cache[line]))";

export function patchLuaModParserCache(source: string): string {
  if (!source.includes(modParserCacheReturn)) {
    throw new Error("expected ModParser cache return was not found");
  }

  return source.replace(
    modParserCacheReturn,
    "local cached = copyTable(cache[line])\n\treturn cached[1], cached[2]",
  );
}
