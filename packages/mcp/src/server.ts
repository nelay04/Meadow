/**
 * The Meadow MCP server: tools and resources over a token-scoped view of Meadow.
 *
 * Reads come back as the graph (`gladeToGraph`), because that is what a model reasons
 * about; the lossless file is there too, for when it needs a field the graph leaves out.
 * Writes are planned in `plan.ts`, applied in one transaction through `applyEdits`, and
 * every one of them takes `preview` to return the plan without touching the board.
 */

import {
  type GladeFile,
  type GladeGraph,
  type GraphEdge,
  type GraphNode,
  GLADE_MAX_BYTES,
  gladeReportIsClean,
  gladeToGraph,
  parseGladeFile,
  richTextToPlain,
} from '@meadow/schema'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

import { exportGlade } from '../../../apps/web/src/doc/interchange'
import {
  type EditBatch,
  EditReferenceError,
  ImportTargetError,
  ReadOnlyError,
  applyEdits,
  importGlade,
} from '../../../apps/web/src/doc/mutations'
import { type ToolNeeds, describeBoundaries, usable } from './access'
import { MeadowApi, MeadowApiError, type TokenInfo } from './api'
import { type DiagramSpec, MermaidError, graphToMermaid, parseMermaid } from './mermaid'
import { PlanError, planCreate, planDiagram, planRemove, planUpdate } from './plan'
import { type Action, type Room, RoomError, Rooms, allowedPhrase, refusal } from './room'
import { textToRich } from './text'
import { VERSION } from './version'
import { type Look, lookAt, previewCopy } from './look'
import { DEFAULT_SNAPSHOT_WIDTH, MAX_SNAPSHOT_WIDTH } from './snapshot'
import { checkLayout, planTidy } from './tidy'

export { VERSION }

const INSTRUCTIONS = `Meadow is an infinite-canvas whiteboard. A board is called a glade.

How to work with it:
- list_glades to find a glade id, then get_glade_summary for its size and what is on it.
- get_glade_graph reads it as nodes (shapes, stickies, text) and edges (arrows and lines, with the ids of what they connect). export_mermaid is a cheaper read of the same structure.
- Every object keeps its id, so read first and then edit by id with update_objects, delete_objects and set_text.
- To draw or extend a diagram, prefer apply_diagram: give nodes and edges (or Mermaid), and it matches existing nodes by id or label, adds what is missing and lays new nodes out beside the existing content. create_nodes and connect are the lower-level versions.
- Leave out x, y, w and h and the server lays nodes out and sizes them to their labels, and chooses where each arrow attaches and bends. Only give coordinates to match something already on the glade. Coordinates are world units: x grows right, y grows down.
- Keep node labels short: a title, and at most a short second line. Put detail in a separate note rather than a bullet list inside a flowchart box.
- get_glade_snapshot returns a picture of the glade, optionally with its nodes and edges beside it.
- Every write reports layout problems it left (text overflowing a shape, a line through a shape, overlapping lines or labels). When it does, or when a glade looks messy, call tidy_layout, then check_layout to confirm.
- Pass preview: true to any write to see what it would do without changing the glade. A preview works even where the write itself is not allowed.
- Labels accept light Markdown: **bold**, *italic*, # headings and - bullets.
Edits appear live for anyone with the glade open.`

const LOOKING = `Looking at the result:
- Writes that add or change objects, and their previews, return a picture of the area they touched beside the JSON. Look at it every time before saying a diagram is done: check that text fits, lines do not cross shapes and labels are readable, and fix what you see.
- Pass snapshot: false on a write to leave the picture out, for example during a long run of small edits, and look once at the end with get_glade_snapshot.`

type Json = Record<string, unknown> | unknown[]

function ok(value: Json): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

function refused(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] }
}

/** Expected refusals become a message the model can act on; anything else is a bug and throws. */
async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run()
  } catch (error) {
    if (
      error instanceof MeadowApiError ||
      error instanceof RoomError ||
      error instanceof PlanError ||
      error instanceof EditReferenceError ||
      error instanceof MermaidError ||
      error instanceof ReadOnlyError ||
      error instanceof ImportTargetError
    ) {
      return refused(error.message)
    }
    throw error
  }
}

const gladeId = z.string().min(1).describe('The glade id, from list_glades.')
const preview = z
  .boolean()
  .optional()
  .describe('Return what would change without changing the glade.')
const snapshotArg = z
  .boolean()
  .optional()
  .describe('Attach a picture of the result. Default true; false leaves it out.')

/** Writes carry a smaller picture than get_glade_snapshot: enough to judge, cheaper to read. */
const WRITE_SNAPSHOT_WIDTH = 1000
const region = z
  .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
  .describe('Only objects that overlap this rectangle, in world units.')
