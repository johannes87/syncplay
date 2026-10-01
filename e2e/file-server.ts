// Serves e2e/.fixtures for the end-to-end tests:
//
//   http://127.0.0.1:5198/<tag>/<file>   with CORS and Range support
//   http://127.0.0.1:5196/<tag>/<file>   the same without CORS (basic-mode fallback)
//   /stats/<tag>                         bytes sent so far for URLs with that <tag>
//
// Started by Playwright (see playwright.config.ts): node e2e/file-server.ts

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const FIXTURES = path.join(import.meta.dirname, '.fixtures')
export const CORS_PORT = 5198
export const NO_CORS_PORT = 5196

const bytesSent = new Map<string, number>()

function serve(cors: boolean) {
  return (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', 'Range')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length')
    }
    if (req.method === 'OPTIONS') return res.end()

    const [, first, ...rest] = (req.url ?? '/').split('?')[0].split('/')
    if (first === 'health') return res.end('ok')
    if (first === 'stats') return res.end(String(bytesSent.get(rest[0]) ?? 0))

    const tag = first
    const file = path.join(FIXTURES, path.basename(rest.join('/')))
    if (!fs.existsSync(file)) {
      res.writeHead(404)
      return res.end('not found')
    }
    const size = fs.statSync(file).size
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1
    const type = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac', '.wav': 'audio/wav' }
    res.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': type[path.extname(file) as keyof typeof type] ?? 'application/octet-stream',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    })
    if (req.method === 'HEAD') return res.end()
    const stream = fs.createReadStream(file, { start, end })
    stream.on('data', (chunk) => bytesSent.set(tag, (bytesSent.get(tag) ?? 0) + chunk.length))
    stream.pipe(res)
    res.on('close', () => stream.destroy())
  }
}

http.createServer(serve(true)).listen(CORS_PORT, '127.0.0.1')
http.createServer(serve(false)).listen(NO_CORS_PORT, '127.0.0.1')
