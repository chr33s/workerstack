import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";

const tmpDir = join(import.meta.dirname, "..", ".tmp-test-compile");

function runCompile(root = "spec") {
  execSync(`node src/compile.ts --root ${root}`, { cwd: tmpDir, stdio: "pipe" });
}

void describe("Compile Script", () => {
  beforeEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    mkdirSync(join(tmpDir, "src"), { recursive: true });

    // Copy compile script
    const compileScript = readFileSync(
      join(import.meta.dirname, "..", "src", "compile.ts"),
      "utf-8",
    );
    writeFileSync(join(tmpDir, "src", "compile.ts"), compileScript);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  void it("compiles sub-app wrangler.json files into root wrangler.json", () => {
    mkdirSync(join(tmpDir, "spec", "app"), { recursive: true });
    writeFileSync(join(tmpDir, "spec", "app", "wrangler.json"), JSON.stringify({ name: "my-app" }));

    mkdirSync(join(tmpDir, "spec", "docs"), { recursive: true });
    writeFileSync(
      join(tmpDir, "spec", "docs", "wrangler.json"),
      JSON.stringify({ name: "my-docs" }),
    );

    runCompile();

    const rootConfig = JSON.parse(readFileSync(join(tmpDir, "spec", "wrangler.json"), "utf-8"));

    assert.ok(rootConfig.services !== undefined);
    assert.ok(rootConfig.vars !== undefined);
    assert.ok(rootConfig.vars.ROUTES !== undefined);
    assert.strictEqual(rootConfig.vars.ROUTES.routes.length, 2);

    const routePaths = rootConfig.vars.ROUTES.routes.map((r: any) => r.path);
    assert.ok(routePaths.includes("/app"));
    assert.ok(routePaths.includes("/docs"));
  });

  void it("maps root directory to '/root' path (no special casing)", () => {
    mkdirSync(join(tmpDir, "spec", "root"), { recursive: true });
    writeFileSync(
      join(tmpDir, "spec", "root", "wrangler.json"),
      JSON.stringify({ name: "my-root" }),
    );

    runCompile();

    const rootConfig = JSON.parse(readFileSync(join(tmpDir, "spec", "wrangler.json"), "utf-8"));

    const rootRouteEntry = rootConfig.vars.ROUTES.routes.find((r: any) => r.path === "/root");
    assert.ok(rootRouteEntry !== undefined);
    assert.strictEqual(rootRouteEntry.binding, "MY_ROOT");
  });

  void it("handles nested directories correctly", () => {
    mkdirSync(join(tmpDir, "spec", "app"), { recursive: true });
    writeFileSync(join(tmpDir, "spec", "app", "wrangler.json"), JSON.stringify({ name: "my-app" }));

    mkdirSync(join(tmpDir, "spec", "app", "auth"), { recursive: true });
    writeFileSync(
      join(tmpDir, "spec", "app", "auth", "wrangler.json"),
      JSON.stringify({ name: "my-app-auth" }),
    );

    runCompile();

    const rootConfig = JSON.parse(readFileSync(join(tmpDir, "spec", "wrangler.json"), "utf-8"));

    const routePaths = rootConfig.vars.ROUTES.routes.map((r: any) => r.path);
    assert.ok(routePaths.includes("/app"));
    assert.ok(routePaths.includes("/app/auth"));
  });

  void it("generates correct binding names from service names", () => {
    mkdirSync(join(tmpDir, "spec", "app"), { recursive: true });
    writeFileSync(
      join(tmpDir, "spec", "app", "wrangler.json"),
      JSON.stringify({ name: "my-app-worker" }),
    );

    runCompile();

    const rootConfig = JSON.parse(readFileSync(join(tmpDir, "spec", "wrangler.json"), "utf-8"));

    const service = rootConfig.services[0];
    assert.strictEqual(service.binding, "MY_APP_WORKER");
    assert.strictEqual(service.service, "my-app-worker");
  });

  void it("preserves existing root wrangler.json settings", () => {
    mkdirSync(join(tmpDir, "spec"), { recursive: true });
    writeFileSync(
      join(tmpDir, "spec", "wrangler.json"),
      JSON.stringify({
        name: "custom-router",
        main: "./custom.ts",
        observability: { enabled: true },
      }),
    );

    mkdirSync(join(tmpDir, "spec", "app"), { recursive: true });
    writeFileSync(join(tmpDir, "spec", "app", "wrangler.json"), JSON.stringify({ name: "my-app" }));

    runCompile();

    const rootConfig = JSON.parse(readFileSync(join(tmpDir, "spec", "wrangler.json"), "utf-8"));

    assert.strictEqual(rootConfig.name, "custom-router");
    assert.strictEqual(rootConfig.main, "./custom.ts");
    assert.deepStrictEqual(rootConfig.observability, { enabled: true });
    assert.ok(rootConfig.services !== undefined);
    assert.ok(rootConfig.vars.ROUTES !== undefined);
  });

  void it("errors on duplicate service names", () => {
    mkdirSync(join(tmpDir, "spec", "app"), { recursive: true });
    writeFileSync(join(tmpDir, "spec", "app", "wrangler.json"), JSON.stringify({ name: "my-app" }));

    mkdirSync(join(tmpDir, "spec", "docs"), { recursive: true });
    writeFileSync(
      join(tmpDir, "spec", "docs", "wrangler.json"),
      JSON.stringify({ name: "my-app" }),
    );

    assert.throws(() => runCompile(), { message: /Duplicate service name/ });
  });

  void it("errors on missing service name", () => {
    mkdirSync(join(tmpDir, "spec", "app"), { recursive: true });
    writeFileSync(join(tmpDir, "spec", "app", "wrangler.json"), JSON.stringify({}));

    assert.throws(() => runCompile(), { message: /Missing/ });
  });

  void it("maps _root directory to '/' path", () => {
    mkdirSync(join(tmpDir, "spec", "_root"), { recursive: true });
    writeFileSync(join(tmpDir, "spec", "_root", "wrangler.json"), JSON.stringify({ name: "root" }));

    mkdirSync(join(tmpDir, "spec", "app"), { recursive: true });
    writeFileSync(join(tmpDir, "spec", "app", "wrangler.json"), JSON.stringify({ name: "my-app" }));

    runCompile();

    const rootConfig = JSON.parse(readFileSync(join(tmpDir, "spec", "wrangler.json"), "utf-8"));

    const rootRoute = rootConfig.vars.ROUTES.routes.find((r: any) => r.path === "/");
    assert.ok(rootRoute !== undefined);
    assert.strictEqual(rootRoute.binding, "ROOT");

    const rootService = rootConfig.services.find((s: any) => s.binding === "ROOT");
    assert.ok(rootService !== undefined);
    assert.strictEqual(rootService.service, "root");
  });
});
