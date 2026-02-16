import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { unstable_startWorker as startWorker } from "wrangler";

let worker: Awaited<ReturnType<typeof startWorker>>;
let workers: Awaited<ReturnType<typeof startWorker>>[];

before(
  async () => {
    const registry = mkdtempSync(join(tmpdir(), "workerstack-test-"));

    const configs = [
      "./spec/app/api/wrangler.json",
      "./spec/_root/wrangler.json",
      "./spec/app/wrangler.json",
    ];

    // Start sub-workers first and wait for each to register
    workers = [];
    for (const config of configs) {
      const w = await startWorker({
        config,
        dev: { server: { port: 0 }, inspector: false, registry },
      });
      await w.ready;
      workers.push(w);
    }

    // Start primary router after sub-workers are registered
    worker = await startWorker({
      config: "./spec/wrangler.json",
      dev: {
        server: { port: 0 },
        inspector: false,
        registry,
        multiworkerPrimary: true,
      },
    });
    await worker.ready;
  },
  { timeout: 30_000 },
);

after(async () => {
  await worker?.dispose();
  await Promise.all(workers?.map((w) => w.dispose()) ?? []);
});

async function fetchWorker(path: string): Promise<Response> {
  const url = await worker.url;
  return fetch(new URL(path, url));
}

void describe("WorkerStack Router", () => {
  void describe("routing", () => {
    void it("routes /app requests to app worker", async () => {
      const response = await fetchWorker("/app");
      assert.strictEqual(response.status, 200);

      const html = await response.text();
      assert.ok(html.includes("<title>App</title>"));
      assert.ok(html.includes('<div id="root"></div>'));
    });

    void it("routes /app/subpath to app worker (404 when asset missing)", async () => {
      const response = await fetchWorker("/app/subpath");
      assert.strictEqual(response.status, 404);
    });

    void it("routes /app/api requests to api worker", async () => {
      const response = await fetchWorker("/app/api");
      assert.strictEqual(response.status, 200);

      const json: any = await response.json();
      assert.strictEqual(json.path, "/");
      assert.strictEqual(json.method, "GET");
    });

    void it("routes /app/api/health to api worker with stripped prefix", async () => {
      const response = await fetchWorker("/app/api/health");
      assert.strictEqual(response.status, 200);

      const json: any = await response.json();
      assert.strictEqual(json.status, "ok");
      assert.ok("timestamp" in json);
    });
  });

  void describe("URL rewriting", () => {
    void it("rewrites asset URLs in HTML from /app", async () => {
      const response = await fetchWorker("/app");
      const html = await response.text();

      assert.ok(html.includes('href="/app/assets/index.css"'));
      assert.ok(html.includes('src="/app/assets/index.js"'));
    });
  });
});
