#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { FAMILIES } from './generate/families.js';
import { buildIndex, buildVector } from './vectors/build.js';
import { DEFAULT_CORPUS_DIR, loadAllVectors, writeCorpus } from './vectors/load.js';
import { verifyCorpus } from './vectors/verify.js';
import { parseScript, serializeScript, unwrapScript } from './model/json.js';
import { shapeOf, remarksFor } from './model/invariants.js';
import { encodeScript, hashPreimage, scriptHashes, type ArrayEncoding } from './encode/script.js';
import { decodeScript, scriptHashFromCbor } from './encode/decode.js';
import { toHex } from './encode/cbor.js';
import {
  enterpriseAddress,
  govIdCip105,
  govIdCip129,
  rewardAddress,
  type Network,
} from './encode/credential.js';
import { evaluate, formatTrace } from './evaluate/evaluate.js';

const USAGE = `arachne <command>

  vectors build              regenerate the corpus, carrying chain observations forward
  vectors verify             re-derive every vector and report disagreements
  inspect <file|->           describe one native script: hashes, credentials, structure
  encode <file|-> [--as E]   JSON to CBOR hex. E is definite (default) or cardanoBinary
  decode <hex|->             CBOR hex to JSON, with the framing it used
  evaluate <file|-> [opts]   evaluate a script against a witness set
                             --signer <keyHash>   repeatable
                             --start <slot>       transaction validity start
                             --end <slot>         transaction validity end
  families                   list the generator families and the question each answers
`;

async function main(argv: string[]): Promise<number> {
  const [command, sub, ...rest] = argv;

  if (!command || command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }

  if (command === 'families') {
    for (const family of FAMILIES) {
      console.log(`${family.name}  (${family.cases().length} cases)`);
      console.log(`  ${family.question}\n`);
    }
    return 0;
  }

  if (command === 'vectors' && sub === 'build') {
    const vectors = FAMILIES.flatMap((family) =>
      family.cases().map((params) => buildVector(family, params)),
    );
    const version = await packageVersion();
    const index = buildIndex(vectors, `arachne@${version}`);
    const { written, observationsCarried } = await writeCorpus(vectors, index);
    console.log(
      `wrote ${written} vectors, ${index.satisfactionCaseCount} satisfaction cases, carried ${observationsCarried} chain observations`,
    );
    console.log(`digest ${index.digest}`);
    return 0;
  }

  if (command === 'vectors' && sub === 'verify') {
    const vectors = await loadAllVectors(DEFAULT_CORPUS_DIR);
    if (vectors.length === 0) {
      console.error('no vectors found. Run "arachne vectors build" first.');
      return 1;
    }
    const findings = verifyCorpus(vectors);
    if (findings.length === 0) {
      console.log(`${vectors.length} vectors verified, no findings`);
      return 0;
    }
    for (const finding of findings) {
      console.error(`${finding.kind}  ${finding.vectorId}`);
      console.error(`  ${finding.detail}`);
      console.error(`  expected ${finding.expected}`);
      console.error(`  actual   ${finding.actual}`);
    }
    console.error(`\n${findings.length} findings across ${vectors.length} vectors`);
    return 1;
  }

  if (command === 'encode') {
    const script = parseScript(unwrapScript(JSON.parse(await readInput(sub))));
    const as = (rest[0] === '--as' ? rest[1] : 'definite') as ArrayEncoding;
    if (as !== 'definite' && as !== 'cardanoBinary') {
      throw new Error(`--as expects definite or cardanoBinary, got ${as}`);
    }
    console.log(toHex(encodeScript(script, as)));
    return 0;
  }

  if (command === 'decode') {
    const hex = (await readInput(sub)).trim().replace(/\s+/g, '');
    const decoded = decodeScript(hex);
    console.log(JSON.stringify(serializeScript(decoded.script), null, 2));
    console.error(`script hash        ${scriptHashFromCbor(hex)}`);
    console.error(
      `framing            ${decoded.framings.length > 0 ? decoded.framings.join(', ') : 'neither standard encoding reproduces these bytes'}`,
    );
    console.error(`encoding sensitive ${decoded.encodingSensitive}`);
    if (decoded.framings.length === 0) {
      console.error(
        'warning            re-encoding this script would change its hash. Hash the bytes as received.',
      );
    }
    return 0;
  }

  if (command === 'inspect') {
    const script = parseScript(unwrapScript(JSON.parse(await readInput(sub))));
    const hashes = scriptHashes(script);
    const hash = hashes.definite;
    const shape = shapeOf(script);
    if (hashes.encodingSensitive) {
      console.log(`script hash        ${hashes.definite}   (definite: CSL, MeshJS)`);
      console.log(
        `script hash        ${hashes.cardanoBinary}   (cardanoBinary: cardano-cli, node)`,
      );
      console.log(`WARNING            this script has two valid hashes. See spec/07.`);
    } else {
      console.log(`script hash        ${hash}`);
    }
    console.log(`cbor               ${toHex(encodeScript(script))}`);
    console.log(`hash preimage      ${toHex(hashPreimage(script))}`);
    console.log(`depth              ${shape.depth}`);
    console.log(`nodes              ${shape.nodeCount}`);
    const distinct = shape.keyHashes.length;
    console.log(
      `sig nodes          ${shape.sigCount} (${distinct} distinct key${distinct === 1 ? '' : 's'})`,
    );
    console.log(`timelocks          ${shape.timelockCount}`);
    console.log(`cbor bytes         ${encodeScript(script).length}`);
    for (const network of ['mainnet', 'preview', 'preprod'] as Network[]) {
      console.log(`${network.padEnd(18)} ${enterpriseAddress(hash, network)}`);
      console.log(`${' '.repeat(18)} ${rewardAddress(hash, network)}`);
    }
    console.log(`drep (CIP-129)     ${govIdCip129(hash, 'drep')}`);
    console.log(`drep (CIP-105)     ${govIdCip105(hash, 'drep')}`);
    for (const remark of remarksFor(script)) {
      console.log(
        `remark             ${remark.code} at ${remark.path || '<root>'}: ${remark.detail}`,
      );
    }
    return 0;
  }

  if (command === 'evaluate') {
    const script = parseScript(unwrapScript(JSON.parse(await readInput(sub))));
    const signers: string[] = [];
    let validityStart: number | undefined;
    let validityEnd: number | undefined;
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      if (flag === '--signer') signers.push(value.toLowerCase());
      else if (flag === '--start') validityStart = Number(value);
      else if (flag === '--end') validityEnd = Number(value);
      else throw new Error(`unknown option ${flag}`);
    }
    const result = evaluate(script, {
      signers,
      ...(validityStart === undefined ? {} : { validityStart }),
      ...(validityEnd === undefined ? {} : { validityEnd }),
    });
    console.log(formatTrace(result.trace));
    console.log(`\nsatisfied: ${result.satisfied}`);
    if (result.missingSigners.length > 0) {
      console.log(`missing signers: ${result.missingSigners.join(', ')}`);
    }
    return result.satisfied ? 0 : 2;
  }

  console.error(`unknown command: ${[command, sub].filter(Boolean).join(' ')}\n`);
  console.error(USAGE);
  return 1;
}

async function readInput(path: string | undefined): Promise<string> {
  if (!path) throw new Error('expected a file path or "-" for stdin');
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8');
  }
  return readFile(path, 'utf8');
}

async function packageVersion(): Promise<string> {
  const url = new URL('../package.json', import.meta.url);
  const raw = await readFile(url, 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
