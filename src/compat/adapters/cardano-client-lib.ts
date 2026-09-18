import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  DecodeItem,
  DecodeOutcome,
  HashOutcome,
  InstallOutcome,
  ObservedItem,
  ScriptItem,
  ToolAdapter,
  ToolDefinition,
} from '../types.js';
import { isScriptHash, tidyToolMessage } from './hash-shape.js';

const DRIVER_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  'cardano-client-lib-driver.java',
);
const ASSEMBLY_PLUGIN_VERSION = '3.7.1';

/**
 * bloxbean's cardano-client-lib (github.com/bloxbean/cardano-client-lib), a
 * Java implementation with its own encoder: `engine: { id:
 * "cardano-client-lib", relation: "own" }`. Its `ScriptAtLeast`,
 * `ScriptAll`, `ScriptAny`, `RequireTimeAfter` and `RequireTimeBefore`
 * classes, and the CBOR array they build a native script's sub-script list
 * into (`co.nstant.in.cbor.model.Array`), are not shared with anything else
 * this registry tracks.
 *
 * Registered against both construction paths, the way gouroboros is, because
 * the library exposes a genuine decode-and-hash entry point
 * (`NativeScript.deserialize` on an already-decoded CBOR `Array`) distinct
 * from its build-from-JSON one (`NativeScript.deserializeJson`). Unlike
 * gouroboros, both paths here answer the same way: `NativeScript`'s
 * `getScriptHash()` always calls `serializeAsDataItem()`, which always builds
 * a fresh, non-chunked `Array`, so decoding either of a vector's two
 * encodings and hashing what came back reproduces the `definite` framing
 * either way rather than preserving whichever one was fed in. See
 * `cardano-client-lib-driver.java`'s own header for the class-by-class
 * account this rests on.
 *
 * `java` and `mvn` are assumed to already be on PATH the way `go` is for
 * gouroboros and `npm` is for the npm-backed adapters; this does not install
 * a JDK or a Maven distribution. It installs exactly
 * `com.bloxbean.cardano:cardano-client-lib:version` into an isolated local
 * repository under `scratchDir` (`-Dmaven.repo.local`, Maven's own system
 * property for relocating where it resolves and caches dependencies) and
 * lets Maven itself resolve whatever transitive dependency graph that
 * version's own POM declares, the same way "go mod tidy" resolves
 * gouroboros's.
 */
