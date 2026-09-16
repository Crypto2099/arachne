import { readFile } from 'node:fs/promises';
import type { EngineDefinition, ToolDefinition, ToolsRegistry } from './types.js';

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
  if (!Array.isArray(registry.engines)) {
    throw new RegistryError(`${path} is missing an "engines" array`);
  }
  const engineIds = new Set(registry.engines.map((e) => e.id));

  for (const tool of registry.tools) {
    if (!tool.id || !tool.adapter || !tool.discovery || !Array.isArray(tool.channels)) {
      throw new RegistryError(
        `tool entry ${JSON.stringify(tool)} is missing one of id, adapter, discovery, channels`,
      );
    }
    if (!tool.engine || !tool.engine.id || !tool.engine.relation) {
      throw new RegistryError(
        `tool "${tool.id}" is missing an engine link. Every tool declares which encoder produces its bytes, even when the answer is its own.`,
      );
    }
    if (!engineIds.has(tool.engine.id)) {
      throw new RegistryError(
        `tool "${tool.id}" names engine "${tool.engine.id}", which is not in the registry's engines. Known: ${[...engineIds].join(', ')}`,
      );
    }
  }
  return registry;
}

export function getEngine(registry: ToolsRegistry, id: string): EngineDefinition {
  const engine = registry.engines.find((e) => e.id === id);
  if (!engine) {
    throw new RegistryError(
      `no engine named "${id}". Known: ${registry.engines.map((e) => e.id).join(', ')}`,
    );
  }
  return engine;
}

/**
 * Tools grouped by the engine that produces their bytes.
 *
 * This is the grouping that keeps a compatibility table honest. Several tools
 * behind one engine agreeing is ONE observation about that encoder, however
 * many package names it wears. Reading the table the other way, down a single
 * engine's list, gives the blast radius of a finding: every tool there carries
 * the behavior, and each receives a fix on its own schedule or not at all.
 */
export function toolsByEngine(registry: ToolsRegistry): Map<string, ToolDefinition[]> {
  const grouped = new Map<string, ToolDefinition[]>();
  for (const engine of registry.engines) grouped.set(engine.id, []);
  for (const tool of registry.tools) {
    grouped.get(tool.engine.id)?.push(tool);
  }
  return grouped;
}

/**
 * Whether two tools' agreement is independent evidence about an encoding.
 *
 * Two tools on the same engine agreeing says nothing beyond that the engine is
 * deterministic. Only tools on different engines, or one that reimplements a
 * rule rather than inheriting it, can corroborate each other.
 */
export function isIndependentEvidence(a: ToolDefinition, b: ToolDefinition): boolean {
  if (a.engine.id !== b.engine.id) return true;
  return a.engine.relation === 'reimplements' || b.engine.relation === 'reimplements';
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
