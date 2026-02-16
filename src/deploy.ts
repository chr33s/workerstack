import { execSync } from "node:child_process";
import { dirname } from "node:path";
import { compile, findSubAppConfigs } from "./compile.ts";

export function deploy(root: string, args: string[] = []): void {
  console.log("Compiling WorkerStack routes...\n");
  compile(root);

  const subApps = findSubAppConfigs(root);
  const extra = args.length ? " " + args.join(" ") : "";

  try {
    for (const subApp of subApps) {
      const cwd = dirname(subApp.path);
      console.log(`\nDeploying ${subApp.dir}...`);
      execSync(`npx wrangler deploy${extra}`, { cwd, stdio: "inherit" });
    }

    console.log("\nDeploying root...\n");
    execSync(`npx wrangler deploy${extra}`, { cwd: root, stdio: "inherit" });
  } catch (e: any) {
    if (e.signal === "SIGINT" || e.status === 130) process.exit(130);
    throw e;
  }
}
