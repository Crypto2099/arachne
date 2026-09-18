// Runs inside the scratch install, alongside the version of the CML-family
// package under test. Not built or typechecked with the rest of the project
// on purpose, the same reason csl-driver.mjs is not: it has to import a
// package this project does not depend on, resolved from a directory picked
// at runtime, which only works from a plain Node process next to that
// package's own node_modules.
//
// `argv`: [mode, pkg, inputPath]. `pkg` is read from argv rather than
// hard-coded because this one driver answers for every tool registered
// against the "npm-cml" adapter kind: dcSpark's own
// "@dcspark/cardano-multiplatform-lib-nodejs" and the Anastasia Labs fork
// "@anastasia-labs/cardano-multiplatform-lib-nodejs" both expose this exact
// constructor API (same upstream source, same generated WASM bindings), and
// a driver that imported one hard-coded package name would fail to find the
// other one's install.
//
// `mode` is "construct" (build from the corpus's JSON shape and hash),
// "decode" (hash whatever CBOR bytes were handed over, once per encoding), or
// "onchain" (the same hashing, over one byte string per item, taken from what
// a node has actually accepted). CML answers construction and decoding
// differently: construction always yields definite-length arrays, matching
// cardano-serialization-lib, while decoding preserves whichever framing the
// input CBOR already used, because `NativeScript.from_cbor_hex` keeps the
// original bytes and `.hash()` hashes those rather than a freshly re-encoded
// copy.
import { readFileSync } from 'node:fs';

const [, , mode, pkg, inputPath] = process.argv;

const CMLNS = await import(pkg);
const CML = CMLNS.default ?? CMLNS;

// CML's builder API differs from cardano-serialization-lib's in two ways
// that matter here: `new_script_pubkey` takes an `Ed25519KeyHash` directly
// rather than a `ScriptPubkey` wrapper, and the threshold and timelock slot
// arguments are Rust `u64` fields bound as JS `BigInt` rather than `BigNum`,
// so they need `BigInt(...)`, not `String(...)`.
function toNative(script) {
  switch (script.type) {
    case 'sig':
      return CML.NativeScript.new_script_pubkey(CML.Ed25519KeyHash.from_hex(script.keyHash));
    case 'all':
      return CML.NativeScript.new_script_all(toList(script.scripts));
    case 'any':
      return CML.NativeScript.new_script_any(toList(script.scripts));
    case 'atLeast':
      return CML.NativeScript.new_script_n_of_k(BigInt(script.required), toList(script.scripts));
    case 'after':
      // CDDL invalid_before (tag 4): valid only at or after `slot`.
      return CML.NativeScript.new_script_invalid_before(BigInt(script.slot));
    case 'before':
      // CDDL invalid_hereafter (tag 5): valid only strictly before `slot`.
      return CML.NativeScript.new_script_invalid_hereafter(BigInt(script.slot));
    default:
      throw new Error(`unknown native script type "${script.type}"`);
  }
}

function toList(scripts) {
  const list = CML.NativeScriptList.new();
  for (const child of scripts) list.add(toNative(child));
  return list;
}

const items = JSON.parse(readFileSync(inputPath, 'utf8'));

const decodeOne = (cborHex) => {
  try {
    return { status: 'ok', hash: CML.NativeScript.from_cbor_hex(cborHex).hash().to_hex() };
  } catch (error) {
    return { status: 'error', error: error instanceof Error ? error.message : String(error) };
  }
};

if (mode === 'construct') {
  const out = items.map(({ id, script }) => {
    try {
      const built = toNative(script);
      return { id, status: 'ok', hash: built.hash().to_hex() };
    } catch (error) {
      return { id, status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  });
  process.stdout.write(JSON.stringify(out));
} else if (mode === 'decode') {
  const out = items.map(({ id, definiteCborHex, cardanoBinaryCborHex }) => ({
    id,
    definite: decodeOne(definiteCborHex),
    cardanoBinary: decodeOne(cardanoBinaryCborHex),
  }));
  process.stdout.write(JSON.stringify(out));
} else if (mode === 'onchain') {
  const out = items.map(({ id, cborHex }) => ({ id, ...decodeOne(cborHex) }));
  process.stdout.write(JSON.stringify(out));
} else {
  process.stderr.write(
    `cml-driver.mjs: unknown mode "${mode}", expected "construct", "decode" or "onchain"`,
  );
  process.exit(1);
}
