// HTTP front door. One process serves health, smart HTTP, REST, GraphQL and MCP.
// A handler that throws becomes a JSON 500; the process stays up.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';

const MAX_BODY = 32 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(): Server {
  const forge = new Forge();
  let seq = 0;
  return createServer((req, res) => {
    const requestId = `gf${++seq}`;
    void dispatch(forge, req, res, requestId).catch(() => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, {
        'content-type': 'application/json; charset=utf-8',
        'x-github-request-id': requestId,
      });
      res.end(JSON.stringify({ message: 'Internal Server Error' }));
    });
  });
}

async function dispatch(forge: Forge, req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const url = new URL(req.url ?? '/', 'http://forge.local');
  const path = url.pathname;
  if (method === 'GET' && (path === '/healthz' || path === '/healthz/')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  const outcome = await forge.handle(method, path, url.searchParams, req, await bodyOf(method, req));
  const headers: Record<string, string> = { 'x-github-request-id': requestId, ...outcome.headers };
  if (outcome.body === null) {
    res.writeHead(outcome.status, headers);
    res.end();
    return;
  }
  res.writeHead(outcome.status, headers);
  res.end(outcome.body);
}

async function bodyOf(method: string, req: IncomingMessage): Promise<Buffer> {
  if (method === 'GET' || method === 'HEAD') return Buffer.alloc(0);
  try {
    return await readBody(req);
  } catch {
    return Buffer.alloc(0);
  }
}
