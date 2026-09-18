// Runs inside the scratch install, next to a go.mod pinned to the exact
// version of github.com/blinklabs-io/gouroboros under test. Not part of this
// project's own Go module (there isn't one): this file is copied into an
// isolated scratch directory by gouroboros.ts and built there, the same way
// csl-driver.mjs is copied next to a scratch npm install rather than imported.
//
// Exercises the construction paths gouroboros exposes, chosen by argv[1]:
//
//	construct <input.json>
//	  input.json is a JSON array of { id, script }, where "script" is this
//	  project's own native-script JSON shape (see src/model/types.ts).
//	  Builds the equivalent gouroboros structs, marshals them to CBOR, and
//	  hashes the result via common.NativeScript.Hash().
//
//	decode <input.json>
//	  input.json is a JSON array of { id, definiteCborHex, cardanoBinaryCborHex }.
//	  Decodes each hex string on its own via cbor.Decode into
//	  common.NativeScript and hashes it, answering both encodings
//	  independently: gouroboros's Hash() returns the hash of the bytes it
//	  decoded rather than re-encoding, so this is the one path that can show
//	  it reproducing whichever framing it was handed.
//
//	onchain <input.json>
//	  input.json is a JSON array of { id, cborHex }, each entry one byte
//	  string a node has accepted. Decoded and hashed exactly as "decode"
//	  does, one answer per item rather than two.
//
// Every mode writes one JSON array to stdout and nothing else; all
// human-readable diagnostics go to stderr, mirroring the other npm-backed
// drivers' stdout/stderr split.
package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/blinklabs-io/gouroboros/cbor"
	"github.com/blinklabs-io/gouroboros/ledger/common"
)

// jsonScript mirrors src/model/types.ts's NativeScript: `type` plus whichever
// of the other fields that tag uses. `Slot` is decoded as json.Number rather
// than a Go int so a slot outside the range of a 64-bit float still round-trips.
type jsonScript struct {
	Type     string       `json:"type"`
	KeyHash  string       `json:"keyHash"`
	Scripts  []jsonScript `json:"scripts"`
	Required int          `json:"required"`
	Slot     json.Number  `json:"slot"`
}

type constructItem struct {
	ID     string     `json:"id"`
	Script jsonScript `json:"script"`
}

type constructResult struct {
	ID     string `json:"id"`
	Status string `json:"status"` // "ok", "unsupported", or "error"
	Hash   string `json:"hash,omitempty"`
	Error  string `json:"error,omitempty"`
}

type decodeItem struct {
	ID                   string `json:"id"`
	DefiniteCborHex      string `json:"definiteCborHex"`
	CardanoBinaryCborHex string `json:"cardanoBinaryCborHex"`
}

type observedItem struct {
	ID      string `json:"id"`
	CborHex string `json:"cborHex"`
}

type hashOutcome struct {
	Status string `json:"status"` // "ok" or "error"
	Hash   string `json:"hash,omitempty"`
	Error  string `json:"error,omitempty"`
}

type decodeResult struct {
	ID            string      `json:"id"`
	Definite      hashOutcome `json:"definite"`
	CardanoBinary hashOutcome `json:"cardanoBinary"`
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: gouroboros-driver <construct|decode|onchain> <input.json>")
		os.Exit(1)
	}
	mode := os.Args[1]
	inputPath := os.Args[2]
	raw, err := os.ReadFile(inputPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}

	switch mode {
	case "construct":
		runConstruct(raw)
	case "decode":
		runDecode(raw)
	case "onchain":
		runOnchain(raw)
	default:
		fmt.Fprintf(os.Stderr, "unknown mode %q\n", mode)
		os.Exit(1)
	}
}

func runConstruct(raw []byte) {
	var items []constructItem
	if err := json.Unmarshal(raw, &items); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	out := make([]constructResult, 0, len(items))
	for _, item := range items {
		ns, err := buildNativeScript(item.Script)
		if err != nil {
			var unsupported unsupportedError
			status := "error"
			if errors.As(err, &unsupported) {
				status = "unsupported"
			}
			out = append(out, constructResult{ID: item.ID, Status: status, Error: err.Error()})
			continue
		}
		out = append(out, constructResult{
			ID:     item.ID,
			Status: "ok",
			Hash:   hex.EncodeToString(ns.Hash().Bytes()),
		})
	}
	emit(out)
}

func runDecode(raw []byte) {
	var items []decodeItem
	if err := json.Unmarshal(raw, &items); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	out := make([]decodeResult, 0, len(items))
	for _, item := range items {
		out = append(out, decodeResult{
			ID:            item.ID,
			Definite:      decodeAndHash(item.DefiniteCborHex),
			CardanoBinary: decodeAndHash(item.CardanoBinaryCborHex),
		})
	}
	emit(out)
}

// runOnchain answers one question per byte string, in the same flat shape
// runConstruct emits: an observed script has the single framing whatever
// submitted it chose, so there is no second encoding to ask about.
func runOnchain(raw []byte) {
	var items []observedItem
	if err := json.Unmarshal(raw, &items); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	out := make([]constructResult, 0, len(items))
	for _, item := range items {
		outcome := decodeAndHash(item.CborHex)
		out = append(out, constructResult{
			ID:     item.ID,
			Status: outcome.Status,
			Hash:   outcome.Hash,
			Error:  outcome.Error,
		})
	}
	emit(out)
}

