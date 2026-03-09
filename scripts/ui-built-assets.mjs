import path from "node:path";
import process from "node:process";

export const BUILT_FRONTEND_MODE_METADATA_FILE = "frontend-mode.json";

export function resolveBuiltFrontendModeMetadataPath(options = {}) {
  const uiDistRoot =
    options.uiDistRoot ??
    path.join(options.packageRoot ?? process.cwd(), "ui", "dist");
  return path.join(uiDistRoot, BUILT_FRONTEND_MODE_METADATA_FILE);
}

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

export function parseBuiltFrontendModeMetadata(metadataJson) {
  let parsed;
  try {
    parsed = JSON.parse(metadataJson);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`built frontend metadata is not valid JSON: ${message}`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "built frontend metadata must be a JSON object with a 'frontend' string",
    );
  }

  const frontend = parsed.frontend;
  if (frontend !== "solid-dist") {
    throw new Error(
      `built frontend metadata contains unsupported frontend mode '${String(frontend)}'`,
    );
  }

  return frontend;
}

export function serializeBuiltFrontendModeMetadata(frontendMode) {
  if (frontendMode !== "solid-dist") {
    throw new Error(`unsupported frontend mode '${String(frontendMode)}'`);
  }

  return `${JSON.stringify({ frontend: frontendMode }, null, 2)}\n`;
}
