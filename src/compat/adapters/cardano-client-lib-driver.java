// Runs inside the scratch Maven build set up by cardano-client-lib.ts, which
// writes a pom.xml pinned to the exact version of com.bloxbean.cardano:
// cardano-client-lib under test next to a copy of this file, then packages
// both into one runnable jar with the Maven Assembly Plugin. Not part of this
// project's own build (there isn't a Java one): this file is copied into an
// isolated scratch directory the same way gouroboros-driver.go is copied next
// to a scratch go.mod rather than compiled as part of this repository.
//
// Exercises the construction paths cardano-client-lib exposes, chosen by
// argv[0]:
//
// construct <input.json>
// input.json is a JSON array of { id, script }, where "script" is this
// project's own native-script JSON shape (see src/model/types.ts). Its
// tag names ("sig", "all", "any", "atLeast", "after", "before") and field
// names ("keyHash", "scripts", "required", "slot") are exactly the ones
// cardano-client-lib's own NativeScript.deserializeJson expects, so this
// hands the script straight to that method rather than walking the tree
// and rebuilding it through the library's Java constructors, and hashes
// the result via NativeScript.getScriptHash().
//
// decode <input.json>
// input.json is a JSON array of { id, definiteCborHex, cardanoBinaryCborHex }.
// Decodes each hex string on its own: CborSerializationUtil.deserialize
// turns the bytes into a co.nstant.in.cbor DataItem, and
// NativeScript.deserialize(Array) turns that into the library's own
// domain object, which is then hashed the same way the construct path
// hashes one. This is a real decode-and-hash path, but not one that
// preserves the framing it was given: NativeScript.getScriptHash() always
// calls serializeAsDataItem() again, which always builds a fresh, plain
// "new Array()" (see co.nstant.in.cbor.model.Array, which defaults to
// definite-length unless setChunked(true) is called, and cardano-client-
// lib's ScriptAll/ScriptAny/ScriptAtLeast never call it), so both of a
// vector's two encodings hash to the same, definite-length answer here.
// That is the finding this path exists to check for, not an assumption
// this driver makes ahead of running it.
//
// onchain <input.json>
// input.json is a JSON array of { id, cborHex }, each entry one byte string
// a node has accepted. Decoded through the same path "decode" uses, one
// answer per item rather than two, so the re-serialization described above
// applies here as well.
//
// Every mode writes one JSON array to stdout and nothing else; all
// human-readable diagnostics, including the SLF4J "no provider found"
// warning cardano-client-lib's own logging call emits, go to stderr,
// mirroring the other drivers' stdout/stderr split.
import co.nstant.in.cbor.model.Array;
import co.nstant.in.cbor.model.DataItem;
import com.bloxbean.cardano.client.common.cbor.CborSerializationUtil;
import com.bloxbean.cardano.client.transaction.spec.script.NativeScript;
import com.bloxbean.cardano.client.util.HexUtil;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

public final class Driver {
    public static void main(String[] args) throws Exception {
        if (args.length != 2) {
            System.err.println("usage: driver <construct|decode|onchain> <input.json>");
            System.exit(1);
            return;
        }
        String mode = args[0];
        String inputPath = args[1];
        ObjectMapper mapper = new ObjectMapper();
        JsonNode items =
                mapper.readTree(Files.readString(Paths.get(inputPath), StandardCharsets.UTF_8));

        ArrayNode out = mapper.createArrayNode();
        switch (mode) {
            case "construct":
                for (JsonNode item : items) out.add(construct(mapper, item));
                break;
            case "decode":
                for (JsonNode item : items) out.add(decode(mapper, item));
                break;
            case "onchain":
                for (JsonNode item : items) out.add(onchain(mapper, item));
                break;
            default:
                System.err.println("unknown mode \"" + mode + "\"");
                System.exit(1);
                return;
        }
        System.out.print(mapper.writeValueAsString(out));
    }

    /**
     * Builds a NativeScript from the corpus's own JSON shape via the library's
     * own deserializer and hashes it. Every status this driver can report is
     * "ok" or "error": cardano-client-lib's ScriptAtLeast.required is a
     * BigInteger, unlike gouroboros's Go uint, so it represents the corpus's
     * one negative-threshold vector natively rather than needing an
     * "unsupported" case ahead of calling into the library.
     */
    private static ObjectNode construct(ObjectMapper mapper, JsonNode item) {
        ObjectNode result = mapper.createObjectNode();
        result.put("id", item.get("id").asText());
        try {
            NativeScript script = NativeScript.deserializeJson(item.get("script").toString());
            result.put("status", "ok");
            result.put("hash", HexUtil.encodeHexString(script.getScriptHash()));
        } catch (Throwable t) {
            result.put("status", "error");
            result.put("error", messageOf(t));
        }
        return result;
    }

    private static ObjectNode decode(ObjectMapper mapper, JsonNode item) {
        ObjectNode result = mapper.createObjectNode();
        result.put("id", item.get("id").asText());
        result.set("definite", decodeOne(mapper, item.get("definiteCborHex").asText()));
        result.set("cardanoBinary", decodeOne(mapper, item.get("cardanoBinaryCborHex").asText()));
        return result;
    }

    /**
     * One answer per byte string, in the same flat shape the construct path
     * emits: an observed script carries the single framing whatever submitted
     * it chose, so there is no second encoding to ask about.
     */
    private static ObjectNode onchain(ObjectMapper mapper, JsonNode item) {
        ObjectNode result = decodeOne(mapper, item.get("cborHex").asText());
        ObjectNode withId = mapper.createObjectNode();
        withId.put("id", item.get("id").asText());
        withId.setAll(result);
        return withId;
    }

    private static ObjectNode decodeOne(ObjectMapper mapper, String cborHex) {
        ObjectNode result = mapper.createObjectNode();
        try {
            byte[] bytes = HexUtil.decodeHexString(cborHex);
            DataItem decoded = CborSerializationUtil.deserialize(bytes);
            NativeScript script = NativeScript.deserialize((Array) decoded);
            result.put("status", "ok");
            result.put("hash", HexUtil.encodeHexString(script.getScriptHash()));
        } catch (Throwable t) {
            result.put("status", "error");
            result.put("error", messageOf(t));
        }
        return result;
    }

    private static String messageOf(Throwable t) {
        String message = t.getMessage();
        return message != null ? message : t.toString();
    }
}
