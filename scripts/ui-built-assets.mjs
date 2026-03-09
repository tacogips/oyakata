function parseHtmlAttributes(source) {
  const attributes = {};
  const attributePattern =
    /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

  for (const match of source.matchAll(attributePattern)) {
    const [rawMatch, rawName, doubleQuotedValue, singleQuotedValue, bareValue] =
      match;
    if (rawMatch.length === 0) {
      continue;
    }

    const name = String(rawName).toLowerCase();
    const value = doubleQuotedValue ?? singleQuotedValue ?? bareValue ?? "";
    attributes[name] = value;
  }

  return attributes;
}

function htmlTagAttributes(indexHtml, tagName) {
  const tagPattern = new RegExp(`<${tagName}\\b([^>]*)>`, "giu");
  return [...indexHtml.matchAll(tagPattern)].map((match) =>
    parseHtmlAttributes(match[1] ?? ""),
  );
}

export function parseBuiltIndexAssets(
  indexHtml,
  createAssetUrl = (assetPath) => assetPath,
) {
  const stylesheetUrls = htmlTagAttributes(indexHtml, "link")
    .filter(
      (attributes) =>
        attributes.rel?.toLowerCase() === "stylesheet" &&
        typeof attributes.href === "string",
    )
    .map((attributes) => createAssetUrl(attributes.href));

  const moduleScript = htmlTagAttributes(indexHtml, "script").find(
    (attributes) =>
      attributes.type?.toLowerCase() === "module" &&
      typeof attributes.src === "string",
  );
  if (moduleScript?.src === undefined) {
    throw new Error("built ui index.html is missing a module script entry");
  }

  return {
    stylesheetUrls,
    moduleScriptUrl: createAssetUrl(moduleScript.src),
  };
}
