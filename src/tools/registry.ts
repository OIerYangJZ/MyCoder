/**
 * Tool registry and catalogue.
 *
 * The catalogue the model sees is frozen per step (spec §5.3): once a request
 * is in flight, the tool schemas for that step cannot change. `ToolCatalogView`
 * carries a hash so the step engine can assert that.
 *
 * Disclosure (spec §9.3) decides what is sent every step. The six core tools are
 * `eager`; anything discovered later — MCP servers, skills, team tools — is
 * `deferred`, so a large schema set does not get re-serialised into every
 * request.
 */

import { sha256Hex } from '../util/ids.ts';
import type { ToolSchema } from '../model/ir.ts';
import type { ToolDefinition, ToolDisclosure } from './contract.ts';

export interface ToolCatalogView {
  tools: readonly ToolSchema[];
  /** Stable identity of this exact catalogue, used to detect mid-step drift. */
  hash: string;
  /** Names present in the registry but not disclosed this step. */
  deferred: readonly string[];
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<never>>();

  register<T>(definition: ToolDefinition<T>): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`tool "${definition.name}" is already registered`);
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(definition.name)) {
      throw new Error(`tool name "${definition.name}" is not a legal identifier`);
    }
    this.tools.set(definition.name, definition as ToolDefinition<never>);
  }

  /** Replace a registration. Used by tests and by profile-narrowed catalogues. */
  override<T>(definition: ToolDefinition<T>): void {
    this.tools.set(definition.name, definition as ToolDefinition<never>);
  }

  get(name: string): ToolDefinition<never> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()].sort();
  }

  all(): ToolDefinition<never>[] {
    return this.names().map((n) => this.tools.get(n)!);
  }

  /**
   * Build the view for one step.
   *
   * `allowed` is the tool subset the current agent/skill profile permits. A
   * skill that lists fewer tools narrows the catalogue; it can never add one
   * that is not registered, which is half of invariant 14.
   */
  view(opts: { allowed?: readonly string[]; disclosure?: readonly ToolDisclosure[] } = {}): ToolCatalogView {
    const disclosure = opts.disclosure ?? (['eager'] as const);
    const allowed = opts.allowed ? new Set(opts.allowed) : undefined;

    const tools: ToolSchema[] = [];
    const deferred: string[] = [];

    for (const name of this.names()) {
      const def = this.tools.get(name)!;
      if (allowed && !allowed.has(name)) continue;
      if (!disclosure.includes(def.disclosure)) {
        deferred.push(name);
        continue;
      }
      tools.push({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
      });
    }

    return {
      tools,
      hash: sha256Hex(JSON.stringify(tools)).slice(0, 16),
      deferred,
    };
  }

  /** Tool names that have no side effects, so they may run concurrently. */
  readOnlyNames(): string[] {
    return this.all()
      .filter((t) => t.readOnly)
      .map((t) => t.name);
  }
}
