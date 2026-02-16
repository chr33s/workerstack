import { execSync } from "node:child_process";
import { relative } from "node:path";
import { compile, ensureAssetsDir, findSubAppConfigs } from "./compile.ts";

export function dev(root: string, args: string[] = []): void {
  console.log("Compiling WorkerStack routes...\n");
  compile(root);

  const subApps = findSubAppConfigs(root);
  subApps.forEach((s) => ensureAssetsDir(s.path));
  const configs = ["--config=wrangler.json"].concat(
    subApps.map((s) => `--config=${relative(root, s.path)}`),
  );
  const extra = args.length ? " " + args.join(" ") : "";

  console.log("\nStarting wrangler dev...\n");
  try {
    execSync(`npx wrangler dev ${configs.join(" ")}${extra}`, {
      cwd: root,
      stdio: "inherit",
    });
  } catch (e: any) {
    if (e.signal === "SIGINT" || e.status === 130) process.exit(130);
    throw e;
  }
}
