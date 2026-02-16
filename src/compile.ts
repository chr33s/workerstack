/**
 * WorkerStack Compile Script
 *
 * Scans the --root directory for wrangler.json files and compiles them
 * into the project root wrangler.json's ROUTES configuration and service bindings.
 *
 * Usage: compile.ts --root <directory>
 *
 * Directory structure maps to routes:
 *   <root>/_root/wrangler.json       -> /  (root-content worker)
 *   <root>/app/wrangler.json         -> /app
 *   <root>/app/auth/wrangler.json    -> /app/auth
 *
 * The entrypoint router (root wrangler.json) should NOT have an assets block.
 * Instead, root-level assets live in a dedicated _root/ worker that is
 * discovered and routed to "/" like any other sub-app.
 *
 * Edge cases handled:
 *   - Duplicate service names are detected and cause a build error
 *   - Missing worker entry points (main field) emit a warning
 *   - Symlinks are skipped to prevent infinite recursion
 *   - Sub-app wrangler.json extra config (vars, kv_namespaces, etc.) is preserved
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
} from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

interface SubAppEntry {
  dir: string;
  path: string;
}

interface WranglerConfig {
  name?: string;
  main?: string;
  [key: string]: unknown;
}

interface ServiceBinding {
  binding: string;
  service: string;
}

interface RouteEntry {
  binding: string;
  path: string;
}

interface RootConfig {
  name?: string;
  main?: string;
  compatibility_date?: string;
  services?: ServiceBinding[];
  vars?: Record<string, unknown>;
  [key: string]: unknown;
}

const SKIP_DIRS = new Set(["node_modules", ".wrangler", ".git", "dist"]);

/**
 * Recursively finds all wrangler.json files in subdirectories,
 * skipping node_modules, .wrangler, symlinks, and hidden directories.
 * Tracks visited inodes to prevent cycles from hard links.
 */
function findSubAppConfigs(
  dir: string,
  base: string = dir,
  visited: Set<number> = new Set(),
): SubAppEntry[] {
  const results: SubAppEntry[] = [];
  const entries = readdirSync(dir);

  for (const entry of entries) {
    const fullPath = join(dir, entry);

    // Skip hidden dirs, node_modules, and build artifacts
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) {
      continue;
    }

    // Use lstatSync to detect symlinks — skip them to prevent cycles
    const lstat = lstatSync(fullPath);
    if (lstat.isSymbolicLink()) {
      console.warn(`  ⚠ Skipping symlink: ${relative(base, fullPath)}`);
      continue;
    }

    if (!lstat.isDirectory()) {
      continue;
    }

    // Track visited inodes to prevent hard-link cycles
    const inode = lstat.ino;
    if (visited.has(inode)) {
      console.warn(`  ⚠ Skipping already-visited directory: ${relative(base, fullPath)}`);
      continue;
    }
    visited.add(inode);

    // Check for wrangler.json in this directory
    const wranglerPath = join(fullPath, "wrangler.json");
    if (existsSync(wranglerPath)) {
      const relDir = relative(base, fullPath);
      results.push({ dir: relDir, path: wranglerPath });
    }
    // Recurse into subdirectories
    results.push(...findSubAppConfigs(fullPath, base, visited));
  }

  return results;
}

/**
 * Converts a directory path to a route path.
 * Maps to "/<dir>" (e.g., "app/auth" -> "/app/auth").
 */
function dirToRoute(dir: string): string {
  return "/" + dir.split(/[\\/]/).join("/");
}

/**
 * Converts a service name to a binding name.
 * e.g., "app-worker" -> "APP_WORKER"
 */
function toBindingName(serviceName: string): string {
  return serviceName.toUpperCase().replace(/-/g, "_");
}

/**
 * Validates that the worker entry point file exists.
 */
function validateEntryPoint(wranglerPath: string, config: WranglerConfig, rootDir: string): void {
  const main = config.main;
  if (!main) return;

  // Resolve relative to the wrangler.json directory
  const absEntryPath = join(dirname(wranglerPath), main);

  if (!existsSync(absEntryPath)) {
    console.warn(`  ⚠ Entry point "${main}" not found for ${relative(rootDir, wranglerPath)}`);
  }
}

/**
 * Directory name for the root-content worker.
 * A sub-app in this directory is mapped to route "/" instead of "/_root".
 */
const ROOT_CONTENT_DIR = "_root";

/**
 * Main compile function.
 * Reads sub-app wrangler.json files and generates the root wrangler.json.
 */
