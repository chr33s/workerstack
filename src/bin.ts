#!/usr/bin/env node

import { resolve } from "node:path";

const [command, ...args] = process.argv.slice(2);
const root = resolve(process.cwd());

switch (command) {
  case "build": {
    const { build } = await import("./build.ts");
    build(root, args);
    break;
  }
  case "dev": {
    const { dev } = await import("./dev.ts");
    dev(root, args);
    break;
  }
  case "deploy": {
    const { deploy } = await import("./deploy.ts");
    deploy(root, args);
    break;
  }
  default:
    console.error(`Unknown command: ${command ?? "(none)"}`);
    console.error("Usage: workerstack <build|dev|deploy> [-- ...wrangler args]");
    process.exit(1);
}
