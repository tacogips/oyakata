{

  description = "no";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/release-24.11";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-unstable,
      flake-utils,
      llm-agents,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        pkgs-unstable = import nixpkgs-unstable { inherit system; };
        playwrightBrowsers = pkgs-unstable.playwright-driver.browsers;

        devPackages = with pkgs; [
          # Bun runtime
          pkgs-unstable.bun

          # Real Node.js runtime for Vite/Vitest/Playwright tooling
          nodejs_22

          # TypeScript tooling
          pkgs-unstable.typescript
          pkgs-unstable.typescript-language-server
          nodePackages.prettier

          # Browser automation
          playwrightBrowsers

          # Development tools
          fd
          gnused
          gh
          go-task
          podman

          # LLM browser agent
          llm-agents.packages.${system}.agent-browser
        ];

      in
      {
        devShells.default = pkgs.mkShell {
          packages = devPackages;

          shellHook = ''
            export PLAYWRIGHT_BROWSERS_PATH="${playwrightBrowsers}"
            export PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=true
            echo "TypeScript development environment ready"
            echo "Bun version: $(bun --version)"
            echo "TypeScript version: $(tsc --version)"
            echo "Task version: $(task --version 2>/dev/null || echo 'not available')"
            echo "Playwright browsers: $PLAYWRIGHT_BROWSERS_PATH"
          '';
        };
      }
    );
}
