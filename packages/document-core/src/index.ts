/**
 * The document layer: the CRDT write path, the interchange format, and rich text.
 *
 * Extracted from `apps/web/src/doc` so that the MCP server stops reaching into the web
 * app's source for it. Both sides share one mutation implementation on purpose - an AI
 * edit and a human edit take the same path, which is the same reasoning as the canvas
 * never reading through React - and before this package the sharing was five relative
 * imports climbing out of `packages/mcp` into `apps/web`, which no manifest declared.
 *
 * What belongs here is anything that reads or writes a Y.Doc and needs nothing from a
 * browser or from React. What does not: the React bindings (`useObjects`), the canvas
 * host (`engineHost`), clipboard handling, and the app-facing schema shim, all of which
 * stay in `apps/web/src/doc`.
 */
export * from './interchange'
export * from './mutations'
export * from './richText'
export * from './roles'
