{ pkgs, lib, config, ... }:

let
  # npm's workerd executable targets a conventional Linux loader. Run the
  # lockfile-selected binary with Nix libraries without patching node_modules.
  workerdLauncher = pkgs.writeShellScript "apron-workerd" ''
    set -eu
    workerd_binary="$(${config.languages.javascript.package}/bin/node -e 'const { createRequire } = require("node:module"); process.stdout.write(createRequire(process.argv[1])("workerd").default)' ${lib.escapeShellArg "${config.devenv.root}/package.json"})"
    exec ${pkgs.stdenv.cc.bintools.dynamicLinker} \
      --library-path ${lib.makeLibraryPath [ pkgs.glibc pkgs.stdenv.cc.cc.lib ]} \
      "$workerd_binary" "$@"
  '';
in {
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
  };

  packages = [
    pkgs.git
    pkgs.stdenv.cc
    pkgs.wrangler
  ];

  env = lib.optionalAttrs pkgs.stdenv.isLinux {
    MINIFLARE_WORKERD_PATH = "${workerdLauncher}";
  };

  processes = lib.optionalAttrs (!config.devenv.isTesting) {
    worker.exec = "npx wrangler dev --port 8080";
  };

  enterTest = ''
    npm ci
    npm run typecheck
    npm test
  '';
}
