import type { LoadHook, ResolveHook } from "node:module";

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  if (specifier.startsWith("cloudflare:")) {
    return { url: specifier, shortCircuit: true };
  }
  return nextResolve(specifier, context);
};

export const load: LoadHook = async (url, context, nextLoad) => {
  if (url.startsWith("cloudflare:")) {
    return {
      format: "module",
      source: "export const env = {};",
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
};
