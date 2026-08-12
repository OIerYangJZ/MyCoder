import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { compileGlob, globMatch, GlobSet } from '../../src/util/glob.ts';
import {
  canonicalize,
  isWithin,
  lexicalCanonical,
  displayPath,
  type CanonicalPath,
} from '../../src/util/paths.ts';
import {
  detectEol,
  applyEol,
  sliceLines,
  truncateForModel,
  normalizeErrorMessage,
} from '../../src/util/text.ts';
import { parseToml } from '../../src/util/toml.ts';
import { validate } from '../../src/util/jsonschema.ts';
import { parseFrontmatter } from '../../src/util/frontmatter.ts';
import { decodeSse, stringStream } from '../../src/util/sse.ts';
import { unifiedDiff } from '../../src/edit/diff.ts';
import { parseShellLine } from '../../src/cli/shell-parse.ts';

describe('glob', () => {
  test('* does not cross a separator, ** does', () => {
    assert.equal(globMatch('src/*.ts', 'src/a.ts'), true);
    assert.equal(globMatch('src/*.ts', 'src/nested/a.ts'), false);
    assert.equal(globMatch('src/**/*.ts', 'src/nested/deep/a.ts'), true);
  });

  test('**/ matches zero directories', () => {
    assert.equal(globMatch('**/.env', '/repo/.env'), true);
    assert.equal(globMatch('**/.env', '/repo/nested/.env'), true);
    assert.equal(globMatch('**/*.pem', '/repo/a/b/key.pem'), true);
  });

  test('brace alternation and character classes', () => {
    assert.equal(globMatch('{rg,grep}', 'rg'), true);
    assert.equal(globMatch('{rg,grep}', 'awk'), false);
    assert.equal(globMatch('file[0-9].txt', 'file3.txt'), true);
    assert.equal(globMatch('file[!0-9].txt', 'file3.txt'), false);
  });

  test('deny rules match case-insensitively by default', () => {
    // APFS is case-insensitive: `.ENV` opens `.env`, so a deny rule must catch both.
    assert.equal(globMatch('**/.env', '/repo/.ENV'), true);
    assert.equal(globMatch('**/.env', '/repo/.ENV', { caseInsensitive: false }), false);
  });

  test('GlobSet reports which pattern matched', () => {
    const set = new GlobSet(['**/*.key', '**/.env']);
    assert.equal(set.matches('/a/b/id.key'), true);
    assert.equal(set.firstMatch('/a/b/id.key'), '**/*.key');
    assert.equal(set.matches('/a/b/main.ts'), false);
  });

  test('a literal dot is not a wildcard', () => {
    assert.equal(compileGlob('a.b').test('axb'), false);
  });
});

describe('paths', () => {
  test('isWithin refuses a sibling with a shared prefix', () => {
    const root = '/repo' as CanonicalPath;
    assert.equal(isWithin(root, '/repo/src/a.ts' as CanonicalPath), true);
    assert.equal(isWithin(root, '/repo' as CanonicalPath), true);
    assert.equal(isWithin(root, '/repo-evil/a.ts' as CanonicalPath), false);
  });

  test('lexical canonicalisation collapses traversal', () => {
    assert.equal(lexicalCanonical('a/../b/c', '/root'), '/root/b/c');
    assert.equal(lexicalCanonical('../outside', '/root/sub'), '/root/outside');
  });

  test('canonicalize resolves a symlink to its target', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'paths-test-'));
    try {
      await writeFile(path.join(base, 'real.txt'), 'x', 'utf8');
      await symlink(path.join(base, 'real.txt'), path.join(base, 'link.txt'));

      const resolved = await canonicalize('link.txt', { cwd: base });
      assert.ok(resolved.path.endsWith('real.txt'), `expected real.txt, got ${resolved.path}`);
      assert.equal(resolved.existed, true);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('canonicalize resolves a symlinked parent for a file that does not exist', async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'paths-test-'));
    try {
      await mkdir(path.join(base, 'real-dir'));
      await symlink(path.join(base, 'real-dir'), path.join(base, 'link-dir'));

      const resolved = await canonicalize('link-dir/new-file.txt', { cwd: base });
      assert.ok(resolved.path.includes('real-dir'), `expected real-dir, got ${resolved.path}`);
      assert.equal(resolved.existed, false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('displayPath is workspace-relative inside, absolute outside', () => {
    const root = '/repo' as CanonicalPath;
    assert.equal(displayPath(root, '/repo/src/a.ts' as CanonicalPath), path.join('src', 'a.ts'));
    assert.equal(displayPath(root, '/etc/hosts' as CanonicalPath), '/etc/hosts');
  });
});

describe('text', () => {
  test('CRLF is detected and restored', () => {
    const crlf = 'a\r\nb\r\nc\r\n';
    const info = detectEol(crlf);
    assert.equal(info.style, 'crlf');
    assert.equal(applyEol('a\nb\nc\n', 'crlf'), crlf);
  });

  test('sliceLines returns a 1-based inclusive window', () => {
    const slice = sliceLines('l1\nl2\nl3\nl4\nl5', 2, 3);
    assert.equal(slice.text, 'l2\nl3\nl4');
    assert.equal(slice.startLine, 2);
    assert.equal(slice.endLine, 4);
    assert.equal(slice.totalLines, 5);
  });

  test('truncation keeps head and tail, not just the head', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const result = truncateForModel(lines, { maxBytes: 400, maxLines: 20 });
    assert.equal(result.truncated, true);
    assert.ok(result.text.includes('line 0'), 'head is kept');
    assert.ok(result.text.includes('line 499'), 'tail is kept — a stack trace lives there');
    assert.ok(result.text.includes('truncated'), 'the notice is explicit');
  });

  test('error normalisation collapses pids and hashes', () => {
    const a = normalizeErrorMessage('failed at 0xdeadbeef pid 1234 hash a1b2c3d4e5f6');
    const b = normalizeErrorMessage('failed at 0xcafebabe pid 9999 hash f6e5d4c3b2a1');
    assert.equal(a, b);
  });
});

