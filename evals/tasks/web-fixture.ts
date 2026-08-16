/**
 * A loopback HTTP server, so `WebFetch` can be evaluated without a network.
 *
 * The gate exempts loopback from its TLS requirement (`isLoopback` in
 * `egress-gate.ts`) and `localhost` normalises as a domain rather than an
 * address literal, so a task can point the tool at `http://localhost:<port>/…`
 * and exercise the real path: real allowlist check, real approval, real gate,
 * real response handling. Nothing about the tool is stubbed — only the internet
 * is.
 *
 * The server binds to 127.0.0.1 and is `unref`'d, so it can never hold the
 * process open or be reachable from another machine.
 *
 * lint-allow-file no-raw-network: this is an inbound loopback *server* used by an
 * eval fixture, not an egress client. AGENTS.md #9 governs bytes the kernel
 * sends; nothing here sends any, and the kernel's own request to it still goes
 * through EgressGate like every other web read.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The page a task tells the model to read. */
const PAGES: Record<string, { type: string; body: string }> = {
  '/api/compute': {
    type: 'text/html; charset=utf-8',
    body: [
      '<!doctype html><html><head><title>compute API</title>',
      '<style>body{font-family:sans-serif}</style></head><body>',
      '<h1>computeTotal</h1>',
      '<p>Signature: <code>computeTotal(items, taxRate)</code></p>',
      '<p>Both arguments are <strong>required</strong>. Calling it with one argument',
      'throws <code>TypeError: taxRate is required</code>. The tax rate for this',
      'service is <code>0.2</code>.</p>',
      '<script>document.title = "should not be read"</script>',
      '</body></html>',
    ].join('\n'),
  },
  '/api/compute.json': {
    type: 'application/json',
    body: JSON.stringify({ name: 'computeTotal', args: ['items', 'taxRate'], defaultTaxRate: 0.2 }),
  },
};

let started: Promise<{ base: string; close(): Promise<void> }> | undefined;

/**
 * Start the fixture once per process, and hand every caller the same base URL.
 *
 * Memoised because a run does many attempts of the same task and a server per
 * attempt would spend more time in `listen` than in the task.
 */
export function startWebFixture(): Promise<{ base: string; close(): Promise<void> }> {
  started ??= new Promise((resolve, reject) => {
    const server: Server = createServer((req, res) => {
      const page = PAGES[(req.url ?? '').split('?')[0] ?? ''];
      if (!page) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found\n');
        return;
      }
      res.writeHead(200, { 'content-type': page.type });
      res.end(page.body);
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      server.unref();
      resolve({
        // `localhost`, not `127.0.0.1`: an address literal is refused by the
        // tool's own SSRF check, and a name is what a configured allowlist
        // actually contains.
        base: `http://localhost:${address.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
  return started;
}
