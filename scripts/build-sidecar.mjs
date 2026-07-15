import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostTriple = execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
const targetTriple = process.env.TAURI_ENV_TARGET_TRIPLE || process.env.CARGO_BUILD_TARGET || hostTriple;
const extension = targetTriple.includes("windows") ? ".exe" : "";

const cargoArgs = ["build", "--release", "--manifest-path", join(root, "server", "Cargo.toml")];
if (targetTriple !== hostTriple) cargoArgs.push("--target", targetTriple);
execFileSync("cargo", cargoArgs, { cwd: root, stdio: "inherit" });

const targetRoot = targetTriple === hostTriple
  ? join(root, "server", "target", "release")
  : join(root, "server", "target", targetTriple, "release");
const source = join(targetRoot, `ade-server${extension}`);
if (!existsSync(source)) throw new Error(`ADE sidecar build output not found: ${source}`);

const destination = join(root, "src-tauri", "binaries", `ade-server-${targetTriple}${extension}`);
mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`Prepared Tauri sidecar: ${destination}`);

// Package the Node-side converter with its npm dependency so the installed
// desktop app does not depend on a separately copied node_modules directory.
// A Node executable is still required when a user invokes DOCX conversion.
const scriptResources = join(root, "src-tauri", "resources", "server-scripts");
rmSync(scriptResources, { recursive: true, force: true });
mkdirSync(scriptResources, { recursive: true });
buildSync({
  entryPoints: [join(root, "server", "scripts", "html-to-docx.cjs")],
  outfile: join(scriptResources, "html-to-docx.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
});
buildSync({
  entryPoints: [join(root, "server", "scripts", "pptx-media-convert.cjs")],
  outfile: join(scriptResources, "pptx-media-convert.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
});
buildSync({
  entryPoints: [join(root, "server", "scripts", "powerpoint-preview-export.cjs")],
  outfile: join(scriptResources, "powerpoint-preview-export.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
});
buildSync({
  entryPoints: [join(root, "server", "scripts", "powerpoint-editor.cjs")],
  outfile: join(scriptResources, "powerpoint-editor.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
});
copyFileSync(
  join(root, "server", "scripts", "doc-format-convert.cjs"),
  join(scriptResources, "doc-format-convert.cjs"),
);
for (const script of ["word-format-convert.vbs", "powerpoint-format-convert.vbs", "powerpoint-preview-export.vbs", "powerpoint-editor.ps1", "rasterize-office-image.ps1"]) {
  copyFileSync(
    join(root, "server", "scripts", script),
    join(scriptResources, script),
  );
}
console.log(`Prepared converter resources: ${scriptResources}`);
