import { createServer } from 'node:http';
import { network } from 'hardhat';

/**
 * Serve an in-process Hardhat chain over HTTP JSON-RPC, so commands can be
 * tested end to end exactly as they talk to a real node, without starting
 * `npm run node`.
 *
 * @returns {Promise<{ url: string, rpc: (method: string, params?: unknown[]) => Promise<any>, close(): Promise<void> }>}
 */
export async function startHardhatHttp() {
  const connection = await network.create();
  const rpc = (method, params = []) => connection.provider.request({ method, params });

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const { id, method, params } = JSON.parse(body);
      let reply;
      try {
        reply = { result: await rpc(method, params) };
      } catch (err) {
        reply = { error: { code: err.code ?? -32000, message: err.message } };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id, ...reply }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    rpc,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      await connection.close();
    },
  };
}

/** An IO that records what a command prints. */
export function captureIO(env = {}) {
  const out = [];
  const err = [];
  return {
    io: { out: { write: (s) => out.push(s) }, err: { write: (s) => err.push(s) }, env },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}