export const CARDANO_CLIENT_LIB_ADAPTER: ToolAdapter = {
  async install(
    tool: ToolDefinition,
    version: string,
    scratchDir: string,
  ): Promise<InstallOutcome> {
    for (const bin of ['java', 'mvn']) {
      try {
        execFileSync(bin, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
      } catch (error) {
        const e = error as { code?: string; message?: string };
        return {
          status: 'failed',
          error:
            e.code === 'ENOENT'
              ? `${bin} is not installed (no "${bin}" binary on PATH)`
              : tidyToolMessage(e.message ?? `${bin} is not installed`),
        };
      }
    }

    const { groupId, artifactId } = requireMavenCoordinates(tool);
    const javaSrcDir = join(scratchDir, 'src', 'main', 'java');
    await mkdir(javaSrcDir, { recursive: true });
    await writeFile(join(scratchDir, 'pom.xml'), pomXml(groupId, artifactId, version), 'utf8');
    await copyFile(DRIVER_SOURCE, join(javaSrcDir, 'Driver.java'));

    const mavenRepoLocal = join(scratchDir, 'm2');
    try {
      execFileSync('mvn', ['-B', '-q', `-Dmaven.repo.local=${mavenRepoLocal}`, 'package'], {
        cwd: scratchDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 300_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch (error) {
      return { status: 'failed', error: extractMavenError(error, `mvn package for ${version}`) };
    }

    const jarPath = join(scratchDir, 'target', 'driver.jar');
    return {
      status: 'ok',
      session: {
        hashScripts: async (items: ScriptItem[]) => runConstruct(jarPath, scratchDir, items),
        decodeScripts: async (items: DecodeItem[]) => runDecode(jarPath, scratchDir, items),
        hashObservedScripts: async (items: ObservedItem[]) =>
          runOnchain(jarPath, scratchDir, items),
        // cardano-client-lib IS its own engine, and the registry always names
        // an exact release rather than a range, so this reads back the
        // version actually resolved into the isolated local repository
        // rather than echoing the one requested.
        resolveEngineVersion: async () =>
          resolveInstalledCardanoClientLibVersion(mavenRepoLocal, groupId, artifactId),
        dispose: () => {},
      },
    };
  },
};

function requireMavenCoordinates(tool: ToolDefinition): { groupId: string; artifactId: string } {
  if (tool.discovery.type !== 'maven-central') {
    throw new Error(
      `tool "${tool.id}" uses the cardano-client-lib adapter, which needs "discovery": { "type": "maven-central", "groupId", "artifactId" }`,
    );
  }
  return { groupId: tool.discovery.groupId, artifactId: tool.discovery.artifactId };
}

function pomXml(groupId: string, artifactId: string, version: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>io.arachne.compat</groupId>
  <artifactId>cardano-client-lib-driver</artifactId>
  <version>0.0.0</version>
  <packaging>jar</packaging>

  <properties>
    <maven.compiler.source>17</maven.compiler.source>
    <maven.compiler.target>17</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <dependencies>
    <dependency>
      <groupId>${groupId}</groupId>
      <artifactId>${artifactId}</artifactId>
      <version>${version}</version>
    </dependency>
  </dependencies>

  <build>
    <finalName>driver</finalName>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-assembly-plugin</artifactId>
        <version>${ASSEMBLY_PLUGIN_VERSION}</version>
        <configuration>
          <archive>
            <manifest>
              <mainClass>Driver</mainClass>
            </manifest>
          </archive>
          <descriptorRefs>
            <descriptorRef>jar-with-dependencies</descriptorRef>
          </descriptorRefs>
          <appendAssemblyId>false</appendAssemblyId>
        </configuration>
        <executions>
          <execution>
            <phase>package</phase>
            <goals>
              <goal>single</goal>
            </goals>
          </execution>
        </executions>
      </plugin>
    </plugins>
  </build>
</project>
`;
}

interface JavaConstructResult {
  id: string;
  status: 'ok' | 'error';
  hash?: string;
  error?: string;
}

async function runConstruct(
  jarPath: string,
  scratchDir: string,
  items: ScriptItem[],
): Promise<Map<string, HashOutcome>> {
  const inputPath = join(scratchDir, 'construct-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const outcomes = new Map<string, HashOutcome>();
  let entries: JavaConstructResult[];
  try {
    const stdout = execFileSync('java', ['-jar', jarPath, 'construct', inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    entries = JSON.parse(stdout) as JavaConstructResult[];
  } catch (error) {
    const text = driverErrorText(error);
    for (const item of items) outcomes.set(item.id, { status: 'refused', error: text });
    return outcomes;
  }

  for (const entry of entries) {
    outcomes.set(entry.id, toHashOutcome(entry.status, entry.hash, entry.error));
  }
  return outcomes;
}

interface JavaHashOutcome {
  status: 'ok' | 'error';
  hash?: string;
  error?: string;
}

interface JavaDecodeResult {
  id: string;
  definite: JavaHashOutcome;
  cardanoBinary: JavaHashOutcome;
}

async function runDecode(
  jarPath: string,
  scratchDir: string,
  items: DecodeItem[],
): Promise<Map<string, DecodeOutcome>> {
  const inputPath = join(scratchDir, 'decode-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const outcomes = new Map<string, DecodeOutcome>();
  let entries: JavaDecodeResult[];
  try {
    const stdout = execFileSync('java', ['-jar', jarPath, 'decode', inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    entries = JSON.parse(stdout) as JavaDecodeResult[];
  } catch (error) {
    const text = driverErrorText(error);
    const refused: HashOutcome = { status: 'refused', error: text };
    for (const item of items) outcomes.set(item.id, { definite: refused, cardanoBinary: refused });
    return outcomes;
  }

  for (const entry of entries) {
    outcomes.set(entry.id, {
      definite: toHashOutcome(entry.definite.status, entry.definite.hash, entry.definite.error),
      cardanoBinary: toHashOutcome(
        entry.cardanoBinary.status,
        entry.cardanoBinary.hash,
        entry.cardanoBinary.error,
      ),
    });
  }
  return outcomes;
}

/**
 * The observed-bytes path. The driver answers it in the same flat shape the
 * construct path uses, one outcome per item, because an observed script has
 * one framing and so one question.
 */
async function runOnchain(
  jarPath: string,
  scratchDir: string,
  items: ObservedItem[],
): Promise<Map<string, HashOutcome>> {
  const inputPath = join(scratchDir, 'onchain-input.json');
  await writeFile(inputPath, JSON.stringify(items), 'utf8');

  const outcomes = new Map<string, HashOutcome>();
  let entries: JavaConstructResult[];
  try {
    const stdout = execFileSync('java', ['-jar', jarPath, 'onchain', inputPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    entries = JSON.parse(stdout) as JavaConstructResult[];
  } catch (error) {
    const text = driverErrorText(error);
    for (const item of items) outcomes.set(item.id, { status: 'refused', error: text });
    return outcomes;
  }

  for (const entry of entries) {
    outcomes.set(entry.id, toHashOutcome(entry.status, entry.hash, entry.error));
  }
  return outcomes;
}

/** Maps the driver's two-way status onto `HashOutcome`; "error" is whatever cardano-client-lib itself, or the CBOR decode step ahead of it, raised on an attempt that was actually made. */
function toHashOutcome(
  status: 'ok' | 'error',
  hash: string | undefined,
  error: string | undefined,
): HashOutcome {
  if (status === 'error' || !hash || !isScriptHash(hash)) {
    return {
      status: 'refused',
      error: tidyToolMessage(
        error || (hash ? `returned ${JSON.stringify(hash)}, not a 28-byte hash` : 'no hash'),
      ),
    };
  }
  return { status: 'ok', hash };
}

function driverErrorText(error: unknown): string {
  const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const text = (
    e.stderr?.toString() ||
    e.stdout?.toString() ||
    e.message ||
    'unknown driver failure'
  )
    .toString()
    .trim();
  return tidyToolMessage(text);
}

function extractMavenError(error: unknown, context: string): string {
  const e = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const text = (e.stderr?.toString() || e.stdout?.toString() || e.message || 'unknown mvn failure')
    .toString()
    .trim();
  return `${context}: ${text}`.slice(0, 500);
}

/**
 * The cardano-client-lib version actually resolved into the isolated local
 * repository this install used, read from the directory Maven laid the jar
 * down under rather than echoed back from the version requested.
 */
async function resolveInstalledCardanoClientLibVersion(
  mavenRepoLocal: string,
  groupId: string,
  artifactId: string,
): Promise<{ version: string | null; note?: string }> {
  const artifactDir = join(mavenRepoLocal, ...groupId.split('.'), artifactId);
  try {
    const entries = await readdir(artifactDir, { withFileTypes: true });
    const versions = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    if (versions.length !== 1) {
      return {
        version: null,
        note: `expected exactly one resolved version under ${artifactDir}, found ${versions.length}`,
      };
    }
    return { version: versions[0]! };
  } catch (error) {
    return {
      version: null,
      note: `could not read ${artifactDir}: ${(error as Error).message}`,
    };
  }
}
