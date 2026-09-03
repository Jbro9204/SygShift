interface Fetcher {
  fetch(request: Request): Promise<Response>
}

interface Queue<Body = unknown> {
  send(body: Body, options?: { contentType?: 'json' | 'text' | 'bytes', delaySeconds?: number }): Promise<void>
}

interface Message<Body = unknown> {
  readonly body: Body
  readonly attempts: number
  ack(): void
  retry(options?: { delaySeconds?: number }): void
}

interface MessageBatch<Body = unknown> {
  readonly messages: readonly Message<Body>[]
  readonly queue: string
}

interface ContainerExecOutput {
  readonly stdout: ArrayBuffer
  readonly stderr: ArrayBuffer
  readonly exitCode: number
}

interface ContainerExecProcess {
  output(): Promise<ContainerExecOutput>
  kill(signal?: number): void
}

interface ContainerRuntime {
  readonly running: boolean
  start(options?: {
    enableInternet?: boolean
    env?: Record<string, string>
  }): void
  exec(
    command: string[],
    options?: {
      stdin?: ReadableStream<Uint8Array>
      stdout?: 'pipe' | 'ignore'
      stderr?: 'pipe' | 'ignore' | 'combined'
    },
  ): Promise<ContainerExecProcess>
}

interface DurableObjectState {
  readonly container?: ContainerRuntime
}

interface DurableObjectNamespace<T = unknown> {
  getByName(name: string): T
}

declare module 'cloudflare:workers' {
  export abstract class DurableObject<Environment = unknown> {
    protected ctx: DurableObjectState
    protected env: Environment
    constructor(ctx: DurableObjectState, env: Environment)
  }

  export abstract class WorkerEntrypoint<Environment = unknown, Properties = unknown> {
    protected env: Environment
    protected ctx: { props: Properties }
  }
}

interface SendEmail {
  send(message: {
    to: string | string[]
    from: { email: string, name?: string }
    replyTo?: string
    subject: string
    html?: string
    text: string
  }): Promise<unknown>
}
