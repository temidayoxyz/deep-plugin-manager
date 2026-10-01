/**
 * Route-layer tests over a stub manager API: status mapping and the wording of
 * the unknown-route case, which is the one a user has to act on.
 */
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import { handleRequest, ROUTE_PREFIX, type PluginManagerApi } from '../src/routes.ts'
import { ManagerError } from '../src/errors.ts'

/** Collect the response a handler writes, for assertions. */
async function invoke(
  api: PluginManagerApi,
  method: string,
  url: string,
  body?: string,
): Promise<{ status: number; payload: { error?: { kind?: string; message?: string } } }> {
  const stream = new PassThrough()
  // The handler only reads url/method and iterates the body, so a PassThrough
  // cast to IncomingMessage is enough to drive it.
  const req = stream as unknown as IncomingMessage
  req.url = url
  req.method = method
  const chunks: { status: number; value: Record<string, unknown> } = { status: 0, value: {} }
  const res = {
    writeHead(status: number) { chunks.status = status },
    end(payload: string) {
      chunks.value = JSON.parse(payload) as Record<string, unknown>
      resolveDone({ status: chunks.status, payload: chunks.value as { error?: { kind?: string; message?: string } } })
    },
  } as unknown as ServerResponse
  let resolveDone: (value: { status: number; payload: { error?: { kind?: string; message?: string } } }) => void = () => undefined
  const done = new Promise<{ status: number; payload: { error?: { kind?: string; message?: string } } }>((resolve) => {
    resolveDone = resolve
  })
  const handled = handleRequest(req, res, api)
  if (body !== undefined) stream.end(body)
  else stream.end()
  await handled
  return done
}

/** An API whose every method is inert; individual tests override what matters. */
function stubApi(overrides: Partial<PluginManagerApi> = {}): PluginManagerApi {
  return {
    list: async () => [],
    self: () => ({ name: 'dsh-deep-plugin-manager', version: '0.1.0', spec: '', patchMounted: false, enabled: true, updatable: true }),
    install: async () => { throw new Error('not used') },
    enable: () => undefined,
    disable: () => undefined,
    uninstall: async () => undefined,
    checkUpdate: async () => { throw new Error('not used') },
    update: async () => { throw new Error('not used') },
    selfUpdate: async () => { throw new Error('not used') },
    ...overrides,
  } as PluginManagerApi
}

describe('unknown routes', () => {
  it('reports an unknown route under our prefix as a stale host', async () => {
    // This is what a self-update produces: the browser bundle on disk is new
    // and calls a route the running process has never heard of, because the
    // host half was loaded into memory before the update.
    const result = await invoke(stubApi(), 'GET', `${ROUTE_PREFIX}/a-route-this-build-does-not-have`)
    assert.equal(result.status, 404)
    assert.equal(result.payload.error?.kind, 'stale-host')
    assert.match(result.payload.error?.message ?? '', /Restart the Harness/)
  })

  it('serves a route this build does have', async () => {
    const result = await invoke(stubApi(), 'GET', `${ROUTE_PREFIX}/self`)
    assert.equal(result.status, 200)
  })

  it('still reports a genuinely foreign path as not-found', async () => {
    const result = await invoke(stubApi(), 'GET', '/some/other/path')
    assert.equal(result.status, 404)
    assert.equal(result.payload.error?.kind, 'not-found')
    assert.match(result.payload.error?.message ?? '', /No management route/)
  })
})

describe('route status mapping', () => {
  it('maps a typed manager failure to its status', async () => {
    const api = stubApi({
      selfUpdate: async () => { throw new ManagerError('self-update-unsupported', 'cannot self-update here', 409) },
    })
    const result = await invoke(api, 'POST', `${ROUTE_PREFIX}/self-update`)
    assert.equal(result.status, 409)
    assert.equal(result.payload.error?.kind, 'self-update-unsupported')
  })

  it('rejects a malformed install body as a bad request', async () => {
    const result = await invoke(stubApi(), 'POST', `${ROUTE_PREFIX}/install`, '{"input":""}')
    assert.equal(result.status, 400)
    assert.equal(result.payload.error?.kind, 'bad-request')
  })
})