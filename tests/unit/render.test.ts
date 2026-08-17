/**
 * What a session looks like while it works (alpha.12, `src/cli/render.ts`).
 *
 * The renderer is pure on purpose — one map of in-flight calls and no other state —
 * so every case below is an assertion about a string rather than a screenshot.
 *
 * The two that matter most are the ones about *not* styling: escape codes written
 * into a pipe end up in somebody's log file, and box-drawing plus Braille end up as
 * mojibake in a CI log and in `cmd.exe`. `NO_COLOR` is honoured over `FORCE_COLOR`
 * because it is the convention people set after something got this wrong.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  banner,
  box,
  centre,
  inputRule,
  colourEnabled,
  diffBlock,
  formatBytes,
  glyphs,
  palette,
  SessionRenderer,
  Spinner,
  summariseArgs,
  toolCallLine,
  toolResultLine,
  visibleWidth,
} from '../../src/cli/render.ts';

const ESC = '';
const plain = palette(false);
const fancy = palette(true);

describe('when to style at all', () => {
  test('a terminal gets colour and a pipe does not', () => {
    assert.equal(colourEnabled({}, true), true);
    assert.equal(colourEnabled({}, false), false);
  });

  test('NO_COLOR wins over everything, including FORCE_COLOR', () => {
    assert.equal(colourEnabled({ NO_COLOR: '1', FORCE_COLOR: '1' }, true), false);
    assert.equal(colourEnabled({ TERM: 'dumb' }, true), false);
    // An empty NO_COLOR is not a request: the convention is "set, at all".
    assert.equal(colourEnabled({ NO_COLOR: '' }, true), true);
  });

  test('FORCE_COLOR turns it on where there is no terminal', () => {
    assert.equal(colourEnabled({ FORCE_COLOR: '1' }, false), true);
    assert.equal(colourEnabled({ FORCE_COLOR: '0' }, false), false);
  });

  test('a plain palette emits no escape codes at all', () => {
    const line = toolCallLine('Read', '{"path":"src/app.ts"}', plain, glyphs(false));
    assert.equal(line.includes(ESC), false, `escape codes leaked into a pipe: ${JSON.stringify(line)}`);
  });

  test('the plain glyph set is ASCII, so a CI log stays readable', () => {
    const g = glyphs(false);
    for (const glyph of [g.call, g.result, g.prompt, g.topLeft, g.horizontal, ...g.spinner]) {
      assert.match(glyph, /^[\x20-\x7e]+$/, `${JSON.stringify(glyph)} is not ASCII`);
    }
  });
});

describe('a tool call, as one line', () => {
  test('the interesting argument is shown, not the JSON', () => {
    assert.equal(summariseArgs('Read', '{"path":"src/app.ts","offset":0}'), 'src/app.ts');
    assert.equal(summariseArgs('Shell', '{"argv":["npm","test"]}'), 'npm test');
    assert.equal(summariseArgs('Grep', '{"pattern":"answer","path":"src"}'), 'answer in src');
    assert.equal(summariseArgs('Move', '{"from":"a.ts","to":"b.ts"}'), 'a.ts → b.ts');
  });

  test('an unknown tool still shows something true', () => {
    // The fallback is the raw summary rather than nothing: a tool this file has
    // never heard of is exactly when the reader needs whatever there is.
    assert.equal(summariseArgs('Newtool', '{"unexpected":"shape"}'), '{"unexpected":"shape"}');
    assert.equal(summariseArgs('Newtool', 'not json at all'), 'not json at all');
  });

  test('a long argument is truncated rather than wrapped', () => {
    const long = `{"path":"${'x'.repeat(200)}"}`;
    const summary = summariseArgs('Read', long, 20);
    assert.equal(summary.length, 20);
    assert.match(summary, /…$/);
  });

  test('the call line names the tool and the result line sits under it', () => {
    const g = glyphs(true);
    assert.equal(toolCallLine('Read', '{"path":"a.ts"}', plain, g), '⏺ Read(a.ts)');
    assert.equal(toolResultLine({ contentBytes: 2048 }, plain, g), '  ⎿ 2.0 kB');
  });

  test('a failure shows the error code, not a byte count', () => {
    const g = glyphs(true);
    assert.equal(toolResultLine({ isError: true, errorCode: 'STALE_FILE' }, plain, g), '  ⎿ STALE_FILE');
    assert.equal(toolResultLine({ isError: true }, plain, g), '  ⎿ failed');
  });

  test('bytes are human, and the boundaries are the obvious ones', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.0 kB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  });
});

describe('boxes', () => {
  test('every line is padded to the same width, ignoring escape codes', () => {
    const rendered = box(['short', fancy.bold('bold and longer')], fancy, glyphs(true));
    const widths = new Set(rendered.split('\n').map(visibleWidth));
    assert.equal(widths.size, 1, `ragged box: ${[...widths].join(', ')}`);
  });

  test('the frame, the title and the prompt all use one accent colour', () => {
    // Blue, and only blue: a frame in one colour and a title in another reads as
    // two unrelated things. 34 is blue, `1;34` bold blue, `2;34` dim blue.
    const framed = banner(
      {
        version: '0.1.0',
        model: 'm',
        profile: 'p',
        workspace: '/w',
        isolation: 'i',
        caveat: 'c',
      },
      fancy,
      glyphs(true),
      80,
    );
    assert.match(framed, new RegExp(`${ESC}\\[34m╭`), 'the frame is not blue');
    assert.match(framed, new RegExp(`${ESC}\\[1;34m◆`), 'the title mark is not bold blue');
    assert.match(
      inputRule(fancy, glyphs(true), 40),
      new RegExp(`${ESC}\\[2;34m─+`),
      'the input rule is not blue',
    );
  });

  test('the input frame closes top and bottom and never at the sides', () => {
    // Asked for, and also the only shape a readline prompt can keep: a right-hand
    // border would need the input line rewritten on every keystroke, which is the
    // TUI spec §1.3 rules out.
    const rule = inputRule(plain, glyphs(true), 30);
    assert.match(rule, /^─+$/, `the rule is not a bare horizontal: ${JSON.stringify(rule)}`);
    assert.equal(rule.includes('│'), false, 'the input frame grew a side');
  });

  test('the banner is centred in the terminal, and follows a resize', () => {
    const info = {
      version: '0.1.0',
      model: 'm',
      profile: 'p',
      workspace: '/w',
      isolation: 'i',
      caveat: 'c',
    };
    const narrow = banner(info, plain, glyphs(true), 60).split('\n')[0] ?? '';
    const wide = banner(info, plain, glyphs(true), 120).split('\n')[0] ?? '';
    const indent = (line: string): number => line.length - line.trimStart().length;

    assert.ok(indent(wide) > indent(narrow), 'a wider terminal must push the box further right');
    assert.equal(indent(narrow) >= 0, true);
  });

  test('the context window is shown when it is known, and omitted when it is not', () => {
    const base = {
      version: '0.1.0',
      model: 'm',
      profile: 'p',
      workspace: '/w',
      isolation: 'i',
      caveat: 'c',
    };
    assert.match(
      banner({ ...base, contextWindow: 65536 }, plain, glyphs(true), 80),
      /context\s+65,536 tokens/,
    );
    assert.equal(/context/.test(banner(base, plain, glyphs(true), 80)), false);
  });

  test('the banner names what to check before typing, isolation included', () => {
    // The isolation line is load-bearing, not decoration: invariant 5 forbids a
    // user-facing surface that presents policy as strong isolation, and the first
    // draft of this banner dropped it in favour of a tidy `backend: local`.
    const text = banner(
      {
        version: '0.1.0',
        model: 'deepseek',
        profile: 'workspace-dev',
        workspace: '/tmp/project',
        isolation: 'policy-enforced — network from Shell is best-effort',
        caveat: 'Permission is not a sandbox.',
      },
      plain,
      glyphs(true),
    );
    for (const needed of [
      'deepseek',
      'workspace-dev',
      '/tmp/project',
      'policy-enforced',
      'network from Shell is best-effort',
      'Permission is not a sandbox.',
    ]) {
      assert.ok(text.includes(needed), `the banner does not mention ${needed}:\n${text}`);
    }
  });

  test('a banner that lost its isolation line would be caught here', () => {
    // The regression this pair exists for: an accurate claim becoming a missing one.
    const text = banner(
      {
        version: '0.1.0',
        model: 'm',
        profile: 'read-only',
        workspace: '/w',
        isolation: 'os-isolated',
        caveat: 'c',
      },
      plain,
      glyphs(false),
    );
    assert.match(text, /isolation\s+os-isolated/);
  });
});

describe('diffs', () => {
  test('additions, removals and hunks are distinguishable', () => {
    const rendered = diffBlock('--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new', fancy);
    assert.match(rendered, new RegExp(`${ESC}\\[32m\\+new`), 'an added line is not green');
    assert.match(rendered, new RegExp(`${ESC}\\[31m-old`), 'a removed line is not red');
  });

  test('a long diff is truncated with a count, not silently cut', () => {
    const long = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join('\n');
    const rendered = diffBlock(long, plain, 10);
    assert.match(rendered, /… 90 more line\(s\)/);
  });
});

describe('the spinner', () => {
  test('it writes nothing at all when disabled', () => {
    let written = '';
    const s = new Spinner((t) => (written += t), plain, glyphs(false), false);
    s.start('Thinking');
    s.tick();
    s.stop();
    assert.equal(written, '', 'a disabled spinner wrote frames into a pipe');
  });

  test('it erases its own line, and never moves the cursor anywhere else', () => {
    let written = '';
    const s = new Spinner(
      (t) => (written += t),
      plain,
      glyphs(true),
      true,
      () => 1000,
    );
    s.start('Thinking');
    s.stop();

    // `\r` and erase-to-end-of-line only. Anything that positions the cursor
    // absolutely would survive the process and corrupt the scrollback.
    const codes = [...written.matchAll(/\[([0-9;]*)([A-Za-z])/g)].map((m) => m[2]);
    assert.deepEqual([...new Set(codes)], ['K'], `unexpected escape sequences: ${JSON.stringify(written)}`);
  });

  test('elapsed seconds appear once there are any', () => {
    let written = '';
    let now = 10_000;
    const s = new Spinner(
      (t) => (written += t),
      plain,
      glyphs(true),
      true,
      () => now,
    );
    s.start('Running Shell');
    now = 13_000;
    s.tick();
    s.stop();
    assert.match(written, /Running Shell 3s/);
  });
});

describe('the event stream, as output', () => {
  const render = (events: Array<[string, unknown]>, live = false): string => {
    let out = '';
    const renderer = new SessionRenderer({
      write: (t) => (out += t),
      palette: plain,
      glyphs: glyphs(true),
      live,
    });
    for (const [type, payload] of events) renderer.on(type, payload);
    renderer.quiet();
    return out;
  };

  test('a call and its result print in order', () => {
    const out = render([
      ['tool.call', { toolCallId: 'c1', name: 'Read', argsSummary: '{"path":"a.ts"}' }],
      ['tool.result', { toolCallId: 'c1', isError: false, contentBytes: 12 }],
    ]);
    assert.equal(out, '⏺ Read(a.ts)\n  ⎿ 12 B\n');
  });

  test('a denial is a failure line, whatever the payload says', () => {
    // `tool.denied` carries no `isError`, because a denial is not the tool
    // failing. On screen it still has to read as "this did not happen".
    const out = render([
      ['tool.call', { toolCallId: 'c1', name: 'Shell', argsSummary: '{"argv":["rm","-rf","/"]}' }],
      ['tool.denied', { toolCallId: 'c1' }],
    ]);
    assert.match(out, /⏺ Shell\(rm -rf \/\)/);
    assert.match(out, /⎿ denied/);
  });

  test('events it does not render produce nothing', () => {
    // The default branch is deliberate: the event vocabulary grows, and a renderer
    // that printed unknown events would turn every new event into a UI change.
    assert.equal(render([['policy.decision', { anything: true }]]), '');
  });

  test('a malformed payload does not throw', () => {
    // Everything here is `unknown` off an event bus. A renderer that can be crashed
    // by a payload is a renderer that can take a session down.
    assert.doesNotThrow(() =>
      render([
        ['tool.call', undefined],
        ['tool.result', 'not an object'],
      ]),
    );
  });

  test('nothing is written for a turn that only thinks', () => {
    assert.equal(
      render([
        ['turn.started', {}],
        ['model.request.started', {}],
        ['turn.completed', {}],
      ]),
      '',
    );
  });
});
