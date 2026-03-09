import { describe, expect, test } from "vitest";
import { parseBuiltIndexAssets } from "../../scripts/ui-built-assets.mjs";

describe("parseBuiltIndexAssets", () => {
  test("accepts stylesheet and module tags regardless of attribute order", () => {
    const parsed = parseBuiltIndexAssets(
      `<!doctype html>
<html>
  <head>
    <link href="/assets/main.css" rel="stylesheet" data-preload="true">
    <script data-entry="main" src='/assets/index.js' crossorigin type="module"></script>
  </head>
</html>`,
      (assetPath: string) => `file:///virtual${assetPath}`,
    );

    expect(parsed).toEqual({
      stylesheetUrls: ["file:///virtual/assets/main.css"],
      moduleScriptUrl: "file:///virtual/assets/index.js",
    });
  });

  test("supports built index html without emitted stylesheets", () => {
    const parsed = parseBuiltIndexAssets(
      `<!doctype html><html><head><script type="module" src="/assets/index.js"></script></head></html>`,
      (assetPath: string) => assetPath,
    );

    expect(parsed.stylesheetUrls).toEqual([]);
    expect(parsed.moduleScriptUrl).toBe("/assets/index.js");
  });

  test("rejects built index html that lacks a module script entry", () => {
    expect(() =>
      parseBuiltIndexAssets(
        `<!doctype html><html><head><link rel="stylesheet" href="/assets/main.css"></head></html>`,
      ),
    ).toThrow(/missing a module script entry/i);
  });
});
