import path from "node:path";

/**
 * Shared loader for the optional Rust native extension. Resolution goes
 * through the napi-rs generated `index.js` platform picker (which selects
 * `index.<platform>.node` for the current OS/arch) rather than a hardcoded
 * single-platform binary.
 *
 * `OPENEZ_NATIVE=0` disables the extension entirely — it is checked on every
 * call so the kill switch always wins over a cached binding. A missing or
 * failing binding returns `null` and never throws, so callers fall back to
 * the WASM/regex parsers and the fast-glob scanner.
 *
 * The result of the default resolution is cached for the process. Passing
 * `candidates` overrides the default specifier list (used by tests to force a
 * load failure or inject a stub); a candidates-based call is evaluated
 * fresh each time and does not touch the shared cache.
 */
let cachedBinding: unknown | null | undefined;

export function isNativeDisabled(): boolean {
  return process.env.OPENEZ_NATIVE === "0";
}

export function loadNativeBinding(candidates?: string[]): unknown | null {
  if (isNativeDisabled()) return null;
  if (!candidates && cachedBinding !== undefined) return cachedBinding;

  const specifiers = candidates ?? [
    path.join(__dirname, "native", "index.js"),
    "@openez-graph/native",
  ];
  for (const specifier of specifiers) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const binding = require(specifier) as unknown;
      if (!candidates) cachedBinding = binding;
      return binding;
    } catch {
      // try the next candidate
    }
  }
  if (!candidates) cachedBinding = null;
  return null;
}

/**
 * Reset the cached default resolution. Exposed for tests that need to
 * simulate the native extension being unavailable.
 */
export function resetNativeBindingCache(): void {
  cachedBinding = undefined;
}
