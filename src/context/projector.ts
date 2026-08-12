/**
 * Context Projector (spec §8.1).
 *
 * Turns the four planes into the `ContextSnapshot` a step is frozen against.
 *
 * The system prompt is assembled here and nowhere else. It states the security
 * posture in plain terms — that paths are enforced, that secrets are unreachable
 * by reference, that reference trees are read-only — because a model that
 * understands the boundary wastes fewer steps discovering it. It is *not* a
 * security control: everything it says is separately enforced, and the prompt
 * being ignored changes nothing (spec §2.1).
 */

import { estimateTokens } from '../util/text.ts';
import type { ModelMessage } from '../model/ir.ts';
import type { EditJournal } from '../edit/atomic-write.ts';
import type { ContextEngine, ContextSnapshot, GoalState } from './context-engine.ts';
import type { RepositoryFacts } from './repository-plane.ts';

export interface ProjectorOptions {
  /** Honest description of the isolation in force. */
  sandboxDescription: string;
  networkEnforcement: 'enforced' | 'best-effort';
  permissionProfile: string;
  backendDescription: string;
  editJournal?: EditJournal;
  /** Extra instructions from a skill or an agent definition. */
  extraInstructions?: readonly string[];
}

export class ContextProjector {
  private readonly options: ProjectorOptions;

  constructor(options: ProjectorOptions) {
    this.options = options;
  }

  project(engine: ContextEngine, facts: RepositoryFacts | undefined): ContextSnapshot {
    const system = this.buildSystem(engine, facts);
    const messages = engine.history();

    const snapshot: ContextSnapshot = {
      system,
      messages,
      estimatedTokens: engine.estimatedTokens(system),
      openToolCalls: engine.openToolCalls(),
      compactionBoundary: engine.compactionBoundary,
    };
    if (engine.goal) snapshot.goal = engine.goal;
    return snapshot;
  }

  private buildSystem(engine: ContextEngine, facts: RepositoryFacts | undefined): string {
    const sections: string[] = [];

    sections.push(
      [
        'You are a coding agent operating inside a kernel that enforces security boundaries independently of anything said here.',
        '',
        'How this environment works:',
        '- Explore before you edit. Use Grep and Glob to locate code, then Read the specific regions you intend to change.',
        '- Every Edit must cite the receiptId from a Read of that file. Editing content you have not read is rejected, not merely discouraged.',
        '- oldString must match the file exactly and uniquely. If it is rejected as non-unique, add surrounding context rather than guessing.',
        "- After changing code, run the project's tests or type checks with Shell and read the failures. Do not report success you have not observed.",
        '- Shell takes an argv array, not a shell line. Use ["bash","-lc","..."] when you genuinely need shell syntax.',
      ].join('\n'),
    );

    sections.push(
      [
        'Boundaries enforced by the kernel:',
        `- Permission profile: ${this.options.permissionProfile}. Some actions will require the user's approval; that is expected, not an error.`,
        `- Execution backend: ${this.options.backendDescription}.`,
        `- Isolation: ${this.options.sandboxDescription}`,
        `- Network from Shell is off unless you declare it, and is ${this.options.networkEnforcement} on this backend.`,
        '- Secret files (.env, private keys, credential directories) cannot be read by any tool, by any route. Do not spend steps trying; if a command needs a credential, pass secrets: [{ref, env}] and the value will be injected without you seeing it.',
        '- Reference repositories are read-only. Read them to understand a design; never write to them.',
        '- If a tool returns a denial, treat it as final and find another approach. Repeating a denied call wastes the turn budget.',
      ].join('\n'),
    );

    if (facts) {
      const repo: string[] = ['Workspace:', `- root: ${facts.workspaceRoot}`];
      if (facts.git.isRepository) {
        repo.push(
          `- git: branch ${facts.git.branch ?? 'unknown'} at ${facts.git.head ?? 'unknown'}` +
            (facts.git.dirty ? ' (uncommitted changes present)' : ' (clean)'),
        );
      } else {
        repo.push('- git: not a repository');
      }
      repo.push(`- ${facts.fileCount} files tracked in the sketch below`);
      if (facts.treeSketch) repo.push('', facts.treeSketch);
      sections.push(repo.join('\n'));

      for (const instruction of facts.instructions) {
        sections.push(`Project instructions from ${instruction.path}:\n\n${instruction.content}`);
      }
    }

    const goal = engine.goal;
    if (goal && goal.status !== 'cleared') {
      sections.push(renderGoal(goal));
    }

    const dirty = this.options.editJournal;
    if (dirty && dirty.size > 0) {
      sections.push(dirty.summary());
    }

    const receipts = engine.freshness.list().slice(0, 12);
    if (receipts.length > 0) {
      sections.push(
        'Files you have read this session (an Edit needs the receiptId from the most recent read):\n' +
          receipts
            .map(
              (r) =>
                `  ${r.path} — ${r.receiptId} (${
                  r.coverage.kind === 'full' ? 'whole file' : `lines ${r.coverage.start}-${r.coverage.end}`
                })`,
            )
            .join('\n'),
      );
    }

    const facts2 = engine.listFacts();
    if (facts2.length > 0) {
      sections.push('Current state:\n' + facts2.map((f) => `- ${f.text}`).join('\n'));
    }

    for (const extra of this.options.extraInstructions ?? []) {
      sections.push(extra);
    }

    return sections.join('\n\n---\n\n');
  }
}

export function renderGoal(goal: GoalState): string {
  const lines = [`Goal (${goal.status}): ${goal.objective}`];
  if (goal.criteria.length > 0) {
    lines.push('Done when:');
    for (const c of goal.criteria) lines.push(`  - ${c}`);
  }
  return lines.join('\n');
}

/** Estimated tokens for a projected message list, used by compaction. */
export function projectionTokens(system: string, messages: readonly ModelMessage[]): number {
  let total = estimateTokens(system);
  for (const message of messages) {
    for (const part of message.parts) {
      switch (part.type) {
        case 'text':
          total += estimateTokens(part.text);
          break;
        case 'tool_result':
          total += estimateTokens(part.content);
          break;
        case 'tool_call':
          total += estimateTokens(JSON.stringify(part.arguments ?? {}));
          break;
        case 'reasoning':
          total += estimateTokens(part.text ?? part.opaque ?? '');
          break;
        case 'media':
          total += 800;
          break;
      }
    }
    total += 4;
  }
  return total;
}