const colour = z.string().describe('Hex colour, e.g. #f4d35e.')
const nodeType = z
  .enum([
    'rect',
    'ellipse',
    'diamond',
    'parallelogram',
    'triangle',
    'trapezoid',
    'polygon',
    'cylinder',
    'sticky',
    'text',
  ])
  .describe(
    'Shape. rect by default; diamond for decisions, cylinder for data stores, sticky for notes, text for free text.',
  )
const direction = z
  .enum(['forward', 'back', 'both', 'none'])
  .describe('Arrowheads: forward points from -> to. Default forward for arrows, none for lines.')
const routing = z
  .enum(['straight', 'curved', 'orthogonal'])
  .describe('Path style. orthogonal draws elbows.')

const nodeInput = z.object({
  ref: z
    .string()
    .optional()
    .describe('A name for this node that edges in the same call can use in from/to.'),
  type: nodeType.optional(),
  label: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  fill: colour.optional(),
  stroke: colour.optional(),
  text_color: colour.optional(),
  font_size: z.number().min(6).max(288).optional(),
  parent: z.string().optional().describe('Id or ref of a frame this node sits in.'),
})

const edgeInput = z.object({
  ref: z.string().optional(),
  from: z.string().describe('Id of an object on the glade, or a ref from this call.'),
  to: z.string().describe('Id of an object on the glade, or a ref from this call.'),
  label: z.string().optional(),
  direction: direction.optional(),
  routing: routing.optional(),
  type: z.enum(['arrow', 'line']).optional(),
  stroke: colour.optional(),
})

function overlaps(
  item: { x: number; y: number; w: number; h: number },
  area: z.infer<typeof region>,
): boolean {
  const minX = Math.min(item.x, item.x + item.w)
  const maxX = Math.max(item.x, item.x + item.w)
  const minY = Math.min(item.y, item.y + item.h)
  const maxY = Math.max(item.y, item.y + item.h)
  return minX <= area.x + area.w && maxX >= area.x && minY <= area.y + area.h && maxY >= area.y
}

function snapshot(room: Room): GladeFile {
  return exportGlade(
    room.session,
    { title: room.board.title, kind: room.board.kind },
    { app: `meadow-mcp ${VERSION}` },
  )
}

function graphOf(room: Room): GladeGraph {
  return gladeToGraph(snapshot(room))
}

/** A batch as a model reads it: what would be made, changed and removed. */
function describeBatch(batch: EditBatch): Json {
  return {
    create: (batch.create ?? []).map(({ ref, object, text }) => ({
      ref,
      type: object.type,
      ...(object.type === 'arrow' || object.type === 'line'
        ? {}
        : { x: object.x, y: object.y, w: object.w, h: object.h }),
      label: richTextToPlain(text ?? null),
      ...(object.props === undefined || Object.keys(object.props).length === 0
        ? {}
        : { props: object.props }),
    })),
    connect: batch.connect ?? [],
    update: (batch.update ?? []).map(({ id, patch, text }) => ({
      id,
      ...patch,
      ...(text === undefined ? {} : { label: richTextToPlain(text) }),
    })),
    remove: batch.remove ?? [],
  }
}

export type ServerOptions = {
  api: MeadowApi
  idleMs: number
  /** The token describing itself, read before the server is built so the instructions carry it. */
  access: TokenInfo
  /**
   * Attach a picture to writes and previews. On unless the operator turns it off for
   * clients that cannot show images (`--no-snapshots`).
   */
  snapshots?: boolean
}

/** What a batch would need: edit for anything it creates, changes or connects; delete for removals. */
function needsOf(batch: EditBatch): Action[] {
  const needs: Action[] = []
  if ((batch.create?.length ?? 0) + (batch.update?.length ?? 0) + (batch.connect?.length ?? 0) > 0)
    needs.push('edit')
  if ((batch.remove?.length ?? 0) > 0) needs.push('delete')
  return needs
}

