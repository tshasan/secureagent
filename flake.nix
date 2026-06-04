{
  description = "secureagent: a small harness for testing LLM agent prompt-injection defenses";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # cleanSource strips .git, etc. Re-filter for our local noise.
        projectSrc = pkgs.lib.cleanSourceWith {
          src = pkgs.lib.cleanSource ./.;
          filter = path: type:
            let base = baseNameOf path; in
            !(builtins.elem base [
              "node_modules"
              ".direnv"
              "results"
              ".ollama"
              "flake.lock"
            ]);
        };

        runScript = pkgs.writeShellApplication {
          name = "secureagent-run";
          runtimeInputs = [ pkgs.bun ];
          text = ''
            exec ${pkgs.bun}/bin/bun run ${projectSrc}/src/runner.ts "$@"
          '';
        };

        # Vendored node_modules as a Fixed Output Derivation.
        # First-time setup: set outputHash to pkgs.lib.fakeHash, run
        #   nix build .#checks.<system>.typecheck
        # Nix will print the real hash; paste it in below.
        nodeModules = pkgs.stdenvNoCC.mkDerivation {
          name = "secureagent-node-modules";
          src = pkgs.lib.cleanSourceWith {
            src = ./.;
            filter = path: type:
              let base = baseNameOf path; in
              builtins.elem base [ "package.json" "bun.lock" ];
          };
          nativeBuildInputs = [ pkgs.bun pkgs.cacert ];
          SSL_CERT_FILE = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
          dontConfigure = true;
          buildPhase = ''
            export HOME=$TMPDIR
            ${pkgs.bun}/bin/bun install --frozen-lockfile --no-progress --ignore-scripts
          '';
          installPhase = ''
            mkdir -p $out
            cp -r node_modules $out/
          '';
          outputHashMode = "recursive";
          outputHashAlgo = "sha256";
          outputHash = "sha256-3rz/k7gquLhd3+AXUOrnD6B9lkRGN7Ii7UYGtJPsmOo=";
        };

        typecheckScript = pkgs.runCommand "secureagent-typecheck"
          {
            nativeBuildInputs = [ pkgs.bun ];
          }
          ''
            set -euo pipefail
            mkdir -p project
            cp -r ${projectSrc}/. project/
            chmod -R +w project
            cp -r ${nodeModules}/node_modules project/node_modules
            cd project
            export HOME=$TMPDIR
            ${pkgs.bun}/bin/bun --bun ./node_modules/typescript/bin/tsc --noEmit
            touch $out
          '';

        # Shared shell hook. Uses `ollama` from PATH so the same script works
        # whether ollama comes from Nix (default shell) or the user's system
        # (bare shell).
        sharedHook = ''
          export OLLAMA_HOST="''${OLLAMA_HOST:-127.0.0.1:11434}"
          # Do not force a model here: the runner owns the default (the
          # cross-scale qwen2.5 sweep). Forcing SECUREAGENT_MODEL would
          # override that default and silently collapse the sweep to one model.
          mkdir -p .ollama

          if ! command -v ollama >/dev/null 2>&1; then
            echo "ERROR: 'ollama' not found on PATH."
            echo "Install it from https://ollama.com, or use 'nix develop' (default)"
            echo "instead of 'nix develop .#bare' so Nix provides one."
            return 1 2>/dev/null || exit 1
          fi

          ollama_url="http://$OLLAMA_HOST"
          case "$OLLAMA_HOST" in
            http://*|https://*) ollama_url="$OLLAMA_HOST" ;;
          esac

          if curl -sf "$ollama_url/api/tags" >/dev/null 2>&1; then
            echo "ollama already running at $ollama_url (this shell will not manage it)"
          else
            echo "Starting ollama at $ollama_url (binary: $(command -v ollama))..."
            ollama serve >.ollama/serve.log 2>&1 &
            ollama_pid=$!
            echo $ollama_pid > .ollama/serve.pid

            for _ in $(seq 1 30); do
              if curl -sf "$ollama_url/api/tags" >/dev/null 2>&1; then
                break
              fi
              sleep 0.5
            done

            if curl -sf "$ollama_url/api/tags" >/dev/null 2>&1; then
              echo "ollama ready (pid $ollama_pid, logs in .ollama/serve.log)"
            else
              echo "WARNING: ollama did not become ready in 15s. See .ollama/serve.log"
            fi

            # Watcher: polls the shell PID, kills ollama when the shell dies.
            shell_pid=$$
            (
              while kill -0 "$shell_pid" 2>/dev/null; do
                sleep 2
              done
              if [ -f .ollama/serve.pid ]; then
                pid=$(cat .ollama/serve.pid)
                kill "$pid" 2>/dev/null || true
                rm -f .ollama/serve.pid
              fi
            ) >/dev/null 2>&1 &
            disown 2>/dev/null || true
          fi

          echo ""
          echo "Default: cross-scale sweep (qwen2.5 0.5b->7b). Override with"
          echo "SECUREAGENT_MODELS=a,b,c or pass models as args."
          echo "Run the benchmark: bun install && bun run run [model...]"
          echo "Or: nix run . [model...]"
        '';

        mkDevShell = { withOllama }: pkgs.mkShell {
          packages = [ pkgs.bun pkgs.curl ]
            ++ pkgs.lib.optional withOllama pkgs.ollama;
          shellHook = sharedHook;
        };
      in
      {
        devShells.default = mkDevShell { withOllama = true; };
        devShells.bare = mkDevShell { withOllama = false; };

        apps.default = {
          type = "app";
          program = "${runScript}/bin/secureagent-run";
        };

        checks.typecheck = typecheckScript;

        formatter = pkgs.nixpkgs-fmt;
      });
}
