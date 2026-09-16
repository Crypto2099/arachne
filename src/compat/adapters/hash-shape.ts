/**
 * A script hash is blake2b-224: 56 lowercase hex characters, nothing else.
 *
 * Every adapter checks its tool's output against this before recording it as a
 * hash. The check exists because a tool is not obliged to signal failure the
 * way an adapter expects: cardano-address writes its error to stderr and EXITS
 * ZERO, so a naive adapter records a successful hash of the empty string. That
 * produced nine bogus "diverged" rows before it was caught.
 *
 * A value that is not a hash is never a hash, whatever the exit code said.
 */
const HASH = /^[0-9a-f]{56}$/;

export function isScriptHash(value: string): boolean {
  return HASH.test(value.trim());
}

/** Collapse whitespace and cap length, for recording a tool's message verbatim but bounded. */
export function tidyToolMessage(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300);
}
