import { env } from "cloudflare:workers";

/**
 * WorkerStack Microfrontend Router
 *
 * A file-based metaframework router that routes requests to separate Worker
 * services based on path expressions compiled from directory-level wrangler.json
 * configurations.
 *
 * Based on the Cloudflare microfrontend-template pattern:
 * - Routes requests to service bindings based on mount expressions
 * - Strips matched mount prefix before proxying upstream
 * - Rewrites HTML/CSS asset URLs for correct resolution
 * - Rewrites redirects and cookie paths
 */

const DEFAULT_ASSET_PREFIXES = [
  "/assets/",
  "/static/",
  "/build/",
  "/_astro/",
  "/_next/",
  "/fonts/",
];

function buildAssetPrefixes(envObj: typeof env = env): string[] {
  const defaults = [...DEFAULT_ASSET_PREFIXES];

  if ("ASSET_PREFIXES" in envObj && typeof (envObj as any).ASSET_PREFIXES === "string") {
    try {
      const custom = JSON.parse((envObj as any).ASSET_PREFIXES);
      if (Array.isArray(custom)) {
        const normalized = custom
          .filter((p): p is string => typeof p === "string" && p.trim() !== "")
          .map((p) => {
            let n = p.trim();
            if (!n.startsWith("/")) n = "/" + n;
            if (!n.endsWith("/")) n = n + "/";
            return n;
          });
        return [...new Set([...defaults, ...normalized])];
      }
    } catch {
      // Use defaults on parse failure
    }
  }

  return defaults;
}

type RouteConfig = {
  binding: string;
  path: string;
  preload?: boolean;
};

type CompiledRoute = {
  expr: string;
  binding: Fetcher;
  preload?: boolean;
  re: RegExp;
  isStaticMount: boolean;
  staticMount?: string;
  baseSpecificity: number;
};

/* ----------------------------- utilities ----------------------------- */

