/**
 * The closed table of stdio adapters this build knows: which protocol name a
 * dispatch record selects, which module file name identifies the adapter in a
 * role command, which provider executable it launches, and the exact shape of
 * that executable's `--version` stdout. No om/* imports and no side effects so
 * engine, adapter and estimate boundaries share one classification.
 */

export type StdioProtocol = "codex-stdio" | "devin-stdio";

/** The version stdout shape as immutable data only: a RegExp instance carries a
 * mutable matcher (`compile` rewrites the internal pattern even on a frozen
 * object), so the policy stores just source and flags; every check builds its
 * own RegExp at the point of use and never hands out the one it ran. */
export interface StdioVersionPattern { readonly source: string; readonly flags: string }

export interface StdioProvider {
  /** The protocol name persisted in dispatch-adapter records and omg-agent requests. */
  protocol: StdioProtocol;
  /** The module basename identifying this adapter inside a role command's args[0]. */
  module: string;
  /** The provider executable the adapter launches and runtime evidence probes. */
  executable: string;
  /** The exact bounded shape of `<executable> --version` stdout. */
  versionPattern: StdioVersionPattern;
}

/** Builds an independent matcher for the provider's version stdout. */
export function stdioVersionMatcher(provider: StdioProvider): RegExp {
  return new RegExp(provider.versionPattern.source, provider.versionPattern.flags);
}

// The policy itself is closed: every descriptor and its nested version pattern is frozen,
// and the lookups below hand out copies, so no caller can mutate the classification.
export const STDIO_PROVIDERS: readonly StdioProvider[] = Object.freeze(
  ([{ protocol: "codex-stdio", module: "codex-stdio.js", executable: "codex", versionPattern: { source: "^codex-cli [^\\r\\n]+\\s*$", flags: "" } },
    { protocol: "devin-stdio", module: "devin-stdio.js", executable: "devin", versionPattern: { source: "^devin [^\\r\\n]+\\s*$", flags: "" } },
  ] as StdioProvider[]).map(provider => Object.freeze({ ...provider, versionPattern: Object.freeze({ ...provider.versionPattern }) })));

/** Every protocol name a dispatch-adapter record may lawfully select. */
export const STDIO_PROTOCOLS: readonly string[] = Object.freeze(STDIO_PROVIDERS.map(provider => provider.protocol));

export function stdioProviderByModule(name: unknown): StdioProvider | null {
  const provider = STDIO_PROVIDERS.find(provider => provider.module === name);
  return provider ? { ...provider } : null;
}

export function stdioProviderByProtocol(protocol: unknown): StdioProvider | null {
  const provider = STDIO_PROVIDERS.find(provider => provider.protocol === protocol);
  return provider ? { ...provider } : null;
}

export function isStdioProtocol(protocol: unknown): protocol is StdioProtocol {
  return stdioProviderByProtocol(protocol) !== null;
}