describe('toml', () => {
  test('tables, arrays of tables and typed scalars', () => {
    const parsed = parseToml(`
[project]
name = "kernel"
reference_roots = ["../reference"]

[loop]
max_steps = 16
enabled = true

[[rule]]
action = "hard_deny"
pattern = "**/.env"

[[rule]]
action = "allow"
pattern = "src/**"
`);
    assert.equal((parsed.project as Record<string, unknown>).name, 'kernel');
    assert.equal((parsed.loop as Record<string, unknown>).max_steps, 16);
    assert.equal((parsed.loop as Record<string, unknown>).enabled, true);
    assert.equal((parsed.rule as unknown[]).length, 2);
  });

  test('comments inside strings are not stripped', () => {
    const parsed = parseToml('a = "value # not a comment" # real comment');
    assert.equal(parsed.a, 'value # not a comment');
  });

  test('prototype-polluting keys are refused', () => {
    assert.throws(() => parseToml('[__proto__]\nx = 1'), /unsafe key/);
  });
});

describe('json schema', () => {
  test('rejects an unknown property when additionalProperties is false', () => {
    const result = validate(
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: ['a'],
        additionalProperties: false,
      },
      { a: 'x', b: 1 },
    );
    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.path === '$.b'));
  });

  test('anyOf accepts either branch', () => {
    const schema = {
      anyOf: [
        { const: false } as const,
        { type: 'object', properties: {}, additionalProperties: true } as const,
      ],
    } as const;
    assert.equal(validate(schema, false).ok, true);
    assert.equal(validate(schema, { hosts: [] }).ok, true);
    assert.equal(validate(schema, 'nope').ok, false);
  });
});

describe('frontmatter', () => {
  test('scalars, inline arrays and block sequences', () => {
    const parsed = parseFrontmatter(`---
name: security-review
description: Review changes.
tools:
  - Read
  - Grep
permission_profile: review
max_steps: 10
---

# Instructions
body text`);
    assert.equal(parsed.attributes.name, 'security-review');
    assert.deepEqual(parsed.attributes.tools, ['Read', 'Grep']);
    assert.equal(parsed.attributes.max_steps, 10);
    assert.ok(parsed.body.includes('body text'));
  });

  test('an unterminated block is reported, not silently accepted', () => {
    const parsed = parseFrontmatter('---\nname: x\nno end');
    assert.ok(parsed.errors.length > 0);
  });
});

describe('sse', () => {
  test('records split across chunk boundaries are reassembled', async () => {
    const stream = stringStream(['event: a\ndata: {"x":', '1}\n\nevent: b\ndata: hi\n\n']);
    const out: Array<{ event?: string; data: string }> = [];
    for await (const message of decodeSse(stream)) out.push(message);

    assert.equal(out.length, 2);
    assert.deepEqual(out[0], { event: 'a', data: '{"x":1}' });
    assert.deepEqual(out[1], { event: 'b', data: 'hi' });
  });
});

describe('diff', () => {
  test('produces a unified diff with correct counts', () => {
    const result = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n');
    assert.equal(result.stats.linesAdded, 1);
    assert.equal(result.stats.linesRemoved, 1);
    assert.ok(result.text.includes('-b'));
    assert.ok(result.text.includes('+B'));
    assert.ok(result.text.includes('@@'));
  });

  test('identical inputs produce no diff', () => {
    assert.equal(unifiedDiff('same\n', 'same\n').text, '');
  });

  test('a very large change still produces a valid diff', () => {
    const before = Array.from({ length: 5000 }, (_, i) => `a${i}`).join('\n');
    const after = Array.from({ length: 5000 }, (_, i) => `b${i}`).join('\n');
    const result = unifiedDiff(before, after);
    assert.equal(result.coarse, true, 'falls back rather than spending seconds on an LCS');
    assert.ok(result.text.includes('@@'));
    assert.equal(result.stats.linesRemoved, 5000);
  });
});

describe('shell line parsing', () => {
  test('a simple command becomes argv', () => {
    const plan = parseShellLine('npm test --silent');
    assert.equal(plan.kind, 'simple');
    if (plan.kind === 'simple') assert.deepEqual(plan.argv, ['npm', 'test', '--silent']);
  });

  test('quotes are honoured and a quoted pipe is not an operator', () => {
    const plan = parseShellLine('grep "a|b" file.txt');
    assert.equal(plan.kind, 'simple');
    if (plan.kind === 'simple') assert.deepEqual(plan.argv, ['grep', 'a|b', 'file.txt']);
  });

  test('a real pipeline escalates to an explicit shell, visibly', () => {
    const plan = parseShellLine('cat a | wc -l');
    assert.equal(plan.kind, 'compound');
    if (plan.kind === 'compound') {
      assert.deepEqual(plan.argv, ['bash', '-lc', 'cat a | wc -l']);
      assert.ok(plan.operators.includes('pipe'));
    }
  });

  test('command substitution is detected', () => {
    const plan = parseShellLine('echo $(whoami)');
    assert.equal(plan.kind, 'compound');
  });

  test('an unterminated quote is an error, not a guess', () => {
    assert.equal(parseShellLine('echo "unterminated').kind, 'error');
  });
});