function hasAssetPrefix(path: string, assetPrefixes: string[]): boolean {
  return assetPrefixes.some((p) => path.startsWith(p));
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  if (path !== "/" && path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

function escapeRegexLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unescapePathLiterals(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

function segmentToRegex(segmentExpr: string): string {
  let out = "";
  let i = 0;

  while (i < segmentExpr.length) {
    const ch = segmentExpr[i];

    if (ch === "\\") {
      if (i + 1 < segmentExpr.length) {
        out += escapeRegexLiteral(segmentExpr[i + 1]);
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (ch === ":") {
      const nameMatch = segmentExpr.slice(i).match(/^:([A-Za-z0-9_]+)/);
      if (!nameMatch) throw new Error(`Invalid param in segment: "${segmentExpr}"`);
      const name = nameMatch[1];
      i += 1 + name.length;

      if (segmentExpr[i] === "(") {
        let depth = 0;
        let j = i;
        for (; j < segmentExpr.length; j++) {
          const c = segmentExpr[j];
          if (c === "\\" && j + 1 < segmentExpr.length) {
            j++;
            continue;
          }
          if (c === "(") depth++;
          if (c === ")") {
            depth--;
            if (depth === 0) break;
          }
        }
        if (j >= segmentExpr.length) throw new Error(`Unclosed (...) in segment: "${segmentExpr}"`);

        const inner = segmentExpr.slice(i + 1, j);
        const innerRegex = unescapePathLiterals(inner);
        out += `(${innerRegex})`;
        i = j + 1;
      } else {
        out += "([^/]+)";
      }
      continue;
    }

    out += escapeRegexLiteral(ch);
    i++;
  }

  return out;
}

function computeBaseSpecificity(expr: string): number {
  const idx = expr.indexOf(":");
  const prefix = idx === -1 ? expr : expr.slice(0, idx);
  return prefix.length;
}

function compilePathExpr(exprRaw: string): {
  re: RegExp;
  isStaticMount: boolean;
  staticMount?: string;
} {
  const expr = normalizePath(exprRaw.trim());

  const isStaticMount =
    !expr.includes(":") && !expr.includes("(") && !expr.includes(")") && !expr.includes("\\");

  if (isStaticMount) {
    const mount = expr;
    const re = new RegExp(`^(${escapeRegexLiteral(mount)})(?:/.*)?$`);
    return { re, isStaticMount: true, staticMount: mount };
  }

  const parts = expr.split("/").filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  const mStarPlus = last.match(/^:([A-Za-z0-9_]+)([*+])$/);

  let mountPattern = "^/";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];

    if (mStarPlus && i === parts.length - 1) break;

    mountPattern += segmentToRegex(part);

    if (i < parts.length - 1 && !(mStarPlus && i === parts.length - 2)) {
      mountPattern += "/";
    }
  }

  mountPattern = mountPattern.replace(/\/$/, "");

  if (mStarPlus) {
    const op = mStarPlus[2];
    if (op === "*") {
      const re = new RegExp(`^(${mountPattern})(?:/.*)?$`);
      return { re, isStaticMount: false };
    } else {
      const re = new RegExp(`^(${mountPattern})/.+$`);
      return { re, isStaticMount: false };
    }
  } else {
    const re = new RegExp(`^(${mountPattern})(?:/.*)?$`);
    return { re, isStaticMount: false };
  }
}

/* ---------------------- HTML rewriting + injection ---------------------- */

class AllAttributesRewriter {
  constructor(
    private mount: string,
    private assetPrefixes: string[],
  ) {
    this.mount = normalizePath(mount);
  }

  private prependMount(path: string): string {
    return this.mount === "/" ? path : this.mount + path;
  }

  private isScopedToMount(path: string): boolean {
    if (this.mount === "/") return true;
    return path.startsWith(this.mount + "/");
  }

  element(el: Element) {
    const tagName = el.tagName?.toLowerCase();

    if (tagName === "link") {
      const rel = el.getAttribute("rel")?.toLowerCase();
      const href = el.getAttribute("href");
      if (rel && (rel.includes("icon") || rel.includes("shortcut")) && href) {
        if (href.startsWith("/") && !this.isScopedToMount(href)) {
          el.setAttribute("href", this.prependMount(href));
        }
      }
    }

    const commonAttrs = [
      "href",
      "src",
      "poster",
      "content",
      "action",
      "cite",
      "formaction",
      "manifest",
      "ping",
      "archive",
      "code",
      "codebase",
      "data",
      "url",
      "srcset",
      "data-src",
      "data-href",
      "data-url",
      "data-srcset",
      "data-background",
      "data-image",
      "data-link",
      "data-poster",
      "data-video",
      "data-audio",
      "component-url",
      "astro-component-url",
      "sveltekit-url",
      "renderer-url",
      "background",
      "xlink:href",
    ];

    for (const attrName of commonAttrs) {
      const val = el.getAttribute(attrName);
      if (!val) continue;

      if (attrName === "srcset") {
        const rewritten = val
          .split(",")
          .map((src) => {
            const trimmed = src.trim();
            const parts = trimmed.split(/\s+/);
            const url = parts[0];
            if (
              url.startsWith("/") &&
              !this.isScopedToMount(url) &&
              hasAssetPrefix(url, this.assetPrefixes)
            ) {
              return this.prependMount(url) + (parts[1] ? " " + parts[1] : "");
            }
            return trimmed;
          })
          .join(", ");
        if (rewritten !== val) el.setAttribute(attrName, rewritten);
        continue;
      }

      if (!val.startsWith("/")) continue;
      if (this.isScopedToMount(val)) continue;
      if (!hasAssetPrefix(val, this.assetPrefixes)) continue;
      el.setAttribute(attrName, this.prependMount(val));
    }
  }
}

class MountPathInjector {
  private injected = false;
  private mount: string;

  constructor(mount: string) {
    this.mount = normalizePath(mount);
  }

  element(el: Element) {
    if (this.injected) return;
    this.injected = true;

    const basePath = this.mount === "/" ? "/" : this.mount + "/";
    const fetchOverride =
      `(function(){` +
      `var b=window.__BASE_PATH__,s="workerstack://",f=globalThis.fetch;` +
      `function r(u){return(b==="/"?"/":b+"/")+u.slice(s.length)}` +
      `globalThis.fetch=function(i,o){` +
      `if(typeof i==="string"&&i.startsWith(s)){i=r(i)}` +
      `else if(i instanceof Request&&i.url.startsWith(s)){i=new Request(r(i.url),i)}` +
      `return f.call(globalThis,i,o)}` +
      `})()`;
    el.prepend(
      `<script>window.__BASE_PATH__=${JSON.stringify(this.mount)};${fetchOverride}</script>` +
        `<base href="${basePath}">`,
      { html: true },
    );
  }
}

class SmoothTransitionsInjector {
  private injected = false;

  element(el: Element) {
    if (this.injected) return;
    this.injected = true;

    const css = `@supports (view-transition-name: none) {
  ::view-transition-old(root),
  ::view-transition-new(root) {
    animation-duration: 0.3s;
    animation-timing-function: ease-in-out;
  }
  main { view-transition-name: main-content; }
  nav { view-transition-name: navigation; }
}`;
    el.append(`<style>${css}</style>`, { html: true });
  }
}

class SpeculationRulesInjector {
  private injected = false;
  private rulesJson: string;

  constructor(preloadMounts: string[]) {
    this.rulesJson = generateSpeculationRules(preloadMounts);
  }

  element(el: Element) {
    if (this.injected) return;
    this.injected = true;
    el.append(`<script type="speculationrules">${this.rulesJson}</script>`, {
      html: true,
    });
  }
}

class PreloadScriptInjector {
  private injected = false;
  private scriptPath: string;

  constructor(mountActual: string) {
    this.scriptPath = mountActual === "/" ? "/__mf-preload.js" : `${mountActual}/__mf-preload.js`;
  }

  element(el: Element) {
    if (this.injected) return;
    this.injected = true;
    el.append(`<script src="${this.scriptPath}" defer></script>`, {
      html: true,
    });
  }
}

/* ----------------------- headers / redirects / cookies ----------------------- */

function cloneHeadersForTransform(original: Headers): Headers {
  const headers = new Headers(original);
  headers.delete("content-length");
  headers.delete("etag");
  headers.delete("content-encoding");
  return headers;
}

function rewriteLocation(location: string, mount: string, requestUrl: URL): string {
  mount = normalizePath(mount);
  try {
    const url = new URL(location, requestUrl.origin);
    if (url.origin === requestUrl.origin && url.pathname.startsWith("/")) {
      url.pathname = mount === "/" ? url.pathname : mount + url.pathname;
      return url.toString();
    }
  } catch {
    // ignore invalid URLs
  }
  return location;
}

function rewriteSetCookie(headers: Headers, mount: string) {
  mount = normalizePath(mount);

  const getSetCookie = (headers as any).getSetCookie as undefined | (() => string[]);
  if (!getSetCookie) return;

  const cookies = getSetCookie.call(headers);
  if (!cookies || cookies.length === 0) return;

  headers.delete("Set-Cookie");
  for (const cookie of cookies) {
    if (/;\s*Path=\//i.test(cookie)) {
      const newPath = mount === "/" ? "/" : `${mount}/`;
      headers.append("Set-Cookie", cookie.replace(/;\s*Path=\//i, `; Path=${newPath}`));
    } else {
      headers.append("Set-Cookie", cookie);
    }
  }
}

/* --------------------------- preload script endpoint --------------------------- */

function getPreloadScriptResponse(preloadMounts: string[]): Response {
  const json = JSON.stringify(preloadMounts);
  const js =
    `(()=>{const routes=${json};` +
    `const run=()=>{for(const p of routes){fetch(p,{method:"GET",credentials:"same-origin",cache:"default"}).catch(()=>{});}};` +
    `if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",run,{once:true});}else{run();}` +
    `})();`;

  return new Response(js, {
    status: 200,
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

/* --------------------------- speculation rules --------------------------- */

function isChromiumBrowser(userAgent: string): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  const hasChrome = ua.includes("chrome");
  const hasEdge = ua.includes("edg/");
  const hasOpera = ua.includes("opr/");
  const hasBrave = ua.includes("brave");
  const isFirefox = ua.includes("firefox");
  const isSafari = ua.includes("safari") && !ua.includes("chrome");
  return (hasChrome || hasEdge || hasOpera || hasBrave) && !isFirefox && !isSafari;
}

function generateSpeculationRules(preloadMounts: string[]): string {
  const rules = {
    prefetch: [{ urls: preloadMounts }],
  };
  return JSON.stringify(rules);
}

/* ------------------------------ main proxy handler ------------------------------ */

async function handleMountedApp(
  request: Request,
  upstream: Fetcher,
  mountActual: string,
  assetPrefixes: string[],
  options?: {
    smoothTransitions?: boolean;
    preloadStaticMounts?: string[];
  },
): Promise<Response> {
  mountActual = normalizePath(mountActual);

  const forwardUrl = new URL(request.url);

  if (mountActual !== "/") {
    if (forwardUrl.pathname === mountActual) {
      forwardUrl.pathname = "/";
    } else if (forwardUrl.pathname.startsWith(mountActual + "/")) {
      forwardUrl.pathname = forwardUrl.pathname.slice(mountActual.length) || "/";
    }
  }

  if (options?.preloadStaticMounts?.length && forwardUrl.pathname === "/__mf-preload.js") {
    return getPreloadScriptResponse(options.preloadStaticMounts);
  }

  const upstreamResp = await upstream.fetch(new Request(forwardUrl.toString(), request));
  const headers = new Headers(upstreamResp.headers);
  const contentType = headers.get("content-type") || "";

  if (upstreamResp.status >= 300 && upstreamResp.status < 400) {
    const loc = headers.get("location");
    if (loc) headers.set("location", rewriteLocation(loc, mountActual, new URL(request.url)));
    rewriteSetCookie(headers, mountActual);
    return new Response(null, { status: upstreamResp.status, headers });
  }

  if (contentType.includes("text/html")) {
    const htmlText = await upstreamResp.text();
    const headersOut = cloneHeadersForTransform(headers);
    rewriteSetCookie(headersOut, mountActual);

    const userAgent = request.headers.get("user-agent") || "";
    const isChromium = isChromiumBrowser(userAgent);

    const rewriter = new HTMLRewriter().on(
      "*",
      new AllAttributesRewriter(mountActual, assetPrefixes),
    );
    rewriter.on("head", new MountPathInjector(mountActual));
    if (options?.smoothTransitions) rewriter.on("head", new SmoothTransitionsInjector());

    if (options?.preloadStaticMounts?.length) {
      if (isChromium) {
        rewriter.on("head", new SpeculationRulesInjector(options.preloadStaticMounts));
      } else {
        rewriter.on("body", new PreloadScriptInjector(mountActual));
      }
    }

    return rewriter.transform(
      new Response(htmlText, {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText,
        headers: headersOut,
      }),
    );
  }

  if (contentType.includes("text/css")) {
    const cssText = await upstreamResp.text();
    const headersOut = cloneHeadersForTransform(headers);
    rewriteSetCookie(headersOut, mountActual);

    const cssMountPrefix = mountActual === "/" ? "" : mountActual;

    // Rewrite url() references to asset paths
    const prefixPattern = assetPrefixes
      .map((p) => p.slice(1, -1))
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    const urlRegex = new RegExp(`url\\(\\s*(['"]?)(/(?:${prefixPattern})/)`, "g");
    let rewrittenCss = cssText.replace(urlRegex, `url($1${cssMountPrefix}$2`);

    // Rewrite @import paths to asset prefixes
    const importRegex = new RegExp(`@import\\s+(['"])(/(?:${prefixPattern})/)`, "g");
    rewrittenCss = rewrittenCss.replace(importRegex, `@import $1${cssMountPrefix}$2`);

    return new Response(rewrittenCss, {
      status: upstreamResp.status,
      statusText: upstreamResp.statusText,
      headers: headersOut,
    });
  }

  rewriteSetCookie(headers, mountActual);
  return new Response(upstreamResp.body, {
    status: upstreamResp.status,
    statusText: upstreamResp.statusText,
    headers,
  });
}

/* ------------------------------- config builder ------------------------------- */

function buildRoutes(envObj: typeof env = env): {
  routes: CompiledRoute[];
  smoothTransitions?: boolean;
} {
  if (!("ROUTES" in envObj)) {
    throw new Error(
      "ROUTES environment variable is required. Run `npm run build` to compile routes from sub-app wrangler.json files.",
    );
  }

  let parsed: any;
  const raw = (envObj as any).ROUTES;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Failed to parse ROUTES: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (raw && typeof raw === "object") {
    parsed = raw;
  } else {
    throw new Error("ROUTES must be a JSON object or a JSON string.");
  }

  const smoothTransitions: boolean | undefined =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed.smoothTransitions
      : undefined;

  const routeDefs: RouteConfig[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.routes)
      ? parsed.routes
      : [];

  if (!routeDefs.length) {
    throw new Error("ROUTES must contain at least one route definition.");
  }

  const compiled: CompiledRoute[] = [];

  for (const r of routeDefs) {
    if (!r.binding || !r.path) {
      throw new Error(`Invalid route configuration: ${JSON.stringify(r)}`);
    }

    const binding = (envObj as any)[r.binding];
    if (!binding || typeof binding.fetch !== "function") {
      throw new Error(`Binding "${r.binding}" not found or is not a valid service binding.`);
    }

    const expr = normalizePath(r.path);
    const { re, isStaticMount, staticMount } = compilePathExpr(expr);

    compiled.push({
      expr,
      binding: binding as Fetcher,
      preload: r.preload,
      re,
      isStaticMount,
      staticMount,
      baseSpecificity: computeBaseSpecificity(expr),
    });
  }

  compiled.sort((a, b) => {
    if (b.baseSpecificity !== a.baseSpecificity) return b.baseSpecificity - a.baseSpecificity;
    return b.expr.length - a.expr.length;
  });

  return { routes: compiled, smoothTransitions };
}

/* --------------------------------- fetch --------------------------------- */

export async function workerstack(request: Request, envParam?: typeof env): Promise<Response> {
  const envObj = envParam || env;
  const url = new URL(request.url);

  const { routes, smoothTransitions } = buildRoutes(envObj);

  let best: {
    route: CompiledRoute;
    mountActual: string;
    score: number;
  } | null = null;

  let rootRoute: CompiledRoute | null = null;

  for (const route of routes) {
    if (route.staticMount === "/" || route.expr === "/") {
      rootRoute = route;
    }

    const m = route.re.exec(url.pathname);
    if (!m) continue;

    const mountActual = normalizePath(m[1]);

    const score = mountActual.length * 1000000 + route.baseSpecificity * 1000 + route.expr.length;

    if (!best || score > best.score) {
      best = { route, mountActual, score };
    }
  }

  const assetPrefixes = buildAssetPrefixes(envObj);

  if (!best && rootRoute) {
    best = {
      route: rootRoute,
      mountActual: "/",
      score: 0,
    };
  }

  if (!best) return new Response("Not found", { status: 404 });

  const preloadStaticMounts = routes
    .filter(
      (r) => r.preload && r.isStaticMount && r.staticMount && r.staticMount !== best!.mountActual,
    )
    .map((r) => r.staticMount!)
    .map(normalizePath);

  return handleMountedApp(request, best.route.binding, best.mountActual, assetPrefixes, {
    smoothTransitions,
    preloadStaticMounts: preloadStaticMounts.length ? preloadStaticMounts : undefined,
  });
}

export default {
  fetch: workerstack,
};
