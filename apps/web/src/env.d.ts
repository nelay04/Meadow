/// <reference types="vite/client" />

// An interface rather than a type, the one exception to the rule: this adds a field to
// Vite's own `ImportMetaEnv`, and only an interface merges with the declaration it names.
interface ImportMetaEnv {
  /** This app's version, from apps/web/package.json. Defined in vite.config.ts. */
  readonly MEADOW_VERSION: string
}
