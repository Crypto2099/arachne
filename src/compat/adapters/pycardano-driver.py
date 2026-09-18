"""Runs inside the scratch venv, with exactly `pycardano==<version>` (plus a
matching cbor2/cbor2pure pin, read from that release's own poetry.lock)
installed. Not part of this project's own Python code: this file is copied
into an isolated scratch directory by pycardano.ts and invoked there with
the venv's own interpreter, the same way csl-driver.mjs is copied next to a
scratch npm install rather than imported.

Exercises the construction paths pycardano exposes, chosen by argv[1]:

    construct <input.json>
      input.json is a JSON array of { id, script }, where "script" is this
      project's own native-script JSON shape (see src/model/types.ts). This
      is also exactly the shape NativeScript.from_dict expects:
      pycardano/nativescript.py's json_tag/json_field class attributes spell
      out the same "type"/"keyHash"/"scripts"/"required"/"slot" tags this
      project's model uses, so the corpus's own script dict is handed to it
      unchanged. Hashes the result with NativeScript.hash().

    decode <input.json>
      input.json is a JSON array of { id, definiteCborHex, cardanoBinaryCborHex }.
      Decodes each hex string on its own via NativeScript.from_cbor and hashes
      the result, answering both encodings independently.

      Unlike gouroboros's or pallas's decode path, this one is NOT framing
      preserving: NativeScript.hash() always calls self.to_cbor()
      (pycardano/nativescript.py), which re-serializes the decoded dataclass
      through cbor2 rather than hashing the bytes that were actually read.
      cbor2's own CBOREncoder takes an "indefinite_containers" constructor
      flag (cbor2/_encoder.py, or cbor2pure/_encoder.py under the pure-Python
      backend), off by default and applied to every container at once rather
      than chosen per array by size the way cardano-binary's rule is; since
      pycardano's dumps() call never sets it, every array it writes is
      definite-length regardless of how many elements it has. So decoding
      cardanoBinary-framed CBOR here and hashing the result returns the
      *definite* hash, not the cardanoBinary one. This path is still run and
      recorded, because that re-encoding is itself the finding worth having
      on record: it is a live example of spec/07-encoding-divergence.md's "a
      script is decoded from the chain and re-encoded before hashing"
      failure mode.

    onchain <input.json>
      input.json is a JSON array of { id, cborHex }, each entry one byte
      string a node has accepted. Decoded and hashed exactly as the decode
      mode does, so the re-encoding described above applies here too and is
      the point: these bytes are live, and a hash that does not match them is
      an address that holds no funds.

Every mode writes one JSON array to stdout and nothing else; all
human-readable diagnostics go to stderr, mirroring the other drivers'
stdout/stderr split.
"""

import json
import sys

from pycardano.nativescript import NativeScript


def to_hash_hex(native_script) -> str:
    return str(native_script.hash())


def run_construct(items):
    out = []
    for item in items:
        try:
            script = NativeScript.from_dict(item["script"])
            out.append({"id": item["id"], "status": "ok", "hash": to_hash_hex(script)})
        except Exception as e:  # noqa: BLE001 - report whatever pycardano raised, verbatim
            out.append({"id": item["id"], "status": "error", "error": str(e)})
    return out


def decode_and_hash(cbor_hex: str):
    try:
        script = NativeScript.from_cbor(cbor_hex)
        return {"status": "ok", "hash": to_hash_hex(script)}
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "error": str(e)}


def run_decode(items):
    out = []
    for item in items:
        out.append(
            {
                "id": item["id"],
                "definite": decode_and_hash(item["definiteCborHex"]),
                "cardanoBinary": decode_and_hash(item["cardanoBinaryCborHex"]),
            }
        )
    return out


def run_onchain(items):
    return [{"id": item["id"], **decode_and_hash(item["cborHex"])} for item in items]


def main() -> int:
    if len(sys.argv) != 3:
        print(
            "usage: pycardano-driver.py <construct|decode|onchain> <input.json>",
            file=sys.stderr,
        )
        return 1
    mode, input_path = sys.argv[1], sys.argv[2]
    with open(input_path, "r", encoding="utf8") as f:
        items = json.load(f)

    if mode == "construct":
        result = run_construct(items)
    elif mode == "decode":
        result = run_decode(items)
    elif mode == "onchain":
        result = run_onchain(items)
    else:
        print(f"unknown mode {mode!r}", file=sys.stderr)
        return 1

    sys.stdout.write(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
