/**
 * Tiny localhost HTTP media server for the in-app Remotion player.
 *
 * Why: Remotion's <Video> / <OffthreadVideo> (used in @remotion/player) can't
 * load our `lynlens-media://` custom protocol — Chromium treats custom
 * schemes differently for media fetch/CORS, and even a fully-privileged
 * scheme (corsEnabled/stream/supportFetchAPI) fails. A plain HTTP URL works.
 * So we serve the trimmed variant clips over 127.0.0.1 HTTP with Range + CORS.
 *
 * Security: bound to 127.0.0.1 only, and every request must carry a random
 * per-session token in the path. Without the token (held only by our
 * renderer) other local processes can't read arbitrary files.
 */
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function guessMime(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.mp4':
    case '.m4v':
      return 'video/mp4';
    case '.mov':
      return 'video/quicktime';
    case '.webm':
      return 'video/webm';
    case '.mp3':
      return 'audio/mpeg';
    case '.wav':
      return 'audio/wav';
    default:
      return 'application/octet-stream';
  }
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Timing-Allow-Origin': '*',
};

/**
 * Pipe a file read-stream to the response and DESTROY it when the client
 * disconnects. Scrubbing the player aborts the previous range request and
 * opens a new one; without this, the abandoned read streams + sockets leak,
 * and after a few seeks the server stops serving → black frames.
 */
function pipeWithCleanup(
  stream: ReturnType<typeof createReadStream>,
  res: import('node:http').ServerResponse
): void {
  const cleanup = (): void => {
    stream.destroy();
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

export interface MediaHttpServer {
  /** e.g. http://127.0.0.1:54321/<token> — append `/media?p=<encoded abs path>`. */
  base: string;
  close: () => void;
}

export async function startMediaHttpServer(): Promise<MediaHttpServer> {
  const token = crypto.randomBytes(16).toString('hex');

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '', 'http://127.0.0.1');
      const parts = url.pathname.split('/').filter(Boolean); // [token, 'media']
      if (parts[0] !== token || parts[1] !== 'media') {
        res.writeHead(403, CORS);
        res.end('forbidden');
        return;
      }
      const filePath = url.searchParams.get('p');
      if (!filePath) {
        res.writeHead(400, CORS);
        res.end('missing p');
        return;
      }
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        res.writeHead(404, CORS);
        res.end('not a file');
        return;
      }
      const fileSize = stat.size;
      const mime = guessMime(filePath);
      const range = req.headers.range;
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Math.min(Number(m[2]), fileSize - 1) : fileSize - 1;
          if (start > end || start < 0) {
            res.writeHead(416, CORS);
            res.end();
            return;
          }
          res.writeHead(206, {
            ...CORS,
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': String(end - start + 1),
            'Content-Type': mime,
          });
          pipeWithCleanup(createReadStream(filePath, { start, end }), res);
          return;
        }
      }
      res.writeHead(200, {
        ...CORS,
        'Content-Length': String(fileSize),
        'Accept-Ranges': 'bytes',
        'Content-Type': mime,
      });
      pipeWithCleanup(createReadStream(filePath), res);
    } catch (err) {
      res.writeHead(404, CORS);
      res.end(String(err));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}/${token}`,
    close: () => server.close(),
  };
}

/** Build a playable HTTP URL for an absolute file path given the server base. */
export function mediaHttpUrl(base: string, absPath: string): string {
  return `${base}/media?p=${encodeURIComponent(absPath)}`;
}
