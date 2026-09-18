// Runs inside the scratch install, next to a Cargo.toml pinned to the exact
// version of pallas-primitives (plus the matching pallas-codec and
// pallas-crypto releases, which the upstream workspace always cuts
// lockstep) under test. Not part of this project's own Rust code (there
// isn't one): this file is copied into an isolated scratch directory by
// pallas.ts and built there, the same way gouroboros-driver.go is copied
// next to a scratch Go module rather than imported.
//
// Exercises both construction paths pallas-primitives exposes, chosen by
// argv[1]:
//
//	construct <input.json>
//	  input.json is a JSON array of { id, script }, where "script" is this
//	  project's own native-script JSON shape (see src/model/types.ts).
//	  Builds the equivalent pallas_primitives::alonzo::NativeScript tree and
//	  hashes it via pallas_crypto::hash::Hasher<224>::hash_tagged_cbor(&ns, 0),
//	  which is minicbor-encoding the tree and blake2b-224-hashing it with the
//	  0x00 native-script language tag prepended, the same preimage this
//	  project's own scriptHash uses (src/encode/script.ts).
//
//	decode <input.json>
//	  input.json is a JSON array of { id, definiteCborHex, cardanoBinaryCborHex }.
//	  Decodes each hex string on its own into
//	  pallas_codec::utils::KeepRaw<NativeScript> and hashes THAT rather than
//	  the plain NativeScript: KeepRaw's Decode impl (pallas-codec's
//	  src/utils.rs) records the exact byte range minicbor read, and its
//	  Encode impl writes those bytes back verbatim instead of re-serializing
//	  the decoded tree, so hashing a KeepRaw value hashes what was actually
//	  decoded. NativeScript's own Encode impl (pallas-primitives'
//	  src/alonzo/native_script.rs) always calls minicbor's `Encoder::array`,
//	  which only ever writes a definite-length header, so hashing the plain
//	  (non-KeepRaw) decoded tree would silently normalize every answer to
//	  "definite" and this path would not be able to tell that apart from
//	  "construct". KeepRaw is what makes decode answer a different question.
//
// Either mode writes one JSON array to stdout and nothing else; all
// human-readable diagnostics go to stderr, mirroring the other drivers'
// stdout/stderr split.

use pallas_codec::minicbor;
use pallas_crypto::hash::Hasher;
use pallas_primitives::alonzo::NativeScript;
use pallas_primitives::{Hash, KeepRaw};
use serde::{Deserialize, Serialize};
use std::env;
use std::fs;
use std::process::ExitCode;

/// Mirrors src/model/types.ts's NativeScript: `type` plus whichever of the
/// other fields that tag uses. `atLeast`'s `required` is `i64` because
/// NativeScript::ScriptNOfK.1 is `i64` (the ledger CDDL types this threshold
/// signed, widened from int32 in Shelley to int64 in Allegra; pallas's own
/// doc comment on the field says so), which is also what lets this driver
/// represent the corpus's one negative-threshold vector directly rather than
/// needing an "unsupported" outcome the way a Go `uint` field would.
#[derive(Deserialize)]
#[serde(tag = "type")]
enum JsonScript {
    #[serde(rename = "sig")]
    Sig {
        #[serde(rename = "keyHash")]
        key_hash: String,
    },
    #[serde(rename = "all")]
    All { scripts: Vec<JsonScript> },
    #[serde(rename = "any")]
    Any { scripts: Vec<JsonScript> },
    #[serde(rename = "atLeast")]
    AtLeast {
        required: i64,
        scripts: Vec<JsonScript>,
    },
    #[serde(rename = "after")]
    After { slot: u64 },
    #[serde(rename = "before")]
    Before { slot: u64 },
}

fn build(script: &JsonScript) -> Result<NativeScript, String> {
    Ok(match script {
        JsonScript::Sig { key_hash } => {
            let kh: Hash<28> = key_hash.parse().map_err(|e| format!("keyHash: {e}"))?;
            NativeScript::ScriptPubkey(kh)
        }
        JsonScript::All { scripts } => NativeScript::ScriptAll(build_children(scripts)?),
        JsonScript::Any { scripts } => NativeScript::ScriptAny(build_children(scripts)?),
        JsonScript::AtLeast { required, scripts } => {
            NativeScript::ScriptNOfK(*required, build_children(scripts)?)
        }
        // JSON "after" is CDDL invalid_before (index 4): valid only at or
        // after this slot. See src/model/types.ts's ScriptAfter doc comment.
        JsonScript::After { slot } => NativeScript::InvalidBefore(*slot),
        // JSON "before" is CDDL invalid_hereafter (index 5): valid only
        // strictly before this slot.
        JsonScript::Before { slot } => NativeScript::InvalidHereafter(*slot),
    })
}

