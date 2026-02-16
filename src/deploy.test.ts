import assert from "node:assert/strict";
import { describe, it, beforeEach, mock } from "node:test";

const mockExecSync = mock.fn();
const mockCompile = mock.fn();
const mockFindSubAppConfigs = mock.fn(() => [] as { dir: string; path: string }[]);

mock.module("node:child_process", {
  namedExports: { execSync: mockExecSync },
});

mock.module("./compile.ts", {
  namedExports: {
    compile: mockCompile,
    findSubAppConfigs: mockFindSubAppConfigs,
  },
});

const { deploy } = await import("./deploy.ts");

void describe("deploy", () => {
  beforeEach(() => {
    mockExecSync.mock.resetCalls();
    mockExecSync.mock.mockImplementation(() => {});
    mockCompile.mock.resetCalls();
    mockCompile.mock.mockImplementation(() => {});
    mockFindSubAppConfigs.mock.resetCalls();
    mockFindSubAppConfigs.mock.mockImplementation(() => []);
  });

  void it("compiles routes before deploying", () => {
    deploy("/project");
    assert.strictEqual(mockCompile.mock.callCount(), 1);
    assert.deepStrictEqual(mockCompile.mock.calls[0].arguments, ["/project"]);
  });

  void it("runs wrangler deploy for root when no sub-apps", () => {
    deploy("/project");
    assert.strictEqual(mockExecSync.mock.callCount(), 1);
    assert.deepStrictEqual(mockExecSync.mock.calls[0].arguments, [
      "npx wrangler deploy",
      { cwd: "/project", stdio: "inherit" },
    ]);
  });

  void it("deploys each sub-app then root", () => {
    mockFindSubAppConfigs.mock.mockImplementation(() => [
      { dir: "app", path: "/project/app/wrangler.json" },
      { dir: "api", path: "/project/api/wrangler.json" },
    ]);

    deploy("/project");

    assert.strictEqual(mockExecSync.mock.callCount(), 3);
    assert.deepStrictEqual(mockExecSync.mock.calls[0].arguments, [
      "npx wrangler deploy",
      { cwd: "/project/app", stdio: "inherit" },
    ]);
    assert.deepStrictEqual(mockExecSync.mock.calls[1].arguments, [
      "npx wrangler deploy",
      { cwd: "/project/api", stdio: "inherit" },
    ]);
    assert.deepStrictEqual(mockExecSync.mock.calls[2].arguments, [
      "npx wrangler deploy",
      { cwd: "/project", stdio: "inherit" },
    ]);
  });

  void it("passes extra args to wrangler deploy", () => {
    deploy("/project", ["--dry-run"]);

    assert.deepStrictEqual(mockExecSync.mock.calls[0].arguments, [
      "npx wrangler deploy --dry-run",
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

    assert.throws(() => deploy("/project"), { message: "process.exit" });
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

    assert.throws(() => deploy("/project"), { message: "process.exit" });
    assert.strictEqual(mockExit.mock.callCount(), 1);
    assert.deepStrictEqual(mockExit.mock.calls[0].arguments, [130]);
    mockExit.mock.restore();
  });

  void it("re-throws non-SIGINT errors", () => {
    mockExecSync.mock.mockImplementation(() => {
      throw new Error("deploy failed");
    });

    assert.throws(() => deploy("/project"), { message: "deploy failed" });
  });
});
