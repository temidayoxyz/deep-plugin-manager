/**
 * The management HTTP surface: JSON routes under `/deep-plugin-manager`,
 * registered on the Harness web server (same auth gate as the rest of the
 * UI). Every handler maps typed manager failures to status codes and never
 * leaks stack traces; pnpm output rides to the UI inside `error.detail`.
 *
 * @module dsh-deep-plugin-manager/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ManagerError } from './errors.ts'
import type { PluginEntry, ProfileManifest } from './profile.ts'
import type { InstallResult, PluginManagerOptions, UpdateCheck, UpdateResult } from './lifecycle.ts'
import { createPluginManager } from './lifecycle.ts'

/** The JSON body cap: install inputs are tiny; anything larger is refused. */
const MAX_BODY_BYTES = 64 * 1024

/** The management API as the client UI consumes it. */
export interface PluginManagerApi {
  list(): PluginEntry[]
  install(input: string): Promise<InstallResult>
  enable(name: string): void
  disable(name: string): void
  uninstall(name: string): Promise<void>
  checkUpdate(name: string): Promise<UpdateCheck>
  update(name: string): Promise<UpdateResult>
}

/**
 * Create the manager API from the lifecycle options.
 * @param options - profile directory, runner, optional GitHub override.
 * @returns the API object the routes dispatch to.
 */
export function createApi(options: PluginManagerOptions): PluginManagerApi {
  return createPluginManager(options)
}

/**
 * Dispatch one request to the API. The prefix route hands every path here;
 * matching is by method + exact suffix.
 * @param req - incoming request.
 * @param res - server response.
 * @param api - the manager API.
 */
export async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  api: PluginManagerApi,
): Promise<void> {
  const path = (req.url ?? '').split('?')[0] ?? ''
  const method = req.method ?? 'GET'
  try {
    if (path === '/deep-plugin-manager/plugins' && method === 'GET') {
      sendJson(res, 200, { plugins: api.list() })
      return
    }
    if (path === '/deep-plugin-manager/install' && method === 'POST') {
      const body = await readJsonBody(req)
      const input = readStringField(body, 'input')
      sendJson(res, 200, { result: await api.install(input) })
      return
    }
    if (path === '/deep-plugin-manager/enable' && method === 'POST') {
      const body = await readJsonBody(req)
      api.enable(readStringField(body, 'name'))
      sendJson(res, 200, { ok: true, restartRequired: true })
      return
    }
    if (path === '/deep-plugin-manager/disable' && method === 'POST') {
      const body = await readJsonBody(req)
      api.disable(readStringField(body, 'name'))
      sendJson(res, 200, { ok: true, restartRequired: true })
      return
    }
    if (path === '/deep-plugin-manager/uninstall' && method === 'POST') {
      const body = await readJsonBody(req)
      await api.uninstall(readStringField(body, 'name'))
      sendJson(res, 200, { ok: true })
      return
    }
    if (path === '/deep-plugin-manager/update' && method === 'POST') {
      const body = await readJsonBody(req)
      sendJson(res, 200, { result: await api.update(readStringField(body, 'name')) })
      return
    }
    if (path === '/deep-plugin-manager/check-update' && method === 'GET') {
      const name = new URL(req.url ?? '/', 'http://localhost').searchParams.get('name') ?? ''
      if (name === '') throw new ManagerError('bad-request', 'Missing plugin name.', 400)
      sendJson(res, 200, await api.checkUpdate(name))
      return
    }
    sendJson(res, 404, { error: { kind: 'not-found', message: `No management route for ${method} ${path}.` } })
  } catch (error) {
    if (error instanceof ManagerError) {
      sendJson(res, error.status, {
        error: { kind: error.kind, message: error.message, ...(error.detail === undefined ? {} : { detail: error.detail }) },
      })
      return
    }
    sendJson(res, 500, {
      error: { kind: 'internal', message: error instanceof Error ? error.message : String(error) },
    })
  }
}

/** One pending JSON body as a parsed object. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new ManagerError('bad-request', 'Request body too large.', 413)
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') throw new ManagerError('bad-request', 'A JSON body is required.', 400)
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ManagerError('bad-request', 'The request body must be a JSON object.', 400)
  }
  return parsed as Record<string, unknown>
}

/** One required string field from a parsed JSON body. */
function readStringField(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ManagerError('bad-request', `The "${field}" field is required.`, 400)
  }
  return value.trim()
}

/** Serialize one JSON response and finish it. */
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

/** Profile-manifest re-export for route consumers typing the API surface. */
export type { PluginEntry, ProfileManifest }