export function createServer({
  api,
  idleMs,
  access: initialAccess,
  snapshots = true,
}: ServerOptions): {
  server: McpServer
  close: () => void
} {
  const server = new McpServer(
    { name: 'meadow', version: VERSION },
    {
      instructions: `${INSTRUCTIONS}${snapshots ? `\n${LOOKING}` : ''}\n\n${describeBoundaries(initialAccess)}`,
    },
  )

  let access = initialAccess
  // Every tool, with what it needs, so a token that can never use one does not offer it.
  const gated: {
    tool: { enable: () => void; disable: () => void; enabled: boolean }
    needs: ToolNeeds
  }[] = []
  const gate = (
    tool: { enable: () => void; disable: () => void; enabled: boolean },
    needs: ToolNeeds,
  ): void => {
    gated.push({ tool, needs })
    if (!usable(access, needs)) tool.disable()
  }
  /** Re-read the token, and switch tools on or off if what it may do has changed. */
  const refreshAccess = async (): Promise<TokenInfo> => {
    access = await api.currentToken()
    for (const { tool, needs } of gated) {
      const want = usable(access, needs)
      if (want && !tool.enabled) tool.enable()
      if (!want && tool.enabled) tool.disable()
    }
    return access
  }

  let userId: string | null = null
  const me = async (): Promise<{
    id: string
    default_workspace_id: string | null
  }> => {
    const account = await api.me()
    userId = account.id
    return account
  }

  let rooms: Rooms | null = null
  const roomsFor = async (): Promise<Rooms> => {
    if (rooms !== null) return rooms
    if (userId === null) await me()
    rooms = new Rooms(
      api,
      {
        userId: userId ?? 'mcp',
        name: () => {
          const client = server.server.getClientVersion()?.name
          return client === undefined || client === ''
            ? 'AI assistant (via MCP)'
            : `${client} (via MCP)`
        },
      },
      idleMs,
    )
    return rooms
  }

  const openRoom = async (id: string): Promise<Room> => (await roomsFor()).get(id)

  /**
   * A picture of some objects, for a tool result. A picture that fails to render never
   * fails the write it belongs to; the result says why it is missing instead.
   */
  const picture = async (
    session: Room['session'],
    room: Room,
    ids: readonly string[],
  ): Promise<{ look: Look | null; note?: string }> => {
    if (ids.length === 0) return { look: null }
    try {
      const look = await lookAt(
        session,
        { title: room.board.title, kind: room.board.kind },
        { ids, maxWidth: WRITE_SNAPSHOT_WIDTH },
      )
      return { look }
    } catch (error) {
      return { look: null, note: `No picture: ${(error as Error).message}` }
    }
  }

  /** A JSON result, with a picture after it when there is one. */
  const withPicture = (value: Json, look: { look: Look | null; note?: string }): CallToolResult => {
    const body =
      look.look === null
        ? look.note === undefined
          ? value
          : { ...value, snapshot: look.note }
        : { ...value, snapshot: look.look.details }
    const result = ok(body as Json)
    if (look.look !== null) result.content.push(look.look.image)
    return result
  }

  /** Plan, then preview or apply, then point the cursor at the result. */
  const edit = async (
    id: string,
    wantPreview: boolean | undefined,
    plan: (room: Room) => Promise<{ batch: EditBatch; extra?: Record<string, unknown> }>,
    wantSnapshot?: boolean,
  ): Promise<CallToolResult> => {
    const room = await openRoom(id)
    const { batch, extra } = await plan(room)
    const look = snapshots && wantSnapshot !== false
    // After planning, so the refusal names exactly what the batch needed. Checked here
    // so a model gets a reason; the server drops the write regardless.
    const blocked = needsOf(batch)
      .map((action) => refusal(room, action))
      .filter((reason): reason is string => reason !== null)
    if (wantPreview === true) {
      const described = {
        preview: true,
        ...(blocked.length === 0 ? {} : { would_be_refused: blocked }),
        ...extra,
        ...describeBatch(batch),
      }
      if (!look) return ok(described)
      // Drawn from a copy with the plan applied; the glade itself is not touched.
      let drawn: { look: Look | null; note?: string }
      try {
        const { copy, result } = previewCopy(room.session, batch)
        drawn = await picture(copy, room, [...Object.values(result.ids), ...result.updated])
        copy.doc.destroy()
      } catch (error) {
        drawn = { look: null, note: `No picture: ${(error as Error).message}` }
      }
      return withPicture(described, drawn)
    }
    if (blocked.length > 0) return refused(blocked.join('\n'))

    const result = applyEdits(room.session, batch)
    await (await roomsFor()).flush(room)

    const touched = [...Object.values(result.ids), ...result.updated]
    const graph = graphOf(room)
    const placed = graph.nodes.filter((node) => touched.includes(node.id))
    const centre =
      placed.length === 0
        ? null
        : {
            x: placed.reduce((sum, node) => sum + node.x + node.w / 2, 0) / placed.length,
            y: placed.reduce((sum, node) => sum + node.y + node.h / 2, 0) / placed.length,
          }
    ;(await roomsFor()).show(room, touched, centre)

    // Only what this write touched: a removal has nothing left to look at, and problems
    // elsewhere on the glade are not this write's to report.
    const problems =
      touched.length === 0
        ? {}
        : Object.fromEntries(
            Object.entries(checkLayout(room.session, touched).counts).filter(([, n]) => n > 0),
          )

    return withPicture(
      {
        ...extra,
        ...(touched.length === 0
          ? {}
          : Object.keys(problems).length === 0
            ? { layout: 'clean' }
            : {
                layout_problems: problems,
                hint: 'check_layout lists them; tidy_layout fixes most.',
              }),
        ids: result.ids,
        updated: result.updated,
        removed: result.removed,
        nodes: placed,
        edges: graph.edges.filter((edge) => touched.includes(edge.id)),
      },
      look ? await picture(room.session, room, touched) : { look: null },
    )
  }

  // --- reading ---------------------------------------------------------------------------

  server.registerTool(
    'list_glades',
    {
      title: 'List glades',
      description:
        'Every glade this access token can open, most recently changed first, with what may be done on each (can_edit, can_delete).',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        const [boards] = await Promise.all([api.listBoards(), refreshAccess()])
        return ok(
          boards.map((board) => ({
            id: board.id,
            title: board.title,
            kind: board.kind,
            role: board.role,
            can_edit: board.can_edit,
            can_delete: board.can_delete,
            allowed: allowedPhrase(board),
            locked: board.is_locked,
            has_password: board.has_password,
            updated_at: board.updated_at,
          })),
        )
      }),
  )

  server.registerTool(
    'get_my_access',
    {
      title: 'What this token may do',
      description:
        'The access token behind this server: classic (everything the account can do) or fine-grained, and for a fine-grained token every glade it can open with its read, edit and delete permissions. Call this before editing if unsure.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      guarded(async () => {
        const info = await refreshAccess()
        return ok({
          token: info.name,
          kind: info.kind,
          expires_at: info.expires_at,
          can_create_glades: info.can_create_glades,
          glades:
            info.grants === null
              ? 'every glade the account can open; list_glades shows what the role and locks allow on each'
              : info.grants.map((grant) => ({
                  id: grant.board_id,
                  title: grant.title,
                  read: grant.read,
                  edit: grant.edit,
                  delete: grant.delete,
                })),
          note: "The account's role and the owner's lock can narrow these further on a glade. list_glades shows the result.",
        })
      }),
  )

  server.registerTool(
    'get_glade_summary',
    {
      title: 'Summarise a glade',
      description:
        'Size, bounds, object counts by type and a sample of labels. Cheap; call it before reading a large glade in full.',
      inputSchema: { glade_id: gladeId },
      annotations: { readOnlyHint: true },
    },
    ({ glade_id }) =>
      guarded(async () => {
        const room = await openRoom(glade_id)
        const file = snapshot(room)
        const graph = gladeToGraph(file)
        const counts: Record<string, number> = {}
        for (const object of file.objects) counts[object.type] = (counts[object.type] ?? 0) + 1
        const xs = graph.nodes.flatMap((node) => [node.x, node.x + node.w])
        const ys = graph.nodes.flatMap((node) => [node.y, node.y + node.h])
        return ok({
          id: glade_id,
          title: room.board.title,
          kind: room.board.kind,
          role: room.access.role,
          can_edit: room.access.can_edit,
          can_delete: room.access.can_delete,
          allowed: allowedPhrase(room.access),
          objects: file.objects.length,
          nodes: graph.nodes.length,
          edges: graph.edges.length,
          counts,
          bounds:
            xs.length === 0
              ? null
              : {
                  x: Math.min(...xs),
                  y: Math.min(...ys),
                  w: Math.max(...xs) - Math.min(...xs),
                  h: Math.max(...ys) - Math.min(...ys),
                },
          labels: graph.nodes
            .filter((node) => node.label !== '')
            .slice(0, 40)
            .map((node) => ({
              id: node.id,
              type: node.type,
              label: node.label.slice(0, 120),
            })),
        })
      }),
  )

  server.registerTool(
    'get_glade_graph',
    {
      title: 'Read a glade as a graph',
      description:
        'Nodes (id, type, label, position, size, colours, parent) and edges (id, from, to, label, direction, routing). Paged: pass next_offset back as offset for more. Freehand strokes are left out unless asked for.',
      inputSchema: {
        glade_id: gladeId,
        offset: z.number().int().min(0).optional(),
        limit: z
          .number()
          .int()
          .min(1)
          .max(2000)
          .optional()
          .describe('Nodes per page, default 300.'),
        region: region.optional(),
        include_freedraw: z.boolean().optional(),
        include_snapshot: z
          .boolean()
          .optional()
          .describe('Also return a picture of the nodes on this page.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({
      glade_id,
      offset = 0,
      limit = 300,
      region: area,
      include_freedraw = false,
      include_snapshot = false,
    }) =>
      guarded(async () => {
        const room = await openRoom(glade_id)
        const graph = graphOf(room)
        const nodes = graph.nodes.filter(
          (node) =>
            (include_freedraw || node.type !== 'freedraw') &&
            (area === undefined || overlaps(node, area)),
        )
        const page = nodes.slice(offset, offset + limit)
        const onPage = new Set(page.map((node) => node.id))
        const edges = graph.edges.filter(
          (edge) =>
            (edge.from !== null && onPage.has(edge.from)) ||
            (edge.to !== null && onPage.has(edge.to)) ||
            (offset === 0 && area === undefined && edge.from === null && edge.to === null),
        )
        const body = {
          title: graph.title,
          kind: graph.kind,
          total_nodes: nodes.length,
          total_edges: graph.edges.length,
          offset,
          next_offset: offset + limit < nodes.length ? offset + limit : null,
          nodes: page,
          edges,
          groups: graph.groups.filter((group) => onPage.has(group.id)),
        }
        if (!include_snapshot || !snapshots) {
          return ok({
            ...body,
            ...(snapshots ? { see_it: 'get_glade_snapshot, or include_snapshot: true' } : {}),
          })
        }
        return withPicture(
          body,
          await picture(
            room.session,
            room,
            page.map((node) => node.id),
          ),
        )
      }),
  )

  server.registerTool(
    'find_objects',
    {
      title: 'Find objects',
      description: 'Nodes and edges whose label contains some text, of a type, or inside a region.',
      inputSchema: {
        glade_id: gladeId,
        text: z.string().optional().describe('Case-insensitive substring of the label.'),
        type: z.string().optional().describe('An object type, e.g. sticky, rect, arrow.'),
        region: region.optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ glade_id, text, type, region: area, limit = 50 }) =>
      guarded(async () => {
        const graph = graphOf(await openRoom(glade_id))
        const needle = text?.toLowerCase()
        const matchLabel = (label: string): boolean =>
          needle === undefined || label.toLowerCase().includes(needle)
        const nodes: GraphNode[] = graph.nodes.filter(
          (node) =>
            matchLabel(node.label) &&
            (type === undefined || node.type === type) &&
            (area === undefined || overlaps(node, area)),
        )
        const edges: GraphEdge[] =
          area !== undefined
            ? []
            : graph.edges.filter(
                (edge) => matchLabel(edge.label) && (type === undefined || edge.type === type),
              )
        return ok({
          nodes: nodes.slice(0, limit),
          edges: edges.slice(0, limit),
          truncated: nodes.length > limit || edges.length > limit,
        })
      }),
  )

  server.registerTool(
    'get_objects',
    {
      title: 'Get objects in full',
      description:
        'The complete stored form of some objects, including every style property and rich text, plus the bindings of any arrows among them.',
      inputSchema: {
        glade_id: gladeId,
        ids: z.array(z.string()).min(1).max(200),
      },
      annotations: { readOnlyHint: true },
    },
    ({ glade_id, ids }) =>
      guarded(async () => {
        const file = snapshot(await openRoom(glade_id))
        const wanted = new Set(ids)
        const objects = file.objects.filter((object) => wanted.has(object.id))
        const found = new Set(objects.map((object) => object.id))
        return ok({
          objects,
          bindings: file.bindings.filter((binding) => wanted.has(binding.arrowId)),
          missing: ids.filter((id) => !found.has(id)),
        })
      }),
  )

  server.registerTool(
    'export_glade',
    {
      title: 'Export a glade',
      description:
        'The whole glade as a lossless .meadow.json file (the same file the app exports). Large; prefer get_glade_graph unless you need every field.',
      inputSchema: { glade_id: gladeId },
      annotations: { readOnlyHint: true },
    },
    ({ glade_id }) =>
      guarded(async () => {
        const text = JSON.stringify(snapshot(await openRoom(glade_id)))
        if (text.length > GLADE_MAX_BYTES)
          return refused('This glade is larger than an export may be.')
        return { content: [{ type: 'text', text }] }
      }),
  )

  server.registerTool(
    'export_mermaid',
    {
      title: 'Export a glade as Mermaid',
      description:
        'The glade as a Mermaid flowchart: shapes, labels and connections, without positions or colours.',
      inputSchema: {
        glade_id: gladeId,
        direction: z.enum(['LR', 'TB']).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ glade_id, direction: flow }) =>
      guarded(async () => ({
        content: [
          {
            type: 'text',
            text: graphToMermaid(graphOf(await openRoom(glade_id)), flow ?? 'LR'),
          },
        ],
      })),
  )

  // --- writing ---------------------------------------------------------------------------

  gate(
    server.registerTool(
      'create_glade',
      {
        title: 'Create a glade',
        description:
          'A new, empty glade owned by the token holder. Needs a read-and-edit token not limited to particular glades.',
        inputSchema: {
          title: z.string().min(1).max(200),
          kind: z
            .enum(['glade', 'lea'])
            .optional()
            .describe('glade is a canvas; lea is a ruled diary.'),
        },
      },
      ({ title, kind }) =>
        guarded(async () => {
          const account = await me()
          if (account.default_workspace_id === null)
            return refused('This account has no workspace to create a glade in.')
          const board = await api.createBoard(account.default_workspace_id, title, kind ?? 'glade')
          return ok({ id: board.id, title: board.title, kind: board.kind })
        }),
    ),
    'create',
  )

  gate(
    server.registerTool(
      'create_nodes',
      {
        title: 'Create nodes',
        description:
          'Add shapes, stickies or text. Nodes without x and y are laid out together beside the existing content. Edges between them can be added in the same call with edges.',
        inputSchema: {
          glade_id: gladeId,
          nodes: z.array(nodeInput).min(1).max(500),
          edges: z.array(edgeInput).max(500).optional(),
          direction: z
            .enum(['LR', 'TB'])
            .optional()
            .describe('Layout direction for unplaced nodes. Default LR.'),
          placement: z
            .object({ x: z.number(), y: z.number() })
            .optional()
            .describe('Top-left of the laid-out block.'),
          preview,
          snapshot: snapshotArg,
        },
      },
      ({
        glade_id,
        nodes,
        edges,
        direction: flow,
        placement,
        preview: wantPreview,
        snapshot: wantSnapshot,
      }) =>
        guarded(() =>
          edit(
            glade_id,
            wantPreview,
            async (room) => ({
              batch: await planCreate(room.session, nodes, edges ?? [], {
                direction: flow,
                placement,
              }),
            }),
            wantSnapshot,
          ),
        ),
    ),
    'edit',
  )

  gate(
    server.registerTool(
      'connect',
      {
        title: 'Connect objects',
        description:
          'Draw arrows or lines between objects already on the glade. The ends stay attached when the objects move.',
        inputSchema: {
          glade_id: gladeId,
          edges: z.array(edgeInput).min(1).max(500),
          preview,
          snapshot: snapshotArg,
        },
      },
      ({ glade_id, edges, preview: wantPreview, snapshot: wantSnapshot }) =>
        guarded(() =>
          edit(
            glade_id,
            wantPreview,
            async (room) => ({
              batch: await planCreate(room.session, [], edges),
            }),
            wantSnapshot,
          ),
        ),
    ),
    'edit',
  )

  gate(
    server.registerTool(
      'update_objects',
      {
        title: 'Update objects',
        description:
          'Change labels, position, size, rotation or colours by id. For arrows: label, direction, routing and stroke; their ends follow what they connect.',
        inputSchema: {
          glade_id: gladeId,
          updates: z
            .array(
              z.object({
                id: z.string(),
                label: z.string().optional(),
                x: z.number().optional(),
                y: z.number().optional(),
                w: z.number().positive().optional(),
                h: z.number().positive().optional(),
                rotation: z.number().optional().describe('Radians.'),
                fill: colour.optional(),
                stroke: colour.optional(),
                text_color: colour.optional(),
                font_size: z.number().min(6).max(288).optional(),
                direction: direction.optional(),
                routing: routing.optional(),
                locked: z.boolean().optional(),
              }),
            )
            .min(1)
            .max(500),
          preview,
          snapshot: snapshotArg,
        },
      },
      ({ glade_id, updates, preview: wantPreview, snapshot: wantSnapshot }) =>
        guarded(() =>
          edit(
            glade_id,
            wantPreview,
            async (room) => ({
              batch: planUpdate(room.session, updates),
            }),
            wantSnapshot,
          ),
        ),
    ),
    'edit',
  )

  gate(
    server.registerTool(
      'delete_objects',
      {
        title: 'Delete objects',
        description:
          'Remove objects by id. Arrows attached to a removed object keep a free end rather than disappearing.',
        inputSchema: {
          glade_id: gladeId,
          ids: z.array(z.string()).min(1).max(500),
          preview,
        },
        annotations: { destructiveHint: true },
      },
      ({ glade_id, ids, preview: wantPreview }) =>
        guarded(() =>
          edit(glade_id, wantPreview, async (room) => ({
            batch: planRemove(room.session, ids),
          })),
        ),
    ),
    'delete',
  )

  gate(
    server.registerTool(
      'set_text',
      {
        title: 'Set text',
        description:
          'Replace the text of a shape, sticky, text object or arrow label. Accepts light Markdown unless markdown is false.',
        inputSchema: {
          glade_id: gladeId,
          id: z.string(),
          text: z.string(),
          markdown: z.boolean().optional(),
          preview,
          snapshot: snapshotArg,
        },
      },
      ({ glade_id, id, text, markdown, preview: wantPreview, snapshot: wantSnapshot }) =>
        guarded(() =>
          edit(
            glade_id,
            wantPreview,
            async (room) => {
              if (!room.session.objects.has(id)) throw new PlanError(`no object with id ${id}`)
              return {
                batch: {
                  update: [{ id, patch: {}, text: textToRich(text, markdown ?? true) }],
                },
              }
            },
            wantSnapshot,
          ),
        ),
    ),
    'edit',
  )

  gate(
    server.registerTool(
      'apply_diagram',
      {
        title: 'Apply a diagram',
        description:
          'Draw or extend a diagram from nodes and edges, or from Mermaid flowchart text. Nodes are matched to the glade by id, then by exact label; matched nodes are kept (and relabelled if the label changed), missing ones are created and laid out, and edges that already exist are not drawn twice. Nothing the diagram does not mention is removed.',
        inputSchema: {
          glade_id: gladeId,
          diagram: z
            .object({
              direction: z.enum(['LR', 'TB']).optional(),
              nodes: z.array(
                z.object({
                  key: z.string().describe('An existing object id, or a name edges use.'),
                  label: z.string().optional(),
                  type: nodeType.optional(),
                }),
              ),
              edges: z.array(
                z.object({
                  from: z.string(),
                  to: z.string(),
                  label: z.string().optional(),
                  direction: direction.optional(),
                  type: z.enum(['arrow', 'line']).optional(),
                }),
              ),
            })
            .optional(),
          mermaid: z.string().optional().describe('A Mermaid flowchart, used instead of diagram.'),
          placement: z.object({ x: z.number(), y: z.number() }).optional(),
          preview,
          snapshot: snapshotArg,
        },
      },
      ({ glade_id, diagram, mermaid, placement, preview: wantPreview, snapshot: wantSnapshot }) =>
        guarded(() =>
          edit(
            glade_id,
            wantPreview,
            async (room) => {
              if ((diagram === undefined) === (mermaid === undefined)) {
                throw new PlanError('give exactly one of diagram or mermaid')
              }
              const spec: DiagramSpec = mermaid !== undefined ? parseMermaid(mermaid) : diagram!
              const plan = await planDiagram(room.session, spec, placement)
              return {
                batch: plan.batch,
                extra: {
                  matched: plan.matched,
                  existing_edges: plan.existingEdges,
                },
              }
            },
            wantSnapshot,
          ),
        ),
    ),
    'edit',
  )

  server.registerTool(
    'get_glade_snapshot',
    {
      title: 'Look at a glade',
      description:
        'A PNG picture of the glade as the canvas draws it: shapes, arrows, labels and ink, from the document itself. Use it to check how a diagram actually looks, beside get_glade_graph. Pass include_graph to get the nodes and edges in the picture in the same result, with the ids to edit them by. Show part of a large glade with region or ids. Needs only view access. Wrapping and fonts can differ slightly from the browser.',
      inputSchema: {
        glade_id: gladeId,
        region: region.optional(),
        ids: z
          .array(z.string())
          .max(2000)
          .optional()
          .describe('Frame these objects, with their surroundings.'),
        max_width: z
          .number()
          .int()
          .min(64)
          .max(MAX_SNAPSHOT_WIDTH)
          .optional()
          .describe(`Picture width in pixels, default ${DEFAULT_SNAPSHOT_WIDTH}.`),
        theme: z.enum(['light', 'dark']).optional().describe('Canvas theme. Default light.'),
        include_graph: z
          .boolean()
          .optional()
          .describe('Also return the nodes and edges drawn, as get_glade_graph has them.'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ glade_id, region: area, ids, max_width, theme, include_graph = false }) =>
      guarded(async () => {
        const room = await openRoom(glade_id)
        const look = await lookAt(
          room.session,
          { title: room.board.title, kind: room.board.kind },
          { region: area, ids, maxWidth: max_width, theme, includeGraph: include_graph },
        )
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { glade: { id: room.board.id, title: room.board.title }, ...look.details },
                null,
                2,
              ),
            },
            look.image,
          ],
        }
      }),
  )

  server.registerTool(
    'check_layout',
    {
      title: 'Check a diagram layout',
      description:
        'Find what would look wrong on the canvas: text overflowing its shape, overlapping shapes, arrows running through shapes they do not connect, arrows drawn on top of each other, labels on labels or shapes, and arrows with a loose end. Checks the whole glade, or only the given ids and the arrows touching them.',
      inputSchema: {
        glade_id: gladeId,
        ids: z.array(z.string()).max(2000).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    ({ glade_id, ids }) =>
      guarded(async () => ok(checkLayout((await openRoom(glade_id)).session, ids))),
  )

  gate(
    server.registerTool(
      'tidy_layout',
      {
        title: 'Tidy a diagram layout',
        description:
          'Lay shapes out again as a clean layered diagram, grow shapes whose text does not fit, and re-attach their arrows so they do not share lines, stack labels or cross shapes. Applies to the given ids, or to every shape connected by an arrow. The block keeps its top-left corner unless placement is given. move: false only resizes and re-routes, keeping positions. Use preview first on a glade a person arranged by hand.',
        inputSchema: {
          glade_id: gladeId,
          ids: z.array(z.string()).max(500).optional(),
          direction: z.enum(['LR', 'TB']).optional().describe('Layout direction. Default LR.'),
          placement: z.object({ x: z.number(), y: z.number() }).optional(),
          move: z.boolean().optional(),
          preview,
          snapshot: snapshotArg,
        },
      },
      ({
        glade_id,
        ids,
        direction: flow,
        placement,
        move,
        preview: wantPreview,
        snapshot: wantSnapshot,
      }) =>
        guarded(() =>
          edit(
            glade_id,
            wantPreview,
            async (room) => ({
              batch: await planTidy(room.session, { ids, direction: flow, placement, move }),
            }),
            wantSnapshot,
          ),
        ),
    ),
    'edit',
  )

  gate(
    server.registerTool(
      'import_glade',
      {
        title: 'Import a glade file',
        description:
          'Create a new glade from a .meadow.json file, keeping every id. Needs a read-and-edit token not limited to particular glades.',
        inputSchema: {
          file: z
            .union([z.string(), z.record(z.unknown())])
            .describe('The file, as JSON text or an object.'),
          title: z.string().min(1).max(200).optional(),
        },
      },
      ({ file, title }) =>
        guarded(async () => {
          const parsed = parseGladeFile(file)
          if (!parsed.ok) return refused(`Not a glade file: ${parsed.error}`)
          const account = await me()
          if (account.default_workspace_id === null)
            return refused('This account has no workspace to create a glade in.')
          const kind = parsed.file.board.kind === 'lea' ? 'lea' : 'glade'
          const board = await api.createBoard(
            account.default_workspace_id,
            title ?? (parsed.file.board.title === '' ? 'Imported glade' : parsed.file.board.title),
            kind,
          )
          const room = await openRoom(board.id)
          const blocked = refusal(room, 'edit')
          if (blocked !== null) return refused(blocked)
          const counts = importGlade(room.session, parsed.file)
          await (await roomsFor()).flush(room)
          return ok({
            id: board.id,
            title: board.title,
            ...counts,
            ...(gladeReportIsClean(parsed.report) ? {} : { repaired: parsed.report }),
          })
        }),
    ),
    'create',
  )

  // --- resources ---------------------------------------------------------------------------

  const listTemplate = (suffix: string) => async () => ({
    resources: (await api.listBoards()).map((board) => ({
      uri: `meadow://glade/${board.id}${suffix}`,
      name: `${board.title}${suffix === '' ? '' : ' (graph)'}`,
      mimeType: 'application/json',
    })),
  })

  server.registerResource(
    'glade',
    new ResourceTemplate('meadow://glade/{glade_id}', {
      list: listTemplate(''),
    }),
    {
      title: 'Glade file',
      description: 'A glade as a lossless .meadow.json file.',
      mimeType: 'application/json',
    },
    async (uri, { glade_id }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(snapshot(await openRoom(String(glade_id)))),
        },
      ],
    }),
  )

  server.registerResource(
    'glade-graph',
    new ResourceTemplate('meadow://glade/{glade_id}/graph', {
      list: listTemplate('/graph'),
    }),
    {
      title: 'Glade graph',
      description: 'A glade as nodes and edges.',
      mimeType: 'application/json',
    },
    async (uri, { glade_id }) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(graphOf(await openRoom(String(glade_id)))),
        },
      ],
    }),
  )

  return {
    server,
    close: () => {
      rooms?.closeAll()
    },
  }
}