export function compile(rootDir: string): void {
  if (!existsSync(rootDir)) {
    console.error(`Root directory not found: ${rootDir}`);
    process.exit(1);
  }

  // ── 1. Read root config ──
  const rootWranglerPath = join(rootDir, "wrangler.json");
  let rootConfig: RootConfig = {};

  if (existsSync(rootWranglerPath)) {
    try {
      rootConfig = JSON.parse(readFileSync(rootWranglerPath, "utf-8"));
    } catch {
      // Start fresh if parsing fails
    }
  }

  // Warn if the entrypoint router still has an assets block
  if (rootConfig.assets && typeof rootConfig.assets === "object") {
    console.warn(
      "  ⚠ Root wrangler.json has an assets block. Move assets into a _root/ sub-app to avoid dev-mode collisions.",
    );
  }

  // ── 2. Discover sub-app configs ──
  const subApps = findSubAppConfigs(rootDir);
  const errors: string[] = [];

  if (subApps.length === 0) {
    console.warn("No sub-app wrangler.json files found. Nothing to compile.");
    return;
  }

  // Sort by path depth (deeper paths first for more specific matching)
  subApps.sort((a, b) => {
    const depthA = a.dir.split(/[\\/]/).length;
    const depthB = b.dir.split(/[\\/]/).length;
    return depthB - depthA;
  });

  const services: ServiceBinding[] = [];
  const routes: RouteEntry[] = [];
  const seenNames = new Map<string, string>();
  const seenBindings = new Map<string, string>();

  for (const subApp of subApps) {
    let config: WranglerConfig;
    try {
      config = JSON.parse(readFileSync(subApp.path, "utf-8"));
    } catch (e) {
      errors.push(`Failed to parse ${subApp.path}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const serviceName = config.name;
    if (!serviceName) {
      errors.push(`Missing "name" in ${subApp.path}.`);
      continue;
    }

    // Edge case 1: detect duplicate service names
    if (seenNames.has(serviceName)) {
      errors.push(
        `Duplicate service name "${serviceName}" in ${subApp.path} (already defined in ${seenNames.get(serviceName)}).`,
      );
      continue;
    }
    seenNames.set(serviceName, subApp.path);

    const binding = toBindingName(serviceName);

    // Also detect duplicate binding names (different service names that produce the same binding)
    if (seenBindings.has(binding)) {
      errors.push(
        `Duplicate binding name "${binding}" from "${serviceName}" in ${subApp.path} (conflicts with ${seenBindings.get(binding)}).`,
      );
      continue;
    }
    seenBindings.set(binding, subApp.path);

    // Edge case 2: validate worker entry point exists
    validateEntryPoint(subApp.path, config, rootDir);

    // _root is the root-content worker → route to "/"
    const routePath = subApp.dir === ROOT_CONTENT_DIR ? "/" : dirToRoute(subApp.dir);

    services.push({
      binding,
      service: serviceName,
    });

    routes.push({
      binding,
      path: routePath,
    });

    console.log(`  ${subApp.dir}/ -> ${routePath} (${serviceName} as ${binding})`);
  }

  // Abort on errors
  if (errors.length > 0) {
    console.error("\nCompilation errors:");
    for (const err of errors) {
      console.error(`  ✗ ${err}`);
    }
    process.exit(1);
  }

  // Patch sub-app wrangler.json files that have assets and nested children
  // e.g. app/wrangler.json with assets needs run_worker_first: ["/api/*"]
  // so its assets binding doesn't intercept nested sub-app requests.
  const allRoutePaths = routes.map((r) => r.path);
  for (const subApp of subApps) {
    let config: WranglerConfig;
    try {
      config = JSON.parse(readFileSync(subApp.path, "utf-8"));
    } catch {
      continue;
    }

    if (!config.assets || typeof config.assets !== "object") continue;

    const myRoute = dirToRoute(subApp.dir);
    // Find nested children: routes that start with this sub-app's path
    const childPaths = allRoutePaths
      .filter((r) => r !== myRoute && r.startsWith(myRoute === "/" ? "/" : myRoute + "/"))
      .map((r) => (myRoute === "/" ? r : r.slice(myRoute.length)))
      .sort((a, b) => a.length - b.length);

    if (childPaths.length === 0) continue;

    // Deduplicate: only keep top-level patterns
    const topLevel: string[] = [];
    for (const p of childPaths) {
      if (!topLevel.some((t) => p.startsWith(t + "/"))) {
        topLevel.push(p);
      }
    }

    const assets = config.assets as Record<string, unknown>;
    assets.not_found_handling = "none";
    assets.run_worker_first = topLevel.map((p) => `${p}/*`);

    writeFileSync(subApp.path, JSON.stringify(config, null, 2) + "\n");
    console.log(
      `  Updated ${subApp.dir}/wrangler.json assets: run_worker_first: ${JSON.stringify(assets.run_worker_first)}`,
    );
  }

  // Update the root wrangler.json with compiled configuration
  rootConfig.name = rootConfig.name || "workerstack";
  rootConfig.main = rootConfig.main || "./index.ts";
  rootConfig.compatibility_date = rootConfig.compatibility_date || "2025-10-08";

  // Set service bindings
  rootConfig.services = services;

  // Set ROUTES var
  rootConfig.vars = rootConfig.vars || {};
  rootConfig.vars.ROUTES = { routes };

  // Write the compiled root wrangler.json
  writeFileSync(rootWranglerPath, JSON.stringify(rootConfig, null, 2) + "\n");

  console.log(`\nCompiled ${routes.length} route(s) into ${rootWranglerPath}`);
}

function ensureAssetsDir(configPath: string): void {
  const config = JSON.parse(readFileSync(configPath, "utf-8"));
  const assetsDir = config.assets?.directory;
  if (assetsDir) {
    const resolved = join(dirname(configPath), assetsDir);
    if (!existsSync(resolved)) {
      mkdirSync(resolved, { recursive: true });
    }
  }
}

export { findSubAppConfigs, dirToRoute, toBindingName, ensureAssetsDir };

// Auto-execute when run directly as a script
const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isMain) {
  const { values: args } = parseArgs({
    options: {
      root: { type: "string" },
    },
  });

  if (!args.root) {
    console.error("Usage: compile.ts --root <directory>");
    process.exit(1);
  }

  const rootDir = resolve(process.cwd(), args.root);
  console.log("Compiling WorkerStack routes...\n");
  compile(rootDir);
}
