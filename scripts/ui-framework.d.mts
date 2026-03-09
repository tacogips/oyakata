export type UiFramework = "solid";
export type UiFrameworkTarget = "build" | "typecheck";
export type FrontendMode = "solid-dist";

export interface UiFrameworkOptions {
  readonly baseDir?: string;
  readonly uiRoot?: string;
}

export interface UiFrameworkPackageOptions extends UiFrameworkOptions {
  readonly packageRoot?: string;
}

export interface UiFrameworkReadiness {
  readonly framework: UiFramework | null;
  readonly frontendMode: FrontendMode | null;
  readonly entrypoint: string | null;
  readonly missingTypecheckDeclarations: readonly string[];
  readonly missingBuildDeclarations: readonly string[];
  readonly missingTypecheckPackages: readonly string[];
  readonly missingBuildPackages: readonly string[];
  readonly readyForTypecheck: boolean;
  readonly readyForBuild: boolean;
}

export interface SolidCutoverStatus {
  readonly entrypoint: string;
  readonly entrypointExists: boolean;
  readonly conflictingSvelteEntrypoint: boolean;
  readonly missingTypecheckDeclarations: readonly string[];
  readonly missingBuildDeclarations: readonly string[];
  readonly missingTypecheckPackages: readonly string[];
  readonly missingBuildPackages: readonly string[];
  readonly ready: boolean;
}

export interface UiFrameworkStatus {
  readonly activeEntrypoints: Readonly<Record<"solid", boolean>>;
  readonly detectionError: string | null;
  readonly currentFramework: UiFrameworkReadiness;
  readonly solidCutover: SolidCutoverStatus;
}

export function detectUiFramework(options?: UiFrameworkOptions): UiFramework;
export function frontendModeFromUiFramework(
  framework: UiFramework,
): FrontendMode;
export function uiEntrypointRelativePath(
  framework: UiFramework,
  options?: UiFrameworkPackageOptions,
): string;
export function uiFrameworkPackages(
  framework: UiFramework,
  target: UiFrameworkTarget,
): readonly string[];
export function missingUiFrameworkPackageDeclarations(
  framework: UiFramework,
  target: UiFrameworkTarget,
  options?: UiFrameworkPackageOptions,
): readonly string[];
export function missingUiFrameworkPackages(
  framework: UiFramework,
  target: UiFrameworkTarget,
  options?: UiFrameworkPackageOptions,
): readonly string[];
export function assertUiFrameworkPackages(
  framework: UiFramework,
  target: UiFrameworkTarget,
  options?: UiFrameworkPackageOptions,
): void;
export function assertWorkspacePackage(
  packageName: string,
  action: string,
  options?: UiFrameworkPackageOptions,
): void;
export function uiTsconfigPath(
  framework: UiFramework,
  options?: UiFrameworkOptions,
): string;
export function resolvePackageBinary(
  packageName: string,
  binName: string,
  options?: UiFrameworkPackageOptions,
): string;
export function collectUiFrameworkStatus(
  options?: UiFrameworkPackageOptions,
): UiFrameworkStatus;
export function formatUiFrameworkStatus(status: UiFrameworkStatus): string;
