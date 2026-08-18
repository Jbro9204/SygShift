interface Fetcher {
  fetch(request: Request): Promise<Response>
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
