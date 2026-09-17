// Runs inside the scratch install, alongside the version of the package
// under test. Not built or typechecked with the rest of the project on
// purpose, the same reason csl-driver.mjs and cml-driver.mjs are not: it has
// to import a package this project does not depend on, resolved from a
// directory picked at runtime.
//
// `argv`: [mode, pkg, namespace, inputPath]. `pkg` and `namespace` are read
// from argv rather than hard-coded because this one driver answers for every
// tool registered against the "npm-native-script-classes" adapter kind:
// "@cardano-sdk/core" exposes its `NativeScript`/`ScriptAll`/... classes
// under a `Serialization` namespace, while "@blaze-cardano/core" re-exports
// the identical classes at its module root (`const NativeScript =
// Serialization.NativeScript` in Blaze's own source: it is not a
// reimplementation, it is the same class under a shorter path). `namespace`
// is the empty string for the root case and a dotted path ("Serialization")
// otherwise.
//
// `mode` is "construct" (build from the corpus's JSON shape and hash) or
// "decode" (hash whatever CBOR bytes were handed over, once per encoding).
// Both packages preserve the framing of whatever CBOR they decoded: every
// class here keeps its original bytes internally and `toCbor()` returns them
// verbatim when present, so `.hash()` after `fromCbor(...)` reflects the
// input's own array-length framing rather than re-imposing one.
import { readFileSync } from 'node:fs';

const [, , mode, pkg, namespaceArg, inputPath] = process.argv;

const modNS = await import(pkg);
const mod = modNS.default ?? modNS;
const ns =
  namespaceArg === '' ? mod : namespaceArg.split('.').reduce((acc, key) => acc?.[key], mod);
if (!ns || !ns.NativeScript) {
  process.stderr.write(
    `native-script-classes-driver.mjs: module "${pkg}" has no NativeScript export at namespace "${namespaceArg}"`,
  );
  process.exit(1);
}
const {
  NativeScript,
  ScriptAll,
  ScriptAny,
  ScriptNOfK,
  ScriptPubkey,
  TimelockStart,
  TimelockExpiry,
} = ns;

function toNative(script) {
  switch (script.type) {
    case 'sig':
      return NativeScript.newScriptPubkey(new ScriptPubkey(script.keyHash));
    case 'all':
      return NativeScript.newScriptAll(new ScriptAll(script.scripts.map(toNative)));
    case 'any':
      return NativeScript.newScriptAny(new ScriptAny(script.scripts.map(toNative)));
    case 'atLeast':
      return NativeScript.newScriptNOfK(
        new ScriptNOfK(script.scripts.map(toNative), script.required),
      );
    case 'after':
      // CDDL invalid_before (tag 4): valid only at or after `slot`.
      return NativeScript.newTimelockStart(new TimelockStart(script.slot));
    case 'before':
      // CDDL invalid_hereafter (tag 5): valid only strictly before `slot`.
      return NativeScript.newTimelockExpiry(new TimelockExpiry(script.slot));
    default:
      throw new Error(`unknown native script type "${script.type}"`);
  }
}

const items = JSON.parse(readFileSync(inputPath, 'utf8'));

if (mode === 'construct') {
  const out = items.map(({ id, script }) => {
    try {
      const built = toNative(script);
      return { id, status: 'ok', hash: built.hash() };
    } catch (error) {
      return { id, status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  });
  process.stdout.write(JSON.stringify(out));
} else if (mode === 'decode') {
  const decodeOne = (cborHex) => {
    try {
      return { status: 'ok', hash: NativeScript.fromCbor(cborHex).hash() };
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  };
  const out = items.map(({ id, definiteCborHex, cardanoBinaryCborHex }) => ({
    id,
    definite: decodeOne(definiteCborHex),
    cardanoBinary: decodeOne(cardanoBinaryCborHex),
  }));
  process.stdout.write(JSON.stringify(out));
} else {
  process.stderr.write(
    `native-script-classes-driver.mjs: unknown mode "${mode}", expected "construct" or "decode"`,
  );
  process.exit(1);
}
