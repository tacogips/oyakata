export interface BuiltIndexAssets {
  readonly stylesheetUrls: readonly string[];
  readonly moduleScriptUrl: string;
}

export const BUILT_FRONTEND_MODE_METADATA_FILE: "frontend-mode.json";

export function resolveBuiltFrontendModeMetadataPath(options?: {
  readonly packageRoot?: string;
  readonly uiDistRoot?: string;
}): string;

export function parseBuiltIndexAssets(
  indexHtml: string,
  createAssetUrl?: (assetPath: string) => string,
): BuiltIndexAssets;

export function parseBuiltFrontendModeMetadata(
  metadataJson: string,
): "solid-dist";

export function serializeBuiltFrontendModeMetadata(
  frontendMode: "solid-dist",
): string;
