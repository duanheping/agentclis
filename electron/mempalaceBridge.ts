import type { ChildProcessWithoutNullStreams } from 'node:child_process'

import { MempalaceRuntime } from './mempalaceRuntime'

const MCP_PROTOCOL_VERSION = '2025-11-25'
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

interface JsonRpcErrorPayload {
  code?: number
  message?: string
  data?: unknown
}

interface JsonRpcSuccessResponse {
  jsonrpc?: string
  id?: number
  result?: unknown
}

interface JsonRpcErrorResponse {
  jsonrpc?: string
  id?: number
  error?: JsonRpcErrorPayload
}

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: number
  method: string
  params?: Record<string, unknown>
}

interface MempalaceInitializeResult {
  protocolVersion?: string
  capabilities?: Record<string, unknown>
  serverInfo?: {
    name?: string
    version?: string
  }
}

interface MempalaceToolCallEnvelope {
  content?: Array<{
    type?: string
    text?: string
  }>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export interface MempalaceRuntimeHost {
  start(): Promise<ChildProcessWithoutNullStreams>
  stop(): void
}

export interface MempalaceToolDefinition {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface MempalaceStatusResponse {
  total_drawers?: number
  wings?: Record<string, number>
  rooms?: Record<string, number>
  palace_path?: string
  protocol?: string
  aaak_dialect?: string
  error?: string
  partial?: boolean
}

export interface MempalaceSearchRequest {
  query: string
  limit?: number
  wing?: string | null
  room?: string | null
  max_distance?: number
  min_similarity?: number
  context?: string | null
}

export interface MempalaceSearchResponse {
  results?: Array<Record<string, unknown>>
  query_sanitized?: boolean
  sanitizer?: Record<string, unknown>
  error?: string
  [key: string]: unknown
}

export interface MempalaceBridgeOptions {
  requestTimeoutMs?: number
}

function createBridgeError(
  message: string,
  payload?: JsonRpcErrorPayload,
): Error {
  const error = new Error(message)
  if (payload) {
    ;(error as Error & { code?: number; data?: unknown }).code = payload.code
    ;(error as Error & { code?: number; data?: unknown }).data = payload.data
  }
  return error
}

function parseToolCallResult(result: unknown): unknown {
  const envelope = result as MempalaceToolCallEnvelope | null
  if (!envelope || !Array.isArray(envelope.content)) {
    return result
  }

  const textPart = envelope.content.find(
    (entry) => entry?.type === 'text' && typeof entry.text === 'string',
  )
  if (!textPart?.text) {
    return result
  }

  const trimmed = textPart.text.trim()
  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return trimmed
  }
}

export class MempalaceBridge {
  private readonly runtime: MempalaceRuntimeHost
  private readonly requestTimeoutMs: number

  private process: ChildProcessWithoutNullStreams | null = null
  private initializePromise: Promise<void> | null = null
  private initializedProcess: ChildProcessWithoutNullStreams | null = null
  private pendingRequests = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private stdoutBuffer = ''

  private readonly handleStdoutData = (chunk: string | Buffer) => {
    this.stdoutBuffer += chunk.toString()

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }

      const rawLine = this.stdoutBuffer.slice(0, newlineIndex)
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1)
      const line = rawLine.trim()
      if (!line) {
        continue
      }

      let parsed: JsonRpcSuccessResponse | JsonRpcErrorResponse
      try {
        parsed = JSON.parse(line) as JsonRpcSuccessResponse | JsonRpcErrorResponse
      } catch {
        continue
      }

