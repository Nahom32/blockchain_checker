/**
 * Where a command writes, and the environment it reads. Commands take this
 * instead of using console and process.env directly, so tests can run them
 * in-process and capture what they print.
 *
 * @typedef {{ out: { write(s: string): void }, err: { write(s: string): void }, env: Record<string, string | undefined> }} IO
 */

/** @returns {IO} */
export function processIO() {
  return { out: process.stdout, err: process.stderr, env: process.env };
}

/** Line-oriented helpers over an IO. */
export function printer(io) {
  return {
    log: (line = '') => io.out.write(`${line}\n`),
    error: (line = '') => io.err.write(`${line}\n`),
  };
}
