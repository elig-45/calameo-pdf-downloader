import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = join(projectRoot, "dist");
const sourceFiles = [
  "README.md",
  "background.js",
  "content.js",
  "offscreen.html",
  "offscreen.js",
  "print.html",
  "print.js",
  "shared.js",
  "icons",
  "manifest.json"
];
const chromiumManifest = JSON.parse(await readFile(join(projectRoot, "manifest.json"), "utf8"));
const firefoxManifest = createFirefoxManifest(chromiumManifest);

await mkdir(distDirectory, { recursive: true });
await buildPackage("chromium", chromiumManifest);
await buildPackage("firefox", firefoxManifest);

function createFirefoxManifest(source) {
  const manifest = structuredClone(source);
  manifest.manifest_version = 2;
  manifest.permissions = manifest.permissions.filter((permission) => permission !== "offscreen");
  manifest.permissions.push("https://*.calameoassets.com/*");
  delete manifest.host_permissions;
  delete manifest.minimum_chrome_version;
  manifest.background = {
    scripts: ["shared.js", "background.js", "offscreen.js"],
    persistent: true
  };
  manifest.web_accessible_resources = ["print.html", "print.js"];
  manifest.browser_specific_settings = {
    gecko: {
      id: "calameo-pdf-export@elig-45",
      strict_min_version: "140.0",
      data_collection_permissions: { required: ["none"] }
    },
    gecko_android: {
      strict_min_version: "142.0",
      data_collection_permissions: { required: ["none"] }
    }
  };
  return manifest;
}

async function buildPackage(platform, manifest) {
  const stageDirectory = join(distDirectory, `package-${platform}`);
  const archivePath = join(distDirectory, `calameo-pdf-export-${manifest.version}-${platform}.zip`);
  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(stageDirectory, { recursive: true });

  for (const file of sourceFiles.filter((entry) => (
    entry !== "manifest.json" && !(platform === "firefox" && entry === "background.js")
  ))) {
    await cp(join(projectRoot, file), join(stageDirectory, file), { recursive: true });
  }
  if (platform === "firefox") {
    const chromiumBackground = await readFile(join(projectRoot, "background.js"), "utf8");
    await writeFile(join(stageDirectory, "background.js"), createFirefoxBackground(chromiumBackground));
  }
  await writeFile(join(stageDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  await rm(archivePath, { force: true });
  if (process.platform === "win32") {
    const quote = (value) => `'${value.replaceAll("'", "''")}'`;
    const command = `Compress-Archive -Path ${quote(join(stageDirectory, "*"))} -DestinationPath ${quote(archivePath)} -Force`;
    execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-qr", archivePath, "."], { cwd: stageDirectory, stdio: "inherit" });
  }

  console.log(`${platform}: ${archivePath}`);
}

function createFirefoxBackground(source) {
  let background = source.replace(
    /const INLINE_PROCESSOR =[^;\n]*;/,
    "const INLINE_PROCESSOR = true;"
  );
  background = background.replace(
    /async function ensureOffscreenDocument\(\) \{[\s\S]*?\n\}\n\nfunction sendOffscreenMessage/,
    `async function ensureOffscreenDocument() {
  if (typeof globalThis.CalameoPdfOffscreenBridge !== "function") {
    throw new Error("Le moteur d’export Firefox n’a pas fini de démarrer.");
  }
}

function sendOffscreenMessage`
  );
  background = background.replace(
    /function scheduleOffscreenClose\(\) \{[\s\S]*?\n\}\n\nasync function forwardToTab/,
    "function scheduleOffscreenClose() {}\n\nasync function forwardToTab"
  );

  if (background === source || background.includes("chrome.offscreen") || background.includes("chrome.runtime.getContexts")) {
    throw new Error("Impossible de créer une variante Firefox sans API Chromium.");
  }
  return background;
}
