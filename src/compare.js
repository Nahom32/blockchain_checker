import { verifyHeaderHash } from './header.js';
import { ascending, fetchInOrder } from './fetch.js';

/**
 * Ask every provider for block `n`. One provider failing never aborts the
 * others: its entry carries the error instead.
 *
 * @returns {Promise<Array<{ label: string, block?: object|null, error?: string }>>}
 */
export function fetchFromAll(clients, n) {
  return Promise.all(
    clients.map(async (client) => {
      try {
        return { label: client.label, block: await client.getBlock(n) };
      } catch (err) {
        return { label: client.label, error: err.message };
      }
    }),
  );
}

/**
 * Compare what each provider returned for one block number.
 *
 * Each response is summarised as one of:
 *   { label, hash, valid: true }   block whose fields hash to its reported hash
 *   { label, hash, valid: false }  block whose fields do NOT match its hash
 *   { label, missing: true }       provider has no such block
 *   { label, error }               request failed
 *
 * `agreed` is true only if every provider returned a valid block and all
 * reported hashes are identical.
 */
export function compareBlock(number, responses) {
  const summaries = responses.map(({ label, block, error }) => {
    if (error) return { label, error };
    if (!block) return { label, missing: true };
    return { label, hash: String(block.hash).toLowerCase(), valid: verifyHeaderHash(block).valid };
  });

  const hashes = new Set(summaries.map((s) => s.hash));
  const agreed = summaries.every((s) => s.hash && s.valid) && hashes.size === 1;
  return { number, agreed, responses: summaries };
}

/**
 * Compare blocks `from`..`to` across all providers.
 *
 * @param {object} opts
 * @param {Array<{ label: string, getBlock: (n: bigint) => Promise<object|null> }>} opts.clients
 * @param {bigint} opts.from
 * @param {bigint} opts.to
 * @param {number} [opts.concurrency] block numbers in flight (each fetches from every provider)
 * @param {(result: ReturnType<typeof compareBlock>) => void} [opts.onBlock]
 */
export async function compareRange({ clients, from, to, concurrency, onBlock }) {
  const disagreements = [];
  let checked = 0;

  const fetchAll = (n) => fetchFromAll(clients, n);
  for await (const [n, responses] of fetchInOrder(ascending(from, to), fetchAll, concurrency)) {
    const result = compareBlock(n, responses);
    checked++;
    if (!result.agreed) disagreements.push(result);
    onBlock?.(result);
  }

  return { checked, disagreements };
}

/**
 * 'agree'      every provider returned the same valid block
 * 'conflict'   providers returned different hashes, or a block whose fields
 *              don't match its hash: someone is serving different data
 * 'incomplete' every block returned agrees, but some provider had no block
 *              or the request failed, so the comparison is partial
 */
export function kindOf(result) {
  if (result.agreed) return 'agree';
  const blocks = result.responses.filter((r) => r.hash);
  const hashes = new Set(blocks.map((r) => r.hash));
  if (hashes.size > 1 || blocks.some((r) => !r.valid)) return 'conflict';
  return 'incomplete';
}

/** Human-readable lines describing one non-agreeing block. */
export function describe(result) {
  const kind = kindOf(result);
  const title = {
    conflict: 'providers DISAGREE',
    incomplete: 'not every provider returned this block',
  }[kind];
  const lines = [`Block ${result.number}: ${title}`];

  // Group by hash and validity, so a provider serving edited fields under the
  // real hash is listed separately from the honest ones.
  const groups = new Map();
  for (const r of result.responses.filter((r) => r.hash)) {
    const key = `${r.hash}|${r.valid}`;
    if (!groups.has(key)) groups.set(key, { hash: r.hash, valid: r.valid, labels: [] });
    groups.get(key).labels.push(r.label);
  }
  for (const { hash, valid, labels } of groups.values()) {
    const note = valid ? '' : '  (block fields do NOT hash to this)';
    lines.push(`  ${hash}  ${labels.join(', ')}${note}`);
  }
  for (const r of result.responses.filter((r) => r.missing)) lines.push(`  no such block  ${r.label}`);
  for (const r of result.responses.filter((r) => r.error)) lines.push(`  request failed  ${r.error}`);
  return lines;
}
