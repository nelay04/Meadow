/**
 * The published JSON Schema for the glade file, kept in step with the zod schema.
 *
 * `packages/schema/glade.schema.json` is for readers that are not this codebase: another
 * tool, a script in another language, or a language model asked to write a glade. It is
 * generated from `gladeFile` rather than written by hand, and this test fails when the
 * two drift apart. To regenerate after changing the format:
 *
 *   pnpm --filter web exec vitest run interchange.schema -u
 */

import { GLADE_VERSION, gladeFile } from '@meadow/schema'
import { describe, expect, it } from 'vitest'
import { zodToJsonSchema } from 'zod-to-json-schema'

function generate(): string {
  const schema = zodToJsonSchema(gladeFile, {
    name: 'GladeFile',
    // Recursive rich text and meta need references; `seen` would inline them forever.
    $refStrategy: 'root',
  })
  const document = {
    title: `Meadow glade, format version ${GLADE_VERSION}`,
    description:
      'One Meadow board (a glade) as JSON: every object with its fields and rich text, arrow bindings, z-order and board metadata. Exporting, importing and exporting again produces the same file.',
    ...schema,
  }
  return `${JSON.stringify(document, null, 2)}\n`
}

describe('glade.schema.json', () => {
  it('matches the zod schema it is generated from', async () => {
    await expect(generate()).toMatchFileSnapshot('../../../../packages/schema/glade.schema.json')
  })
})