func decodeAndHash(cborHex string) hashOutcome {
	b, err := hex.DecodeString(cborHex)
	if err != nil {
		return hashOutcome{Status: "error", Error: err.Error()}
	}
	// cbor.Decode into common.NativeScript is gouroboros's own polymorphic
	// native-script decoder (ledger/common/script.go); Hash() below hashes the
	// bytes it stored during decode rather than re-marshaling them, which is
	// the whole reason the decode path is worth measuring separately from
	// construct.
	var ns common.NativeScript
	if _, err := cbor.Decode(b, &ns); err != nil {
		return hashOutcome{Status: "error", Error: err.Error()}
	}
	return hashOutcome{Status: "ok", Hash: hex.EncodeToString(ns.Hash().Bytes())}
}

// unsupportedError marks a construct this driver recognizes ahead of calling
// into gouroboros at all as unrepresentable in its Go API, as distinct from an
// error the library raised while actually attempting the build.
type unsupportedError struct{ err error }

func (u unsupportedError) Error() string { return u.err.Error() }
func (u unsupportedError) Unwrap() error { return u.err }

// buildNativeScript recursively builds and CBOR-encodes a native script from
// this project's plain-JSON AST. Each node is encoded as its own concrete
// struct and immediately decoded back into the common.NativeScript wrapper
// (ledger/common/script.go's NativeScriptAll etc. hold []common.NativeScript,
// not the concrete leaf/branch types) so it can be embedded inside a parent
// container's Scripts slice; the outermost call's result is hashed as-is.
func buildNativeScript(s jsonScript) (*common.NativeScript, error) {
	switch s.Type {
	case "sig":
		kh, err := hex.DecodeString(s.KeyHash)
		if err != nil {
			return nil, fmt.Errorf("keyHash: %w", err)
		}
		// Type 0: script_pubkey, CDDL native_script index 0.
		return encodeAndWrap(&common.NativeScriptPubkey{Type: 0, Hash: kh})
	case "all":
		subs, err := buildChildren(s.Scripts)
		if err != nil {
			return nil, err
		}
		// Type 1: script_all, CDDL native_script index 1.
		return encodeAndWrap(&common.NativeScriptAll{Type: 1, Scripts: subs})
	case "any":
		subs, err := buildChildren(s.Scripts)
		if err != nil {
			return nil, err
		}
		// Type 2: script_any, CDDL native_script index 2.
		return encodeAndWrap(&common.NativeScriptAny{Type: 2, Scripts: subs})
	case "atLeast":
		// gouroboros declares NativeScriptNofK.N as a Go uint. There is no way
		// to hand it a negative threshold without an unsafe integer conversion
		// that would wrap to a huge unsigned value instead of reporting
		// anything, so this is recognized as unrepresentable ahead of calling
		// into the library at all, the same way an adapter would return
		// "unsupported" for any other construct a tool's own API cannot hold.
		if s.Required < 0 {
			return nil, unsupportedError{fmt.Errorf(
				"atLeast required is %d: gouroboros's NativeScriptNofK.N is a Go uint and cannot represent a negative threshold",
				s.Required,
			)}
		}
		subs, err := buildChildren(s.Scripts)
		if err != nil {
			return nil, err
		}
		// Type 3: script_n_of_k, CDDL native_script index 3.
		return encodeAndWrap(&common.NativeScriptNofK{Type: 3, N: uint(s.Required), Scripts: subs})
	case "after":
		// JSON "after" is CDDL invalid_before (index 4): valid only at or after
		// this slot. See src/model/types.ts's ScriptAfter doc comment.
		slot, err := s.Slot.Int64()
		if err != nil {
			return nil, fmt.Errorf("slot: %w", err)
		}
		return encodeAndWrap(&common.NativeScriptInvalidBefore{Type: 4, Slot: uint64(slot)})
	case "before":
		// JSON "before" is CDDL invalid_hereafter (index 5): valid only
		// strictly before this slot.
		slot, err := s.Slot.Int64()
		if err != nil {
			return nil, fmt.Errorf("slot: %w", err)
		}
		return encodeAndWrap(&common.NativeScriptInvalidHereafter{Type: 5, Slot: uint64(slot)})
	default:
		return nil, fmt.Errorf("unknown script type %q", s.Type)
	}
}

func buildChildren(children []jsonScript) ([]common.NativeScript, error) {
	out := make([]common.NativeScript, 0, len(children))
	for _, c := range children {
		ns, err := buildNativeScript(c)
		if err != nil {
			return nil, err
		}
		out = append(out, *ns)
	}
	return out, nil
}

func encodeAndWrap(item any) (*common.NativeScript, error) {
	enc, err := cbor.Encode(item)
	if err != nil {
		return nil, err
	}
	var ns common.NativeScript
	if _, err := cbor.Decode(enc, &ns); err != nil {
		return nil, err
	}
	return &ns, nil
}

func emit(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(1)
	}
	os.Stdout.Write(b)
}