      this.handleResponse(parsed)
    }
  }

  private readonly handleProcessClose = () => {
    this.process = null
    this.initializedProcess = null
    this.initializePromise = null
    this.stdoutBuffer = ''
    this.rejectPendingRequests(
      createBridgeError('MemPalace bridge disconnected before receiving a response.'),
    )
  }

  constructor(
    runtime: MempalaceRuntime | MempalaceRuntimeHost,
    options: MempalaceBridgeOptions = {},
  ) {
    this.runtime = runtime
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async listTools(): Promise<MempalaceToolDefinition[]> {
    const result = await this.sendRequest<{ tools?: MempalaceToolDefinition[] }>(
      'tools/list',
    )
    return Array.isArray(result.tools) ? result.tools : []
  }

  async callTool<T>(
    name: string,
    argumentsPayload: Record<string, unknown> = {},
  ): Promise<T> {
    const result = await this.sendRequest<MempalaceToolCallEnvelope>('tools/call', {
      name,
      arguments: argumentsPayload,
    })
    return parseToolCallResult(result) as T
  }

  async status(): Promise<MempalaceStatusResponse> {
    return await this.callTool<MempalaceStatusResponse>('mempalace_status')
  }

  async search(
    input: MempalaceSearchRequest,
  ): Promise<MempalaceSearchResponse> {
    return await this.callTool<MempalaceSearchResponse>('mempalace_search', {
      query: input.query,
      limit: input.limit,
      wing: input.wing ?? undefined,
      room: input.room ?? undefined,
      max_distance: input.max_distance,
      min_similarity: input.min_similarity,
      context: input.context ?? undefined,
    })
  }

  async addDrawer(input: {
    wing: string
    room: string
    content: string
    source_file?: string
  }): Promise<Record<string, unknown>> {
    return await this.callTool<Record<string, unknown>>('mempalace_add_drawer', input)
  }

  async getDrawer(drawerId: string): Promise<Record<string, unknown>> {
    return await this.callTool<Record<string, unknown>>('mempalace_get_drawer', {
      drawer_id: drawerId,
    })
  }

  async listDrawers(input: {
    wing?: string
    room?: string
    limit?: number
    offset?: number
  } = {}): Promise<Record<string, unknown>> {
    return await this.callTool<Record<string, unknown>>('mempalace_list_drawers', input)
  }

  private async ensureConnected(): Promise<ChildProcessWithoutNullStreams> {
    const child = this.process ?? await this.runtime.start()

    if (this.process !== child) {
      this.detachProcess()
      this.process = child
      this.initializedProcess = null
      this.initializePromise = null
      this.stdoutBuffer = ''
      child.stdout.on('data', this.handleStdoutData)
      child.on('close', this.handleProcessClose)
      child.on('error', this.handleProcessClose)
    }

    await this.ensureInitialized(child)
    return child
  }

  private async ensureInitialized(
    child: ChildProcessWithoutNullStreams,
  ): Promise<void> {
    if (this.initializedProcess === child) {
      return
    }

    if (!this.initializePromise) {
      this.initializePromise = (async () => {
        const initializeResult = await this.sendRequest<MempalaceInitializeResult>(
          'initialize',
          {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: {
              name: 'agentclis',
              version: '0.1.0',
            },
          },
          { skipEnsureConnected: true },
        )

        if (!initializeResult.protocolVersion) {
          throw createBridgeError('MemPalace initialize response was missing protocolVersion.')
        }

        await this.sendNotification('notifications/initialized')
        this.initializedProcess = child
      })()

      this.initializePromise.catch(() => {
        this.initializedProcess = null
      }).finally(() => {
        this.initializePromise = null
      })
    }

    await this.initializePromise
  }

  private async sendNotification(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    const child = this.process ?? await this.ensureConnected()
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      method,
      params,
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private async sendRequest<T>(
    method: string,
    params?: Record<string, unknown>,
    options: { skipEnsureConnected?: boolean } = {},
  ): Promise<T> {
    const child = options.skipEnsureConnected
      ? (this.process ?? await this.runtime.start())
      : await this.ensureConnected()

    if (options.skipEnsureConnected && this.process !== child) {
      this.detachProcess()
      this.process = child
      this.stdoutBuffer = ''
      child.stdout.on('data', this.handleStdoutData)
      child.on('close', this.handleProcessClose)
      child.on('error', this.handleProcessClose)
    }

    const requestId = this.nextRequestId
    this.nextRequestId += 1

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(
          createBridgeError(
            `MemPalace request timed out after ${this.requestTimeoutMs}ms: ${method}`,
          ),
        )
      }, this.requestTimeoutMs)

      this.pendingRequests.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })

      try {
        const payload: JsonRpcRequest = {
          jsonrpc: '2.0',
          id: requestId,
          method,
          params,
        }
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      } catch (error) {
        clearTimeout(timeout)
        this.pendingRequests.delete(requestId)
        reject(
          error instanceof Error
            ? error
            : new Error(String(error)),
        )
      }
    })
  }

  private handleResponse(response: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const requestId = typeof response.id === 'number' ? response.id : null
    if (requestId === null) {
      return
    }

    const pending = this.pendingRequests.get(requestId)
    if (!pending) {
      return
    }

    clearTimeout(pending.timeout)
    this.pendingRequests.delete(requestId)

    if ('error' in response && response.error) {
      pending.reject(
        createBridgeError(
          response.error.message ?? 'MemPalace returned an unknown JSON-RPC error.',
          response.error,
        ),
      )
      return
    }

    pending.resolve((response as JsonRpcSuccessResponse).result)
  }

  private rejectPendingRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pendingRequests.delete(requestId)
    }
  }

  private detachProcess(): void {
    if (!this.process) {
      return
    }

    this.process.stdout.off('data', this.handleStdoutData)
    this.process.off('close', this.handleProcessClose)
    this.process.off('error', this.handleProcessClose)
  }
}
