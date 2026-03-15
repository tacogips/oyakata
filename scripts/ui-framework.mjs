import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function resolveUiRoot(options = {}) {
  const baseDir = options.baseDir ?? process.cwd();
  return options.uiRoot ?? path.join(baseDir, "ui");
}

export function resolvePackageOptionsFromModuleUrl(moduleUrl) {
  const packageRoot = path.resolve(
    path.dirname(fileURLToPath(moduleUrl)),
    "..",
  );
  return {
    baseDir: packageRoot,
    packageRoot,
    uiRoot: path.join(packageRoot, "ui"),
  };
}

function solidEntrypointPath(options = {}) {
  const uiRoot = resolveUiRoot(options);
  return path.join(uiRoot, "src", "main.tsx");
}

function legacySvelteEntrypointPath(options = {}) {
  const uiRoot = resolveUiRoot(options);
  return path.join(uiRoot, "src", "main.ts");
}

export function detectUiFramework(options = {}) {
  const uiRoot = resolveUiRoot(options);
  const solidEntry = solidEntrypointPath({ uiRoot });
  const legacySvelteEntry = legacySvelteEntrypointPath({ uiRoot });
  const hasSolidEntry = fs.existsSync(solidEntry);
  const hasLegacySvelteEntry = fs.existsSync(legacySvelteEntry);

  if (hasLegacySvelteEntry) {
    throw new Error(
      `legacy Svelte entrypoint detected under ${uiRoot}: remove ui/src/main.ts and keep ui/src/main.tsx as the only checked-in frontend entrypoint.`,
    );
  }

  if (hasSolidEntry) {
    return "solid";
  }

  throw new Error(
    `unable to detect Solid frontend under ${uiRoot}: expected checked-in entrypoint ui/src/main.tsx`,
  );
}

export function frontendModeFromUiFramework(framework) {
  return "solid-dist";
}

export function uiEntrypointRelativePath(framework, options = {}) {
  return path.relative(packageRoot(options), solidEntrypointPath(options));
}

function packageRoot(options = {}) {
  return options.packageRoot ?? options.baseDir ?? process.cwd();
}

function packageJsonPath(options = {}) {
  return path.join(packageRoot(options), "package.json");
}

function packageInstallPath(packageName, options = {}) {
  return path.join(
    packageRoot(options),
    "node_modules",
    ...packageName.split("/"),
    "package.json",
  );
}

function installedPackageJsonPath(packageName, options = {}) {
  const packageJsonFile = packageInstallPath(packageName, options);
  return fs.existsSync(packageJsonFile) ? packageJsonFile : undefined;
}

function readPackageManifest(options = {}) {
  return JSON.parse(fs.readFileSync(packageJsonPath(options), "utf8"));
}

function packageJsonDependencyVersion(packageName, options = {}) {
  const manifest = readPackageManifest(options);
  const dependencyFields = [
    manifest.dependencies,
    manifest.devDependencies,
    manifest.optionalDependencies,
    manifest.peerDependencies,
  ];

  for (const dependencyField of dependencyFields) {
    if (dependencyField !== null && typeof dependencyField === "object") {
      const version = dependencyField[packageName];
      if (typeof version === "string") {
        return version;
      }
    }
  }

  return undefined;
}

function assertDirectPackageDeclaration(packageName, action, options = {}) {
  if (packageJsonDependencyVersion(packageName, options) !== undefined) {
    return;
  }

  throw new Error(
    `missing package declaration in package.json required to ${action}: '${packageName}'. ` +
      `Declare '${packageName}' directly in this repository before running ${action}.`,
  );
}

export function assertWorkspacePackage(packageName, action, options = {}) {
  assertDirectPackageDeclaration(packageName, action, options);

  if (installedPackageJsonPath(packageName, options) !== undefined) {
    return;
  }

  throw new Error(
    `missing installed package required to ${action}: '${packageName}'. ` +
      `Install repository dependencies before running ${action}.`,
  );
}

export function uiFrameworkPackages(framework, target) {
  return target === "build" ? ["solid-js", "vite-plugin-solid"] : ["solid-js"];
}

export function missingUiFrameworkPackageDeclarations(
  framework,
  target,
  options = {},
) {
  return uiFrameworkPackages(framework, target).filter(
    (packageName) =>
      packageJsonDependencyVersion(packageName, options) === undefined,
  );
}

