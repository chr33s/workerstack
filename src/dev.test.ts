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

const { dev } = await import("./dev.ts");

void describe("dev", () => {
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

  void it("compiles routes before starting dev", () => {
    dev("/project");
    assert.strictEqual(mockCompile.mock.callCount(), 1);
    assert.deepStrictEqual(mockCompile.mock.calls[0].arguments, ["/project"]);
  });

  void it("runs wrangler dev with root config", () => {
    dev("/project");

    assert.strictEqual(mockExecSync.mock.callCount(), 1);
    assert.deepStrictEqual(mockExecSync.mock.calls[0].arguments, [
      "npx wrangler dev --config=wrangler.json",
      { cwd: "/project", stdio: "inherit" },
    ]);
  });

  void it("includes sub-app configs in wrangler dev command", () => {
    mockFindSubAppConfigs.mock.mockImplementation(() => [
      { dir: "app", path: "/project/app/wrangler.json" },
      { dir: "api", path: "/project/api/wrangler.json" },
    ]);

    dev("/project");

    const cmd = mockExecSync.mock.calls[0].arguments[0] as string;
    assert.ok(cmd.includes("--config=wrangler.json"));
    assert.ok(cmd.includes("--config=app/wrangler.json"));
    assert.ok(cmd.includes("--config=api/wrangler.json"));
  });

  void it("ensures assets dir for each sub-app", () => {
    mockFindSubAppConfigs.mock.mockImplementation(() => [
      { dir: "app", path: "/project/app/wrangler.json" },
    ]);

    dev("/project");
    assert.strictEqual(mockEnsureAssetsDir.mock.callCount(), 1);
    assert.deepStrictEqual(mockEnsureAssetsDir.mock.calls[0].arguments, [
      "/project/app/wrangler.json",
    ]);
  });

  void it("passes extra args to wrangler dev", () => {
    dev("/project", ["--port=9000"]);

    const cmd = mockExecSync.mock.calls[0].arguments[0] as string;
    assert.ok(cmd.includes("--port=9000"));
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

    assert.throws(() => dev("/project"), { message: "process.exit" });
    assert.strictEqual(mockExit.mock.callCount(), 1);
    assert.deepStrictEqual(mockExit.mock.calls[0].arguments, [130]);
    mockExit.mock.restore();
  });

  void it("re-throws non-SIGINT errors", () => {
    mockExecSync.mock.mockImplementation(() => {
      throw new Error("dev failed");
    });

    assert.throws(() => dev("/project"), { message: "dev failed" });
  });
});
