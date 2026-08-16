#!/usr/bin/env node
/**
 * §9 audit: is the recorded diff actually reversible?
 *
 * alpha.10 §19 puts this second, before any undo code is written, because a
 * negative answer changes the shape of everything after it. The question is not
 * rhetorical — `RollbackMetadata` claims "reversing it restores the previous
 * content", and that claim has never been executed.
 *
 * This script generates the cases the plan names and reports, per case, whether
 * reverse-applying the recorded diff reproduces the original bytes.
 *
 * Usage:  node scripts/audit-diff-reversibility.ts
 */

import { unifiedDiff } from '../src/edit/diff.ts';
import { applyByteShape, contentFromDeletionDiff, reverseUnifiedDiff } from '../src/edit/reverse-diff.ts';
import { Redactor } from '../src/security/redactor.ts';
import { detectEol, toLf } from '../src/util/text.ts';

interface Case {
  name: string;
  old: string;
  new: string;
  /** True when the case is a whole-file removal (Delete). */
  deletion?: boolean;
  /** Simulate the event log's redactor running over the stored diff. */
  redact?: boolean;
}

const lines = (n: number, seed: string): string =>
  Array.from({ length: n }, (_, i) => `${seed} line ${i}`).join('\n') + '\n';

const CASES: Case[] = [
  {
    name: 'replace — a small edit in a small file',
    old: 'alpha\nbeta\ngamma\n',
    new: 'alpha\nBETA\ngamma\n',
  },
  {
    name: 'replace — an edit in a 5000-line file',
    old: lines(5000, 'x'),
    new: lines(5000, 'x').replace('x line 2500', 'x line 2500 EDITED'),
  },
  {
    name: 'create — from nothing',
    old: '',
    new: 'hello\nworld\n',
  },
  {
    name: 'overwrite — two small unrelated contents',
    old: 'one\ntwo\nthree\n',
    new: 'alpha\nbeta\n',
  },
  {
    name: 'overwrite — two 5000-line unrelated contents (past the LCS ceiling)',
    old: lines(5000, 'old'),
    new: lines(5000, 'new'),
  },
  {
    name: 'overwrite — 3000 unrelated lines, exactly at the coarse boundary',
    old: lines(3000, 'a'),
    new: lines(3000, 'b'),
  },
  {
    name: 'delete — whole file',
    old: 'one\ntwo\nthree\n',
    new: '',
    deletion: true,
  },
  {
    name: 'delete — a 20000-line file',
    old: lines(20_000, 'z'),
    new: '',
    deletion: true,
  },
  {
    name: 'replace — file with no trailing newline',
    old: 'alpha\nbeta',
    new: 'alpha\nBETA',
  },
  {
    name: 'replace — trailing newline added by the edit',
    old: 'alpha\nbeta',
    new: 'alpha\nbeta\n',
  },
  {
    name: 'replace — CRLF file',
    old: 'alpha\r\nbeta\r\ngamma\r\n',
    new: 'alpha\r\nBETA\r\ngamma\r\n',
  },
  {
    name: 'replace — MIXED line endings',
    old: 'alpha\r\nbeta\ngamma\r\n',
    new: 'alpha\r\nBETA\ngamma\r\n',
  },
  {
    // Deliberately credential-*shaped*, and deliberately not a credential: this
    // case exists to make the redactor's pattern scan fire, so a value that did
    // not look like a key would test nothing.
    name: 'replace — a line holding a credential-shaped value, diff redacted',
    old: 'const key = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\nrest\n',
    new: 'const key = process.env.KEY;\nrest\n',
    redact: true,
  },
  {
    name: 'replace — an ordinary line, diff redacted (control)',
    old: 'const port = 8080;\nrest\n',
    new: 'const port = 9090;\nrest\n',
    redact: true,
  },
];

interface Row {
  name: string;
  coarse: boolean;
  diffBytes: number;
  contentBytes: number;
  exact: boolean;
  detail: string;
}

function run(c: Case): Row {
  const oldEol = detectEol(c.old);
  const oldLf = toLf(c.old);
  const newLf = toLf(c.new);

  const diff = unifiedDiff(oldLf, newLf, { oldLabel: 'a/f', newLabel: 'b/f' });
  const redactor = new Redactor();
  const stored = c.redact === true ? redactor.redact(diff.text) : diff.text;

  const outcome = c.deletion === true ? contentFromDeletionDiff(stored) : reverseUnifiedDiff(newLf, stored);

  if (!outcome.ok) {
    return {
      name: c.name,
      coarse: diff.coarse,
      diffBytes: Buffer.byteLength(stored),
      contentBytes: Buffer.byteLength(c.old),
      exact: false,
      detail: `refused: ${outcome.reason}`,
    };
  }

  const restored = applyByteShape(outcome.text, {
    eol: oldEol.style,
    finalNewline: oldEol.finalNewline,
  });

  const exact = restored === c.old;
  return {
    name: c.name,
    coarse: diff.coarse,
    diffBytes: Buffer.byteLength(stored),
    contentBytes: Buffer.byteLength(c.old),
    exact,
    detail: exact
      ? 'byte-identical'
      : `DIFFERS: restored ${Buffer.byteLength(restored)}B vs original ${Buffer.byteLength(c.old)}B`,
  };
}

const rows = CASES.map(run);

const pad = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const width = Math.max(...rows.map((r) => r.name.length));

console.log('§9 audit — reversing the recorded diff\n');
console.log(
  `${pad('case', width)}  ${pad('coarse', 6)}  ${pad('diff/content', 14)}  ${pad('exact', 5)}  detail`,
);
console.log('-'.repeat(width + 60));
for (const r of rows) {
  const ratio = r.contentBytes === 0 ? '—' : `${r.diffBytes}/${r.contentBytes}`;
  console.log(
    `${pad(r.name, width)}  ${pad(r.coarse ? 'yes' : 'no', 6)}  ${pad(ratio, 14)}  ` +
      `${pad(r.exact ? 'yes' : 'NO', 5)}  ${r.detail}`,
  );
}

const failures = rows.filter((r) => !r.exact);
console.log(`\n${rows.length - failures.length}/${rows.length} reproduce the original bytes exactly.`);
if (failures.length > 0) {
  console.log('\nNot exactly reversible:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail}`);
}
