import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const root = resolve(import.meta.dirname, "..");
const bin = resolve(root, "src/bin.ts");

function run(args: string): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execSync(`node ${bin} ${args}`, {
      cwd: root,
      stdio: "pipe",
      timeout: 10_000,
    }).toString();
    return { stdout, stderr: "", status: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
      status: e.status ?? 1,
    };
  }
}

void describe("bin", () => {
  void it("exits with error when no command is given", () => {
    const { stderr, status } = run("");
    assert.strictEqual(status, 1);
    assert.ok(stderr.includes("Unknown command: (none)"));
    assert.ok(stderr.includes("Usage:"));
  });

  void it("exits with error for unknown command", () => {
    const { stderr, status } = run("unknown");
    assert.strictEqual(status, 1);
    assert.ok(stderr.includes("Unknown command: unknown"));
  });

  void it("shows usage hint on error", () => {
    const { stderr } = run("foobar");
    assert.ok(stderr.includes("workerstack <build|dev|deploy>"));
  });
});