fn build_children(scripts: &[JsonScript]) -> Result<Vec<NativeScript>, String> {
    scripts.iter().map(build).collect()
}

#[derive(Deserialize)]
struct ConstructItem {
    id: String,
    script: JsonScript,
}

#[derive(Serialize)]
struct ConstructResult {
    id: String,
    status: &'static str, // "ok" or "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// The corpus is a fixed, trusted fixture rather than adversarial input, but
/// its own "nest-linear" and "nest-alternating" families exist specifically
/// to probe how deep a real tool tolerates nesting (their own `question`
/// fields in src/generate/families.ts say so directly), and serde's
/// internally-tagged enum representation buffers each value into an
/// intermediate `Content` tree before re-materializing it into `T`, which
/// roughly doubles the effective recursion depth for the SAME JSON nesting.
/// A depth-65 vector already exceeds serde_json's default 128-frame guard
/// through that doubling. Disabling the guard and driving the parse through
/// `serde_stacker` (serde_json's own documented pattern for this, `struct.
/// Deserializer.html#method.disable_recursion_limit`) grows the real stack
/// dynamically instead, so this driver stays correct at whatever depth the
/// corpus uses rather than silently reporting every vector as refused.
fn parse_deep<T: serde::de::DeserializeOwned>(raw: &str) -> Result<T, String> {
    let mut de = serde_json::Deserializer::from_str(raw);
    de.disable_recursion_limit();
    let de = serde_stacker::Deserializer::new(&mut de);
    T::deserialize(de).map_err(|e| e.to_string())
}

fn run_construct(raw: &str) -> Result<Vec<ConstructResult>, String> {
    let items: Vec<ConstructItem> = parse_deep(raw)?;
    Ok(items
        .iter()
        .map(|item| match build(&item.script) {
            Ok(ns) => ConstructResult {
                id: item.id.clone(),
                status: "ok",
                hash: Some(Hasher::<224>::hash_tagged_cbor(&ns, 0).to_string()),
                error: None,
            },
            Err(e) => ConstructResult { id: item.id.clone(), status: "error", hash: None, error: Some(e) },
        })
        .collect())
}

#[derive(Deserialize)]
struct DecodeItem {
    id: String,
    #[serde(rename = "definiteCborHex")]
    definite_cbor_hex: String,
    #[serde(rename = "cardanoBinaryCborHex")]
    cardano_binary_cbor_hex: String,
}

#[derive(Serialize)]
struct HashOutcome {
    status: &'static str, // "ok" or "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct DecodeResult {
    id: String,
    definite: HashOutcome,
    #[serde(rename = "cardanoBinary")]
    cardano_binary: HashOutcome,
}

fn decode_and_hash(cbor_hex: &str) -> HashOutcome {
    let bytes = match hex::decode(cbor_hex) {
        Ok(b) => b,
        Err(e) => return HashOutcome { status: "error", hash: None, error: Some(e.to_string()) },
    };
    match minicbor::decode::<KeepRaw<NativeScript>>(&bytes) {
        Ok(kept) => HashOutcome {
            status: "ok",
            hash: Some(Hasher::<224>::hash_tagged_cbor(&kept, 0).to_string()),
            error: None,
        },
        Err(e) => HashOutcome { status: "error", hash: None, error: Some(e.to_string()) },
    }
}

fn run_decode(raw: &str) -> Result<Vec<DecodeResult>, String> {
    let items: Vec<DecodeItem> = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    Ok(items
        .iter()
        .map(|item| DecodeResult {
            id: item.id.clone(),
            definite: decode_and_hash(&item.definite_cbor_hex),
            cardano_binary: decode_and_hash(&item.cardano_binary_cbor_hex),
        })
        .collect())
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: pallas-driver <construct|decode> <input.json>");
        return ExitCode::FAILURE;
    }
    let raw = match fs::read_to_string(&args[2]) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let emitted = match args[1].as_str() {
        "construct" => run_construct(&raw).and_then(|r| serde_json::to_string(&r).map_err(|e| e.to_string())),
        "decode" => run_decode(&raw).and_then(|r| serde_json::to_string(&r).map_err(|e| e.to_string())),
        other => Err(format!("unknown mode {other:?}")),
    };
    match emitted {
        Ok(json) => {
            print!("{json}");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}
