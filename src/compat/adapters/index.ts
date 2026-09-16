import type { ToolAdapter } from '../types.js';
import { CARDANO_ADDRESS_ADAPTER } from './cardano-address.js';
import { CARDANO_CLI_ADAPTER } from './cardano-cli.js';
import { NPM_CSL_ADAPTER } from './csl.js';
import { NPM_NATIVE_SCRIPT_JSON_ADAPTER } from './npm-native-script-json.js';

/**
 * Every adapter kind a `compat/tools.json` entry can name. A tool whose API
 * matches one of these already is a registry entry; a tool with a genuinely
 * different API needs a new adapter added here.
 */
const ADAPTERS: Record<string, ToolAdapter> = {
  'cardano-cli-binary': CARDANO_CLI_ADAPTER,
  'cardano-address-binary': CARDANO_ADDRESS_ADAPTER,
  'npm-csl': NPM_CSL_ADAPTER,
  'npm-native-script-json': NPM_NATIVE_SCRIPT_JSON_ADAPTER,
};

export function getAdapter(kind: string): ToolAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) {
    throw new Error(
      `no adapter registered for kind "${kind}". Known: ${Object.keys(ADAPTERS).join(', ')}`,
    );
  }
  return adapter;
}
