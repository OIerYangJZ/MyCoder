/**
 * What undo cannot reach, derived from the session (ADR-0026 §4, plan §12).
 *
 * This module is the reason alpha.10 is not just a reversal. A dishonest undo
 * says "undone" and means "I reversed the four edits I know about"; in a session
 * with an MCP filesystem server attached, or one where a shell command ran a
 * code generator, the user's resulting belief is false and the product created
 * it.
 *
 * Everything here is **counted from what actually happened**, never from a
 * constant. That distinction is the whole point: a hardcoded sentence saying
 * "note that MCP writes are not covered" is true in every session and therefore
 * informative in none, and it would keep saying so after the last MCP server was
 * removed from the config. A count of zero derived from state is evidence; a
 * missing statement is silence.
 *
 * The precedent is ADR-0023 §6, which could have let an MCP tool declare its own
 * effects and be convenient, and said `unenforced` instead.
 */

import { isForeignToolName, parseToolName } from '../mcp/naming.ts';
import type { EditJournal } from './atomic-write.ts';

export interface UncoveredStatement {
  /** One line per uncovered class, already phrased for a human and the model. */
  lines: string[];
  /** True when nothing in this session escaped the journal. */
  empty: boolean;
}

/**
 * Counts the things an undo will not reverse.
 *
 * Fed from the same callbacks that already fire — there is no second detection
 * mechanism here, and deliberately so: a tracker that could disagree with the
 * event log would eventually disagree with it.
 */
export class UncoveredTracker {
  /** Foreign tool calls, by server name. */
  private readonly foreignCalls = new Map<string, number>();
  /** Shell commands that changed source files without an Edit. */
  private shellMutations = 0;
  private shellMutatedFiles = 0;

  /** Called for every tool result. Ignores everything that is not foreign. */
  recordToolCall(name: string): void {
    if (!isForeignToolName(name)) return;
    const parsed = parseToolName(name);
    const server = parsed?.server ?? 'unknown';
    this.foreignCalls.set(server, (this.foreignCalls.get(server) ?? 0) + 1);
  }

  /** Called when `MutationDetector` finds a shell command changed source files. */
  recordShellMutation(fileCount: number): void {
    this.shellMutations += 1;
    this.shellMutatedFiles += fileCount;
  }

  get foreignCallCount(): number {
    let total = 0;
    for (const n of this.foreignCalls.values()) total += n;
    return total;
  }

  get shellMutationCount(): number {
    return this.shellMutations;
  }

  /**
   * The enumeration, as it appears in the product.
   *
   * `journal` supplies the two classes that are properties of the record rather
   * than of what the session did: where the journal's knowledge begins, and how
   * many entries have already been reversed so a count is not double-stated.
   */
  describe(journal: EditJournal): UncoveredStatement {
    const lines: string[] = [];

    if (this.foreignCalls.size > 0) {
      const servers = [...this.foreignCalls.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([server, n]) => `${n} to "${server}"`)
        .join(', ');
      lines.push(
        `${this.foreignCallCount} call(s) to MCP server(s) are not covered (${servers}). ` +
          'The kernel cannot see what a tool it did not write changed: an mcp.invoke carries no ' +
          'path, so those writes are in no journal and no diff (ADR-0023).',
      );
    }

    if (this.shellMutations > 0) {
      lines.push(
        `${this.shellMutations} shell command(s) changed ${this.shellMutatedFiles} source file(s) ` +
          'without an Edit. Those changes were detected but not journalled, so there is no prior ' +
          'content to restore.',
      );
    }

    const boundary = journal.boundary;
    if (boundary !== undefined) {
      lines.push(
        `This journal was rebuilt from the event log and begins at ${new Date(boundary).toISOString()}. ` +
          'Anything the workspace saw before that point is not in it.',
      );
    }

    const empty = lines.length === 0;
    if (empty) {
      lines.push(
        'Nothing else in this session touched the workspace: no MCP server was called, no shell ' +
          'command changed a source file, and this journal covers the whole session.',
      );
    }

    // Not an uncovered *class* — it is the bookkeeping note §12 asks for, so a
    // reader does not read the inventory as a count of outstanding damage. It
    // is appended rather than allowed to suppress the sentence above, because
    // "some edits were already reversed" answers a different question from
    // "what could undo not reach", and letting the first stand in for the second
    // is how the honest statement quietly disappears from a busy session.
    if (journal.undoneCount > 0) {
      lines.push(
        `Separately: ${journal.undoneCount} edit(s) were already reversed earlier in this session, ` +
          'so they are not counted again above.',
      );
    }

    return { lines, empty };
  }

  /**
   * The same statement, rendered as the block that ends every undo result.
   *
   * One renderer, used by the tool result, the control command and `/status`, so
   * the three cannot drift into saying different things about the same session.
   */
  render(journal: EditJournal): string {
    const statement = this.describe(journal);
    return ['Not covered by undo:', ...statement.lines.map((l) => `  - ${l}`)].join('\n');
  }
}
