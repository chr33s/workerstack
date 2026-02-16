import assert from "node:assert/strict";
import { describe, it, beforeEach, mock } from "node:test";

const mockExecSync = mock.fn();
const mockCompile = mock.fn();
const mockEnsureAssetsDir = mock.fn();
const mockFindSubAppConfigs = mock.fn(() => [] as { dir: string; path: string }[]);

mock.module("node:child_process", {
  namedExports: { execSync: mockExecSync },
});

mock.module("./compile.ts", {
  namedExports: {
    compile: mockCompile,
    ensureAssetsDir: mockEnsureAssetsDir,
    findSubAppConfigs: mockFindSubAppConfigs,
  },
});

const { build } = await import("./build.ts");

void describe("build", () => {
  beforeEach(() => {
    mockExecSync.mock.resetCalls();
    mockExecSync.mock.mockImplementation(() => {});
    mockCompile.mock.resetCalls();
    mockCompile.mock.mockImplementation(() => {});
    mockEnsureAssetsDir.mock.resetCalls();
    mockEnsureAssetsDir.mock.mockImplementation(() => {});
    mockFindSubAppConfigs.mock.resetCalls();
    mockFindSubAppConfigs.mock.mockImplementation(() => []);
  });

  void it("compiles routes before building", () => {
    build("/project");
    assert.strictEqual(mockCompile.mock.callCount(), 1);
    assert.deepStrictEqual(mockCompile.mock.calls[0].arguments, ["/project"]);
  });

  void it("runs wrangler build for root when no sub-apps", () => {
    build("/project");
    assert.strictEqual(mockExecSync.mock.callCount(), 1);
    assert.deepStrictEqual(mockExecSync.mock.calls[0].arguments, [
      "npx wrangler build",
      { cwd: "/project", stdio: "inherit" },
    ]);
  });

  void it("runs wrangler build for each sub-app then root", () => {
    mockFindSubAppConfigs.mock.mockImplementation(() => [
      { dir: "_root", path: "/project/_root/wrangler.json" },
      { dir: "app", path: "/project/app/wrangler.json" },
      { dir: "docs", path: "/project/docs/wrangler.json" },
    ]);

    build("/project");

    assert.strictEqual(mockExecSync.mock.callCount(), 4);
    assert.deepStrictEqual(mockExecSync.mock.calls[0].arguments, [
      "npx wrangler build",
      { cwd: "/project/_root", stdio: "inherit" },
    ]);
    assert.deepStrictEqual(mockExecSync.mock.calls[1].arguments, [
      "npx wrangler build",
      { cwd: "/project/app", stdio: "inherit" },
    ]);
    assert.deepStrictEqual(mockExecSync.mock.calls[2].arguments, [
      "npx wrangler build",
      { cwd: "/project/docs", stdio: "inherit" },
    ]);
    assert.deepStrictEqual(mockExecSync.mock.calls[3].arguments, [
      "npx wrangler build",
      { cwd: "/project", stdio: "inherit" },
    ]);
  });

  void it("ensures assets directory for each sub-app", () => {
    mockFindSubAppConfigs.mock.mockImplementation(() => [
      { dir: "app", path: "/project/app/wrangler.json" },
    ]);

    build("/project");
    assert.strictEqual(mockEnsureAssetsDir.mock.callCount(), 1);
    assert.deepStrictEqual(mockEnsureAssetsDir.mock.calls[0].arguments, [
      "/project/app/wrangler.json",
    ]);
  });

  void it("passes extra args to wrangler build", () => {
    build("/project", ["--minify", "--outdir=dist"]);

    assert.deepStrictEqual(mockExecSync.mock.calls[0].arguments, [
      "npx wrangler build --minify --outdir=dist",
      { cwd: "/project", stdio: "inherit" },
    ]);
  });

  void it("exits 130 on SIGINT", () => {
    const mockExit = mock.method(process, "exit", (() => {
      throw new Error("process.exit");
    }) as () => never);

    mockExecSync.mock.mockImplementation(() => {
      const err = new Error("SIGINT") as any;
      err.signal = "SIGINT";
      throw err;
    });

    assert.throws(() => build("/project"), { message: "process.exit" });
    assert.strictEqual(mockExit.mock.callCount(), 1);
    assert.deepStrictEqual(mockExit.mock.calls[0].arguments, [130]);
    mockExit.mock.restore();
  });

  void it("exits 130 on status 130", () => {
    const mockExit = mock.method(process, "exit", (() => {
      throw new Error("process.exit");
    }) as () => never);

    mockExecSync.mock.mockImplementation(() => {
      const err = new Error("exit 130") as any;
      err.status = 130;
      throw err;
    });

    assert.throws(() => build("/project"), { message: "process.exit" });
    assert.strictEqual(mockExit.mock.callCount(), 1);
    assert.deepStrictEqual(mockExit.mock.calls[0].arguments, [130]);
    mockExit.mock.restore();
  });

  void it("re-throws non-SIGINT errors", () => {
    mockExecSync.mock.mockImplementation(() => {
      throw new Error("build failed");
    });

    assert.throws(() => build("/project"), { message: "build failed" });
  });
});
