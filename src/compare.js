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

export const DEFAULT_CONFIRMATIONS = 64n; // about two epochs on Ethereum mainnet

/**
 * Work out which blocks are finalized.
 *
 * A block counts as finalized if ANY provider says it is, so the boundary is
 * the HIGHEST 'finalized' block reported. Taking the lowest would let one
 * dishonest provider claim finalized = 0 and have every block it forged
 * excused as a reorg. With the highest, a liar can only claim too much
 * finality, which turns a genuine reorg into a loud false alarm: something to
 * investigate, never a missed attack.
 *
 * Each claim is capped at that provider's own head (a block it hasn't seen
 * can't be finalized). A provider without the 'finalized' tag counts as
 * finalized up to its head minus `confirmations`.
 *
 * @param {Array<{ client, head: bigint }>} providers
 * @returns {Promise<{ boundary: bigint, providers: Array<{ label: string, head: bigint,
 *   finalized: bigint, source: 'tag' | 'confirmations' }> }>}
 */
export async function getFinality(providers, confirmations = DEFAULT_CONFIRMATIONS) {
  const perProvider = await Promise.all(
    providers.map(async ({ client, head }) => {
      const info = { label: client.label, head };
      try {
        const block = await client.request('eth_getBlockByNumber', ['finalized', false]);
        if (block) {
          const claimed = BigInt(block.number);
          return { ...info, finalized: claimed < head ? claimed : head, source: 'tag' };
        }
      } catch {
        // Tag unsupported (pre-merge chains, some nodes): fall back below.
      }
      return { ...info, finalized: head > confirmations ? head - confirmations : 0n, source: 'confirmations' };
    }),
  );
  const boundary = perProvider.map((p) => p.finalized).reduce((a, b) => (a > b ? a : b));
  return { boundary, providers: perProvider };
}

/**
 * Warnings about providers whose reported head or finality is far from the
 * others: lagging nodes, or nodes misreporting either. Neither can hide a
 * forgery (heads only narrow the compared range, which is printed, and low
 * finality claims are ignored), but they should be visible, not silent.
 *
 * @param {Awaited<ReturnType<typeof getFinality>>} finality
 * @returns {string[]}
 */
export function providerWarnings(finality, confirmations = DEFAULT_CONFIRMATIONS) {
  const warnings = [];
  const highestHead = finality.providers.map((p) => p.head).reduce((a, b) => (a > b ? a : b));

  for (const p of finality.providers) {
    const behind = highestHead - p.head;
    if (behind > confirmations) {
      warnings.push(`${p.label}'s head is ${behind} blocks behind the highest; only blocks up to ${p.head} can be compared.`);
    }
    const finalityGap = finality.boundary - p.finalized;
    if (p.source === 'tag' && finalityGap > confirmations) {
      warnings.push(
        `${p.label} reports finalized ${p.finalized}, ${finalityGap} blocks behind the others ` +
          '(lagging, or misreporting finality); its claim is not used.',
      );
    }
  }
  return warnings;
}

/**
 * 'agree'       every provider returned the same valid block
 * 'conflict'    providers returned different hashes, or a block whose fields
 *               don't match its hash: someone is serving different data
 * 'unfinalized' a conflict on a block above `finalized`: honest nodes can
 *               briefly disagree there during a reorg, so it is not proof
 *               of tampering
 * 'incomplete'  every block returned agrees, but some provider had no block
 *               or the request failed, so the comparison is partial
 *
 * @param {bigint} [finalized] highest finalized block number; omit to treat
 *   every block as finalized
 */
export function kindOf(result, finalized) {
  if (result.agreed) return 'agree';
  const blocks = result.responses.filter((r) => r.hash);
  const hashes = new Set(blocks.map((r) => r.hash));
  const invalid = blocks.some((r) => !r.valid);

  // A block whose fields don't match its own hash is never a reorg.
  if (invalid) return 'conflict';
  if (hashes.size > 1) return finalized !== undefined && result.number > finalized ? 'unfinalized' : 'conflict';
  return 'incomplete';
}

/** Human-readable lines describing one non-agreeing block. */
export function describe(result, finalized) {
  const kind = kindOf(result, finalized);
  const title = {
    conflict: 'providers DISAGREE',
    unfinalized: 'providers disagree, but the block is not finalized yet (likely a reorg near the head)',
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
