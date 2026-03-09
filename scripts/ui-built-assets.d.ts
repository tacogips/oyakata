export interface BuiltIndexAssets {
  readonly stylesheetUrls: readonly string[];
  readonly moduleScriptUrl: string;
}

export function parseBuiltIndexAssets(
  indexHtml: string,
  createAssetUrl?: (assetPath: string) => string,
): BuiltIndexAssets;