export function missingUiFrameworkPackages(framework, target, options = {}) {
  return uiFrameworkPackages(framework, target).filter(
    (packageName) =>
      installedPackageJsonPath(packageName, options) === undefined,
  );
}

export function collectUiFrameworkStatus(options = {}) {
  const activeEntrypoints = {
    solid: fs.existsSync(solidEntrypointPath(options)),
  };

  let activeFramework = null;
  let detectionError = null;
  try {
    activeFramework = detectUiFramework(options);
  } catch (error) {
    detectionError = error instanceof Error ? error.message : String(error);
  }

  const currentFramework =
    activeFramework === null
      ? {
          framework: null,
          frontendMode: null,
          entrypoint: null,
          missingTypecheckDeclarations: [],
          missingBuildDeclarations: [],
          missingTypecheckPackages: [],
          missingBuildPackages: [],
          readyForTypecheck: false,
          readyForBuild: false,
        }
      : {
          framework: activeFramework,
          frontendMode: frontendModeFromUiFramework(activeFramework),
          entrypoint: uiEntrypointRelativePath(activeFramework, options),
          missingTypecheckDeclarations: missingUiFrameworkPackageDeclarations(
            activeFramework,
            "typecheck",
            options,
          ),
          missingBuildDeclarations: missingUiFrameworkPackageDeclarations(
            activeFramework,
            "build",
            options,
          ),
          missingTypecheckPackages: missingUiFrameworkPackages(
            activeFramework,
            "typecheck",
            options,
          ),
          missingBuildPackages: missingUiFrameworkPackages(
            activeFramework,
            "build",
            options,
          ),
          readyForTypecheck:
            missingUiFrameworkPackageDeclarations(
              activeFramework,
              "typecheck",
              options,
            ).length === 0 &&
            missingUiFrameworkPackages(activeFramework, "typecheck", options)
              .length === 0,
          readyForBuild:
            missingUiFrameworkPackageDeclarations(
              activeFramework,
              "build",
              options,
            ).length === 0 &&
            missingUiFrameworkPackages(activeFramework, "build", options)
              .length === 0,
        };

  const solidCutover = {
    entrypoint: uiEntrypointRelativePath("solid", options),
    entrypointExists: activeEntrypoints.solid,
    conflictingSvelteEntrypoint: fs.existsSync(
      legacySvelteEntrypointPath(options),
    ),
    missingTypecheckDeclarations: missingUiFrameworkPackageDeclarations(
      "solid",
      "typecheck",
      options,
    ),
    missingBuildDeclarations: missingUiFrameworkPackageDeclarations(
      "solid",
      "build",
      options,
    ),
    missingTypecheckPackages: missingUiFrameworkPackages(
      "solid",
      "typecheck",
      options,
    ),
    missingBuildPackages: missingUiFrameworkPackages("solid", "build", options),
  };

  return {
    activeEntrypoints,
    detectionError,
    currentFramework,
    solidCutover: {
      ...solidCutover,
      ready:
        solidCutover.entrypointExists &&
        !solidCutover.conflictingSvelteEntrypoint &&
        solidCutover.missingTypecheckDeclarations.length === 0 &&
        solidCutover.missingBuildDeclarations.length === 0 &&
        solidCutover.missingTypecheckPackages.length === 0 &&
        solidCutover.missingBuildPackages.length === 0,
    },
  };
}

function formatList(values) {
  return values.length === 0
    ? "none"
    : values.map((value) => `'${value}'`).join(", ");
}

