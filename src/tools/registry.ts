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
import { MCP_TOOL_PREFIX } from '../mcp/naming.ts';
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

  /**
   * Replace a registration. Used by tests and by profile-narrowed catalogues.
   *
   * `register` already throws on a duplicate, which is most of ADR-0024 §1's
   * shadow property. This is the other method — the one that overwrites — and it
   * is therefore the one that could quietly be the way a builtin gets replaced by
   * something a server supplied. It refuses the reserved namespace outright: a
   * foreign tool arrives through `register`, so nothing legitimate needs to
   * overwrite one, and a caller that wants to remove one has `unregister`.
   */
  override<T>(definition: ToolDefinition<T>): void {
    if (definition.name.startsWith(MCP_TOOL_PREFIX)) {
      throw new Error(
        `refusing to override "${definition.name}": the "${MCP_TOOL_PREFIX}" namespace belongs to ` +
          'MCP servers and is registered once, at session start. Overwriting an entry there is ' +
          'how a foreign tool would come to answer to a name something else was told about.',
      );
    }
    this.tools.set(definition.name, definition as ToolDefinition<never>);
  }

  /**
   * Remove a registration. Narrowing only — there is no way to add capability
   * through this method, and `view({ allowed })` is still the supported way for a
   * skill or agent to see fewer tools.
   *
   * It exists for the tool-utility experiment, whose control arm has to be a
   * model that **cannot see** a tool rather than one choosing not to use it —
   * the same shape as the delegation experiment's "no agents" control, where the
   * kernel genuinely does not register `Delegate`. Measuring "did the tool help"
   * against an arm that still had the tool would answer nothing.
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
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
