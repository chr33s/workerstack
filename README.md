> [!WARNING]
> Experimental: API is unstable and not production-ready.

# WorkerStack

File-based routing for Cloudflare Workers microfrontends|services. Directories with `wrangler.json` files become routes, compiled into a unified router.

Based on the [Cloudflare microfrontend-template](https://github.com/cloudflare/templates/tree/main/microfrontend-template).

## Quick Start

```bash
npm install @chr33s/workerstack
```

```
wrangler.json              <- Router (auto-generated)
_root/wrangler.json        <- /  (root content & assets)
app/wrangler.json          <- /app
app/api/wrangler.json      <- /app/api
```

```ts
// index.ts
import { workerstack } from "@chr33s/workerstack";
export default { fetch: (request: Request) => workerstack(request) };
```

```json
{
  "scripts": {
    "build": "workerstack build",
    "dev": "workerstack dev",
    "deploy": "workerstack deploy"
  }
}
```

## CLI

```
workerstack <build|dev|deploy> [-- ...wrangler args]
```

| Command  | Description                                                        |
| -------- | ------------------------------------------------------------------ |
| `build`  | Compile routes, then `wrangler build` each sub-app and the root    |
| `dev`    | Compile routes, then start `wrangler dev` with multi-worker config |
| `deploy` | Compile routes, then `wrangler deploy` each sub-app and the root   |

Extra arguments are forwarded to wrangler.

## Conventions

- Directory name → route path (`app/api` → `/app/api`)
- Deeper paths match first (`/app/api` before `/app`)
- Unmatched paths fall through to the root worker
- Binding names derived from `name` field (`app-api` → `APP_API`)
- Existing root `wrangler.json` settings are preserved during compile
- Sub-apps with `assets` and nested children get `run_worker_first` rules automatically

## `_root` Directory

The `_root/` directory is a special sub-app that maps to `/` instead of `/_root`. Use it to serve root-level assets — the entrypoint router should **not** have its own `assets` block (causes dev-mode collisions):

```json
// _root/wrangler.json
{
  "name": "root",
  "main": "./index.ts",
  "assets": { "directory": "./public", "binding": "ASSETS" }
}
```

```ts
// _root/index.ts
export default {
  async fetch(request: Request, env: Env) {
    return env.ASSETS.fetch(request);
  },
};
```

## Router

The router matches requests by path, strips the mount prefix, proxies to the service binding, and rewrites the response:

- **Path stripping** — `/app/api/users` → upstream sees `/users`
- **Asset URL rewriting** — HTML and CSS asset references prefixed with mount path
- **Redirect rewriting** — `Location: /login` → `Location: /app/login`
- **Cookie path scoping** — `Path=/` → `Path=/app/`
- **Mount path injection** — `window.__BASE_PATH__`, `<base href>`, and `workerstack://` fetch scheme
- **View transitions** — optional `smoothTransitions` in ROUTES config
- **Preloading** — `preload: true` emits speculation rules or fetch-based preload

### Client-Side Mount Awareness

HTML responses get a `<script>` and `<base>` tag injected into `<head>`:

```html
<script>
  window.__BASE_PATH__ = "/app"; /* workerstack:// fetch override */
</script>
<base href="/app/" />
```

- **`<base href>`** — browser resolves relative URLs against the mount (`<a href="settings">` → `/app/settings`)
- **`window.__BASE_PATH__`** — explicit access to the mount path for scripts
- **`workerstack://` scheme** — mount-relative fetch without risk of double-prefixing:

```js
fetch("workerstack://api/data"); // → /app/api/data
fetch("workerstack://settings"); // → /app/settings
fetch("/other/path"); // untouched
```

### Asset Prefixes

Default: `/assets/`, `/static/`, `/build/`, `/_astro/`, `/_next/`, `/fonts/`

Add custom prefixes:

```json
{ "vars": { "ASSET_PREFIXES": "[\"/media/\", \"/images/\"]" } }
```

## Testing

```bash
npm test
npm run test -- src/{bin,build,compile,deploy,dev,workerstack}.test.ts  # unit
npm run test -- src/integration.test.ts                                 # integration
```
