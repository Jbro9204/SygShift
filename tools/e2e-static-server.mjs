import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? process.env.PORT ?? 4174)
const root = resolve(process.cwd(), 'dist', 'client')

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
])

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  const normalized = normalize(decoded).replace(/^([/\\])+/, '')
  const candidate = resolve(root, normalized)
  return candidate === root || candidate.startsWith(`${root}${sep}`) ? candidate : null
}

const server = createServer((request, response) => {
  const requestPath = safePath(request.url ?? '/')
  const filePath = requestPath && existsSync(requestPath) && statSync(requestPath).isFile()
    ? requestPath
    : join(root, 'index.html')

  response.setHeader('Content-Type', contentTypes.get(extname(filePath)) ?? 'application/octet-stream')
  createReadStream(filePath)
    .on('error', () => {
      response.statusCode = 404
      response.end('Not found')
    })
    .pipe(response)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`SygShift E2E static server listening at http://127.0.0.1:${port}`)
})