export function formatUiFrameworkStatus(status) {
  const lines = [
    "UI framework status",
    `- Active checked-in frontend: ${status.currentFramework.framework ?? "unknown"}`,
  ];

  if (status.currentFramework.frontendMode !== null) {
    lines.push(`- Frontend mode: ${status.currentFramework.frontendMode}`);
  }

  if (status.currentFramework.entrypoint !== null) {
    lines.push(
      `- Checked-in entrypoint: ${status.currentFramework.entrypoint}`,
    );
  }

  if (status.detectionError !== null) {
    lines.push(`- Detection error: ${status.detectionError}`);
  }

  lines.push(
    `- Current framework typecheck ready: ${status.currentFramework.readyForTypecheck ? "yes" : "no"}`,
  );
  lines.push(
    `- Current framework build ready: ${status.currentFramework.readyForBuild ? "yes" : "no"}`,
  );
  lines.push(
    `- Solid cutover ready: ${status.solidCutover.ready ? "yes" : "no"}`,
  );
  lines.push("- Solid cutover blockers:");

  if (status.solidCutover.ready) {
    lines.push("  - none");
    return `${lines.join("\n")}\n`;
  }

  if (!status.solidCutover.entrypointExists) {
    lines.push(
      `  - missing checked-in Solid entrypoint ${status.solidCutover.entrypoint}`,
    );
  }

  if (status.solidCutover.conflictingSvelteEntrypoint) {
    lines.push(
      "  - remove or replace the checked-in Svelte entrypoint ui/src/main.ts",
    );
  }

  if (status.solidCutover.missingTypecheckDeclarations.length > 0) {
    lines.push(
      `  - declare Solid typecheck package(s) in package.json: ${formatList(status.solidCutover.missingTypecheckDeclarations)}`,
    );
  }

  if (status.solidCutover.missingBuildDeclarations.length > 0) {
    lines.push(
      `  - declare Solid build package(s) in package.json: ${formatList(status.solidCutover.missingBuildDeclarations)}`,
    );
  }

  if (status.solidCutover.missingTypecheckPackages.length > 0) {
    lines.push(
      `  - install Solid typecheck package(s) in this workspace: ${formatList(status.solidCutover.missingTypecheckPackages)}`,
    );
  }

  if (status.solidCutover.missingBuildPackages.length > 0) {
    lines.push(
      `  - install Solid build package(s) in this workspace: ${formatList(status.solidCutover.missingBuildPackages)}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

export function assertUiFrameworkPackages(framework, target, options = {}) {
  const missingPackageDeclarations = missingUiFrameworkPackageDeclarations(
    framework,
    target,
    options,
  );
  if (missingPackageDeclarations.length > 0) {
    const packageList = missingPackageDeclarations
      .map((packageName) => `'${packageName}'`)
      .join(", ");
    throw new Error(
      `missing ${framework} frontend package declaration(s) in package.json required to ${target}: ${packageList}. ` +
        `Declare the ${framework} UI dependencies directly in this repository before switching the checked-in entrypoint to ${framework}.`,
    );
  }

  const missingPackages = missingUiFrameworkPackages(
    framework,
    target,
    options,
  );
  if (missingPackages.length === 0) {
    return;
  }

  const packageList = missingPackages
    .map((packageName) => `'${packageName}'`)
    .join(", ");
  const action = target === "build" ? "build" : "typecheck";
  throw new Error(
    `missing ${framework} frontend package(s) required to ${action} the UI: ${packageList}. ` +
      `Install the ${framework} UI dependencies before switching the checked-in entrypoint to ${framework}.`,
  );
}

export function uiTsconfigPath(framework, options = {}) {
  const uiRoot = resolveUiRoot(options);
  return path.join(uiRoot, "tsconfig.solid.json");
}

export function resolvePackageBinary(packageName, binName, options = {}) {
  assertWorkspacePackage(packageName, `run '${binName}'`, options);
  const packageJsonFile = installedPackageJsonPath(packageName, options);
  if (packageJsonFile === undefined) {
    throw new Error(
      `package '${packageName}' is not installed under ${path.join(packageRoot(options), "node_modules")} and cannot be used from outside the workspace`,
    );
  }

  const packageDirectory = path.dirname(packageJsonFile);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonFile, "utf8"));
  const binField = packageJson.bin;

  if (typeof binField === "string") {
    if (binName !== packageName) {
      throw new Error(
        `package '${packageName}' exposes a single unnamed binary, but '${binName}' was requested instead of '${packageName}'`,
      );
    }

    return path.join(packageDirectory, binField);
  }

  if (binField !== null && typeof binField === "object") {
    const binPath = binField[binName];
    if (typeof binPath === "string") {
      return path.join(packageDirectory, binPath);
    }
  }

  throw new Error(
    `package '${packageName}' does not declare a '${binName}' binary in its package.json bin field`,
  );
}

if (import.meta.url === new URL(process.argv[1], "file://").href) {
  process.stdout.write(`${detectUiFramework()}\n`);
}
