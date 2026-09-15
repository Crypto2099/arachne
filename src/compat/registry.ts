import { readFile } from 'node:fs/promises';
import type { ToolDefinition, ToolsRegistry } from './types.js';

export const DEFAULT_REGISTRY_PATH = 'compat/tools.json';

export class RegistryError extends Error {}

/** Load and lightly validate `compat/tools.json`. Adding a tool is editing this file. */
export async function loadToolRegistry(path = DEFAULT_REGISTRY_PATH): Promise<ToolsRegistry> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { tools?: unknown }).tools)
  ) {
    throw new RegistryError(`${path} does not have the shape { formatVersion, tools: [...] }`);
  }
  const registry = parsed as ToolsRegistry;
  for (const tool of registry.tools) {
    if (!tool.id || !tool.adapter || !tool.discovery || !Array.isArray(tool.channels)) {
      throw new RegistryError(
        `tool entry ${JSON.stringify(tool)} is missing one of id, adapter, discovery, channels`,
      );
    }
  }
  return registry;
}

export function getTool(registry: ToolsRegistry, id: string): ToolDefinition {
  const tool = registry.tools.find((t) => t.id === id);
  if (!tool) {
    throw new RegistryError(
      `no tool named "${id}" in the registry. Known: ${registry.tools.map((t) => t.id).join(', ')}`,
    );
  }
  return tool;
}
