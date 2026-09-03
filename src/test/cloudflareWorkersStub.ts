export class DurableObject<Environment = unknown> {
  protected ctx: unknown
  protected env: Environment

  constructor(ctx: unknown, env: Environment) {
    this.ctx = ctx
    this.env = env
  }
}

export class WorkerEntrypoint<Environment = unknown, Properties = unknown> {
  protected env = undefined as Environment
  protected ctx = { props: undefined as Properties }
}
