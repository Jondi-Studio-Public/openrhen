// Entry for `pnpm cli ...` and `pnpm --filter @openrhen/cli start/dev`. pnpm runs a package script from
// the package directory, so a relative `--from`/`--state-file` path would resolve against tools/cli.
// INIT_CWD is the directory the person typed the command in; move there before the CLI reads any path.
// Kept out of main.ts so the built `rhen` binary never reads INIT_CWD.
const origin = process.env.INIT_CWD;
if (origin) process.chdir(origin);

// Plain tsx cannot resolve the glob in drop-ins.ts, so load the extension folders from disk first.
await (await import("./drop-ins-disk.js")).loadDropInsFromDisk();
await import("./main.js");

export {};
