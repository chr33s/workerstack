import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

register("./cloudflare-loader.ts", { parentURL: import.meta.url });

const { workerstack } = await import("./workerstack.ts");

/* ----------------------------- helpers ----------------------------- */

function mockFetcher(handler: (req: Request) => Response | Promise<Response>) {
  return { fetch: handler };
}

function jsonFetcher(body: Record<string, unknown>, status = 200) {
  return mockFetcher(
    () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

function cssFetcher(css: string) {
  return mockFetcher(
    () =>
      new Response(css, {
        headers: { "content-type": "text/css" },
      }),
  );
}

function redirectFetcher(location: string, status = 302) {
  return mockFetcher(
    () =>
      new Response(null, {
        status,
        headers: { location },
      }),
  );
}

function echoPathFetcher() {
  return mockFetcher((req) => {
    const url = new URL(req.url);
    return new Response(JSON.stringify({ path: url.pathname }), {
      headers: { "content-type": "application/json" },
    });
  });
}

/* ----------------------------- tests ----------------------------- */

void describe("WorkerStack", () => {
  void describe("routing", () => {
    void it("routes request to matching binding", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: jsonFetcher({ service: "app" }),
      };

      const resp = await workerstack(new Request("https://example.com/app"), env as any);
      assert.strictEqual(resp.status, 200);
      assert.deepStrictEqual(await resp.json(), { service: "app" });
    });

    void it("strips mount prefix before forwarding", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: echoPathFetcher(),
      };

      const resp = await workerstack(new Request("https://example.com/app/page"), env as any);
      assert.deepStrictEqual(await resp.json(), { path: "/page" });
    });

    void it("forwards mount root as /", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: echoPathFetcher(),
      };

      const resp = await workerstack(new Request("https://example.com/app"), env as any);
      assert.deepStrictEqual(await resp.json(), { path: "/" });
    });

    void it("selects most specific route by path length", async () => {
      const env = {
        ROUTES: {
          routes: [
            { binding: "APP", path: "/app" },
            { binding: "API", path: "/app/api" },
          ],
        },
        APP: jsonFetcher({ service: "app" }),
        API: jsonFetcher({ service: "api" }),
      };

      const resp = await workerstack(new Request("https://example.com/app/api/users"), env as any);
      assert.deepStrictEqual(await resp.json(), { service: "api" });
    });

    void it("falls back to root route for unmatched paths", async () => {
      const env = {
        ROUTES: {
          routes: [
            { binding: "ROOT", path: "/" },
            { binding: "APP", path: "/app" },
          ],
        },
        ROOT: jsonFetcher({ service: "root" }),
        APP: jsonFetcher({ service: "app" }),
      };

      const resp = await workerstack(new Request("https://example.com/other"), env as any);
      assert.deepStrictEqual(await resp.json(), { service: "root" });
    });

    void it("returns 404 when no route matches and no root", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: jsonFetcher({ service: "app" }),
      };

      const resp = await workerstack(new Request("https://example.com/other"), env as any);
      assert.strictEqual(resp.status, 404);
    });

    void it("matches sub-paths under a mount", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "DOCS", path: "/docs" }] },
        DOCS: echoPathFetcher(),
      };

      const resp = await workerstack(
        new Request("https://example.com/docs/getting-started"),
        env as any,
      );
      assert.deepStrictEqual(await resp.json(), { path: "/getting-started" });
    });
  });

  void describe("redirect rewriting", () => {
    void it("rewrites Location header for mounted apps", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: redirectFetcher("/login"),
      };

      const resp = await workerstack(new Request("https://example.com/app/page"), env as any);
      assert.strictEqual(resp.status, 302);
      assert.strictEqual(resp.headers.get("location"), "https://example.com/app/login");
    });

    void it("does not rewrite Location for root mount", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "ROOT", path: "/" }] },
        ROOT: redirectFetcher("/login"),
      };

      const resp = await workerstack(new Request("https://example.com/page"), env as any);
      assert.strictEqual(resp.status, 302);
      assert.strictEqual(resp.headers.get("location"), "https://example.com/login");
    });

    void it("preserves external redirect URLs", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: redirectFetcher("https://other.com/login"),
      };

      const resp = await workerstack(new Request("https://example.com/app"), env as any);
      assert.strictEqual(resp.headers.get("location"), "https://other.com/login");
    });
  });

  void describe("CSS rewriting", () => {
    void it("rewrites url() asset references in CSS", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: cssFetcher("body { background: url(/assets/bg.png); }"),
      };

      const resp = await workerstack(new Request("https://example.com/app/style.css"), env as any);
      const text = await resp.text();
      assert.ok(text.includes("url(/app/assets/bg.png)"));
    });

    void it("rewrites @import asset paths in CSS", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: cssFetcher('@import "/assets/theme.css";'),
      };

      const resp = await workerstack(new Request("https://example.com/app/style.css"), env as any);
      const text = await resp.text();
      assert.ok(text.includes('@import "/app/assets/theme.css"'));
    });

    void it("does not rewrite non-asset url() paths", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: cssFetcher("body { background: url(/images/bg.png); }"),
      };

      const resp = await workerstack(new Request("https://example.com/app/style.css"), env as any);
      const text = await resp.text();
      assert.ok(text.includes("url(/images/bg.png)"));
    });

    void it("does not rewrite CSS for root mount", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "ROOT", path: "/" }] },
        ROOT: cssFetcher("body { background: url(/assets/bg.png); }"),
      };

      const resp = await workerstack(new Request("https://example.com/style.css"), env as any);
      const text = await resp.text();
      assert.ok(text.includes("url(/assets/bg.png)"));
    });
  });

  void describe("cookie rewriting", () => {
    void it("rewrites Set-Cookie paths for mounted apps", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: mockFetcher(() => {
          const headers = new Headers({ "content-type": "application/json" });
          headers.append("Set-Cookie", "session=abc123; Path=/; HttpOnly");
          return new Response("{}", { headers });
        }),
      };

      const resp = await workerstack(new Request("https://example.com/app"), env as any);
      const cookies = resp.headers.getSetCookie();
      assert.ok(cookies.some((c) => c.includes("Path=/app/")));
    });

    void it("preserves Set-Cookie paths for root mount", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "ROOT", path: "/" }] },
        ROOT: mockFetcher(() => {
          const headers = new Headers({ "content-type": "application/json" });
          headers.append("Set-Cookie", "session=abc123; Path=/; HttpOnly");
          return new Response("{}", { headers });
        }),
      };

      const resp = await workerstack(new Request("https://example.com/"), env as any);
      const cookies = resp.headers.getSetCookie();
      assert.ok(cookies.some((c) => c.includes("Path=/;") || c.includes("Path=/ ")));
    });
  });

  void describe("configuration", () => {
    void it("throws when ROUTES is missing", async () => {
      await assert.rejects(workerstack(new Request("https://example.com/"), {} as any), {
        message: /ROUTES environment variable is required/,
      });
    });

    void it("throws when ROUTES has no route definitions", async () => {
      await assert.rejects(
        workerstack(new Request("https://example.com/"), { ROUTES: { routes: [] } } as any),
        { message: /at least one route/ },
      );
    });

    void it("throws when binding is not found in env", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
      };

      await assert.rejects(workerstack(new Request("https://example.com/app"), env as any), {
        message: /Binding "APP" not found/,
      });
    });

    void it("throws on invalid route config (missing binding)", async () => {
      const env = {
        ROUTES: { routes: [{ path: "/app" }] },
      };

      await assert.rejects(workerstack(new Request("https://example.com/"), env as any), {
        message: /Invalid route configuration/,
      });
    });

    void it("parses ROUTES from JSON string", async () => {
      const env = {
        ROUTES: JSON.stringify({ routes: [{ binding: "APP", path: "/app" }] }),
        APP: jsonFetcher({ ok: true }),
      };

      const resp = await workerstack(new Request("https://example.com/app"), env as any);
      assert.strictEqual(resp.status, 200);
    });

    void it("throws on invalid ROUTES JSON string", async () => {
      const env = { ROUTES: "{invalid json" };

      await assert.rejects(workerstack(new Request("https://example.com/"), env as any), {
        message: /Failed to parse ROUTES/,
      });
    });

    void it("supports custom ASSET_PREFIXES for CSS rewriting", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: cssFetcher("body { background: url(/custom/bg.png); }"),
        ASSET_PREFIXES: JSON.stringify(["/custom/"]),
      };

      const resp = await workerstack(new Request("https://example.com/app/style.css"), env as any);
      const text = await resp.text();
      assert.ok(text.includes("url(/app/custom/bg.png)"));
    });

    void it("ignores invalid ASSET_PREFIXES JSON", async () => {
      const env = {
        ROUTES: { routes: [{ binding: "APP", path: "/app" }] },
        APP: cssFetcher("body { background: url(/assets/bg.png); }"),
        ASSET_PREFIXES: "not-json",
      };

      const resp = await workerstack(new Request("https://example.com/app/style.css"), env as any);
      const text = await resp.text();
      // Falls back to default prefixes which include /assets/
      assert.ok(text.includes("url(/app/assets/bg.png)"));
    });
  });
});
