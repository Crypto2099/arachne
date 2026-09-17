import type { ToolAdapter } from '../types.js';
import { CARDANO_ADDRESS_ADAPTER } from './cardano-address.js';
import { CARDANO_CLI_ADAPTER } from './cardano-cli.js';
import { CARDANO_CLIENT_LIB_ADAPTER } from './cardano-client-lib.js';
import { NPM_CML_ADAPTER } from './cml.js';
import { NPM_CSL_ADAPTER } from './csl.js';
import { GOUROBOROS_ADAPTER } from './gouroboros.js';
import { NPM_NATIVE_SCRIPT_CLASSES_ADAPTER } from './native-script-classes.js';
import { NPM_NATIVE_SCRIPT_JSON_ADAPTER } from './npm-native-script-json.js';
import { PALLAS_ADAPTER } from './pallas.js';
import { PYCARDANO_ADAPTER } from './pycardano.js';

/**
 * Every adapter kind a `compat/tools.json` entry can name. A tool whose API
 * matches one of these already is a registry entry; a tool with a genuinely
 * different API needs a new adapter added here.
 */
const ADAPTERS: Record<string, ToolAdapter> = {
  'cardano-cli-binary': CARDANO_CLI_ADAPTER,
  'cardano-address-binary': CARDANO_ADDRESS_ADAPTER,
  'npm-csl': NPM_CSL_ADAPTER,
  'npm-cml': NPM_CML_ADAPTER,
  'npm-native-script-json': NPM_NATIVE_SCRIPT_JSON_ADAPTER,
  'npm-native-script-classes': NPM_NATIVE_SCRIPT_CLASSES_ADAPTER,
  gouroboros: GOUROBOROS_ADAPTER,
  'cardano-client-lib': CARDANO_CLIENT_LIB_ADAPTER,
  pallas: PALLAS_ADAPTER,
  pycardano: PYCARDANO_ADAPTER,
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
