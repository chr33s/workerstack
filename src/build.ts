import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { compile, ensureAssetsDir, findSubAppConfigs } from "./compile.ts";

export function build(root: string, args: string[] = []): void {
  console.log("Compiling workerstack routes...\n");
  compile(root);

  const subApps = findSubAppConfigs(root);
  const extra = args.length ? " " + args.join(" ") : "";

  try {
    for (const subApp of subApps) {
      const cwd = dirname(subApp.path);
      ensureAssetsDir(subApp.path);
      console.log(`\nBuilding ${subApp.dir}...`);
      execSync(`npx wrangler build${extra}`, { cwd, stdio: "inherit" });
    }

    console.log("\nBuilding root...\n");
    execSync(`npx wrangler build${extra}`, { cwd: root, stdio: "inherit" });
  } catch (e: any) {
    if (e.signal === "SIGINT" || e.status === 130) process.exit(130);
    throw e;
  }
}
