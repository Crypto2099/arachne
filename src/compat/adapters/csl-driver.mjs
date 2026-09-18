// Runs inside the scratch install, alongside the version of
// @emurgo/cardano-serialization-lib-nodejs under test. Not built or
// typechecked with the rest of the project on purpose: it has to import a
// package this project does not depend on, resolved from a directory picked
// at runtime, which only works from a plain Node process next to that
// package's own node_modules.
//
// The construction mirrors test/unit/csl-crosscheck.test.ts's `toCsl`, which
// is what pins this project's own encoder against CSL. It is duplicated
// rather than imported because this file runs as a subprocess with no access
// to this project's TypeScript sources, only to whatever got installed here.
//
// `argv`: [mode, inputPath], the order every driver here takes.
//
//   node csl-driver.mjs construct <input.json>
//     input.json is a JSON array of { id, script }. Builds the equivalent
//     CSL structs via the builder API below and hashes the result.
//
//   node csl-driver.mjs decode <input.json>
//     input.json is a JSON array of { id, definiteCborHex, cardanoBinaryCborHex }.
//     Decodes each hex string on its own via NativeScript.from_bytes and
//     hashes it, answering both encodings independently.
import { readFileSync } from 'node:fs';

const CSLNS = await import('@emurgo/cardano-serialization-lib-nodejs');
const CSL = CSLNS.default ?? CSLNS;

function toCsl(script) {
  switch (script.type) {
    case 'sig':
      return CSL.NativeScript.new_script_pubkey(
        CSL.ScriptPubkey.new(CSL.Ed25519KeyHash.from_hex(script.keyHash)),
      );
    case 'all':
      return CSL.NativeScript.new_script_all(CSL.ScriptAll.new(toCslList(script.scripts)));
    case 'any':
      return CSL.NativeScript.new_script_any(CSL.ScriptAny.new(toCslList(script.scripts)));
    case 'atLeast':
      return CSL.NativeScript.new_script_n_of_k(
        CSL.ScriptNOfK.new(script.required, toCslList(script.scripts)),
      );
    case 'after':
      return CSL.NativeScript.new_timelock_start(
        CSL.TimelockStart.new_timelockstart(CSL.BigNum.from_str(String(script.slot))),
      );
    case 'before':
      return CSL.NativeScript.new_timelock_expiry(
        CSL.TimelockExpiry.new_timelockexpiry(CSL.BigNum.from_str(String(script.slot))),
      );
    default:
      throw new Error(`unknown native script type "${script.type}"`);
  }
}

function toCslList(scripts) {
  const list = CSL.NativeScripts.new();
  for (const script of scripts) list.add(toCsl(script));
  return list;
}

// NativeScript.from_bytes decodes existing CBOR into a CSL struct; whether
// the hash that follows reproduces the bytes fed in or CSL's own definite
// framing is exactly the question the decode path exists to answer, and is
// not assumed here.
function decodeAndHash(cborHex) {
  try {
    const script = CSL.NativeScript.from_bytes(Buffer.from(cborHex, 'hex'));
    return { status: 'ok', hash: script.hash().to_hex() };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
}

const [, , mode, inputPath] = process.argv;
const items = JSON.parse(readFileSync(inputPath, 'utf8'));

if (mode === 'decode') {
  const out = items.map(({ id, definiteCborHex, cardanoBinaryCborHex }) => ({
    id,
    definite: decodeAndHash(definiteCborHex),
    cardanoBinary: decodeAndHash(cardanoBinaryCborHex),
  }));
  process.stdout.write(JSON.stringify(out));
} else {
  const out = items.map(({ id, script }) => {
    try {
      const built = toCsl(script);
      return { id, status: 'ok', hash: built.hash().to_hex() };
    } catch (error) {
      return { id, status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  });
  process.stdout.write(JSON.stringify(out));
}
