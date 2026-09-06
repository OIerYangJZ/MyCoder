/**
 * What a session looks like while it works (alpha.12, `src/cli/render.ts`).
 *
 * The renderer is pure on purpose — one map of in-flight calls and no other state —
 * so every case below is an assertion about a string rather than a screenshot.
 *
 * The two that matter most are the ones about *not* styling: escape codes written
 * into a pipe end up in somebody's log file, and box-drawing plus the dingbats the
 * spinner is built from end up as mojibake in a CI log and in `cmd.exe`. `NO_COLOR`
 * is honoured over `FORCE_COLOR` because it is the convention people set after
 * something got this wrong.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  banner,
  box,
  centre,
  colourDepth,
  formatCost,
  formatDuration,
  inputFrame,
  inputRule,
  pickThinking,
  pickTips,
  THINKING,
  sessionList,
  statusLine,
  submitted,
  TIPS,
  turnFooter,
  colourEnabled,
  diffBlock,
  formatBytes,
  glyphs,
  palette,
  SessionRenderer,
  Spinner,
  summariseArgs,
  timeAgo,
  truncatePath,
  toolCallLine,
  toolResultLine,
  visibleWidth,
  wrapRuns,
  wrapText,
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
    assert.equal(toolResultLine({ contentBytes: 2048 }, plain, g), '  ⎿  2.0 kB');
  });

  test('a failure shows the error code, not a byte count', () => {
    const g = glyphs(true);
    assert.equal(toolResultLine({ isError: true, errorCode: 'STALE_FILE' }, plain, g), '  ⎿  STALE_FILE');
    assert.equal(toolResultLine({ isError: true }, plain, g), '  ⎿  failed');
  });

  test('bytes are human, and the boundaries are the obvious ones', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.0 kB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  });
});

describe('how wide a string actually is', () => {
  // Everything that lines up in this file — the box, the banner frame, the centred
  // title, the guard that decides whether a sent line can be redrawn — is padded
  // from `visibleWidth`. It used to be `String.length` with the escape codes
  // stripped, which is right for ASCII and wrong for the two cases below.

  test('an escape code takes no columns', () => {
    assert.equal(visibleWidth(fancy.bold('abc')), 3);
    assert.equal(visibleWidth(`${fancy.dim('a')}${fancy.red('b')}`), 2);
  });

  test('a CJK character occupies two columns, not one', () => {
    // `reference/clio` measures this with `.length` and its input line corrupts
    // itself the moment somebody types Chinese. A task written in Chinese is not
    // an edge case here.
    assert.equal(visibleWidth('修复失败的测试'), 14);
    assert.equal(visibleWidth('a好b'), 4);
    assert.equal(visibleWidth('（全角）'), 8, 'fullwidth punctuation is wide too');
    assert.equal(visibleWidth('ｱ'), 1, 'halfwidth kana is not');
  });

  test('a surrogate pair is one character, not two', () => {
    assert.equal('𝄞'.length, 2, 'the premise: UTF-16 counts this twice');
    assert.equal(visibleWidth('𝄞'), 1);
    assert.equal(visibleWidth('𠮷'), 2, 'an astral CJK ideograph is still wide');
  });

  test('a combining mark adds nothing to the width', () => {
    assert.equal(visibleWidth('é'), 1, 'e + combining acute is one column');
    assert.equal(visibleWidth('a​b'), 2, 'a zero-width space is zero-width');
  });

  test('a box around CJK still lines up', () => {
    const rendered = box(['修复失败的测试', 'ok'], fancy, glyphs(true));
    const widths = new Set(rendered.split('\n').map(visibleWidth));
    assert.equal(widths.size, 1, `ragged box: ${[...widths].join(', ')}`);
  });

  test('the banner frame closes on a workspace path that is not ASCII', () => {
    const rendered = banner(
      {
        version: '0.1.0',
        model: 'deepseek',
        profile: 'workspace-dev',
        workspace: '/Users/me/项目/我的代码',
        isolation: 'policy only',
        caveat: 'Policy is not a sandbox.',
      },
      fancy,
      glyphs(true),
      80,
      [],
    );
    const framed = rendered.split('\n').filter((l) => l.includes('│'));
    const widths = new Set(framed.map(visibleWidth));
    assert.equal(widths.size, 1, `the frame is ragged: ${[...widths].join(', ')}`);
  });

  test('a value wider than the frame wraps inside it, rather than breaking out', () => {
    // Reported two milestones before it was fixed, and true of plain ASCII as well as
    // CJK: a long value was padded by `max(0, …)` — which is to say not padded — and
    // printed past the closing rule.
    const wide = (workspace: string, cols: number): string[] =>
      banner(
        {
          version: '0.1.0',
          model: 'deepseek',
          profile: 'workspace-dev',
          workspace,
          isolation: 'policy-enforced — network from Shell is best-effort and not a sandbox',
          caveat: 'Policy is not a sandbox.',
        },
        fancy,
        glyphs(true),
        cols,
        ['a tip that is reasonably long here', 'b', 'c', 'd'],
      )
        .split('\n')
        .filter((l) => l.includes('│'));

    for (const [what, ws, cols] of [
      ['a long ASCII path', `/Users/me/${'a'.repeat(110)}`, 100],
      ['a long CJK path', `/Users/me/${'项目'.repeat(20)}`, 100],
      ['a narrow terminal', '/Users/me/code', 40],
    ] as Array<[string, string, number]>) {
      const widths = new Set(wide(ws, cols).map(visibleWidth));
      assert.equal(widths.size, 1, `${what}: ragged frame ${[...widths].join(', ')}`);
    }
  });

  test('and the isolation line survives whole, because truncating it changes the claim', () => {
    // Tips are decoration and may be dropped; a policy statement cut short reads as a
    // narrower policy. Invariant 5, the same reason the tips give way first.
    const isolation = 'policy-enforced — network from Shell is best-effort and not a sandbox';
    const rendered = banner(
      {
        version: '0.1.0',
        model: 'deepseek',
        profile: 'workspace-dev',
        workspace: '/Users/me/code',
        isolation,
        caveat: 'Policy is not a sandbox.',
      },
      plain,
      glyphs(true),
      48,
      [],
    );
    const flattened = rendered.replace(/[│\n ]+/g, ' ');
    for (const word of isolation.split(' ')) {
      assert.ok(flattened.includes(word), `'${word}' was lost from the isolation line`);
    }
  });

  test('a wide path makes the tips give way, because the budget now counts columns', () => {
    // The left column's width used to be re-derived from the label and the value
    // separately, in characters. A path in Chinese was therefore budgeted at half
    // its width, the tips column looked affordable, and the row it produced ran past
    // the frame. Tips are decoration and the left column is not, so the correct
    // outcome is the one the narrow-terminal case already had: no tips.
    // Fixed tips rather than picked ones — a random tip length would make this a
    // coin toss.
    const wide = (workspace: string): string =>
      banner(
        {
          version: '0.1.0',
          model: 'deepseek',
          profile: 'workspace-dev',
          workspace,
          isolation: 'policy only',
          caveat: 'Policy is not a sandbox.',
        },
        fancy,
        glyphs(true),
        100,
        ['a tip that is reasonably long here', 'b', 'c', 'd'],
      );

    assert.match(wide('/Users/me/code'), /Tips/, 'a short path leaves room for tips');
    assert.equal(
      /Tips/.test(wide(`/Users/me/${'项目'.repeat(20)}`)),
      false,
      'a 90-column path still looked affordable, so the tips were kept and overflowed',
    );
  });

  test('truncation counts columns and never splits a character in half', () => {
    const summary = summariseArgs('Read', JSON.stringify({ path: '中'.repeat(100) }), 20);
    assert.ok(visibleWidth(summary) <= 20, `${visibleWidth(summary)} columns is over budget`);
    assert.match(summary, /…$/);
    // A cut in the middle of a surrogate pair produces a lone surrogate, which is
    // what mojibake in a terminal is made of.
    const astral = summariseArgs('Read', JSON.stringify({ path: '𝄞'.repeat(40) }), 10);
    assert.equal(/[\uD800-\uDFFF]/.test(astral.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), false);
  });
});

describe('boxes', () => {
  test('every line is padded to the same width, ignoring escape codes', () => {
    const rendered = box(['short', fancy.bold('bold and longer')], fancy, glyphs(true));
    const widths = new Set(rendered.split('\n').map(visibleWidth));
    assert.equal(widths.size, 1, `ragged box: ${[...widths].join(', ')}`);
  });

  test('a line wider than the box is wrapped into it, not printed past the edge', () => {
    // The approval box is the one screen a user is required to read, and its longest
    // line — the sentence describing what a session-scoped grant covers — ran past
    // the right-hand rule. `max(0, …)` padded it by nothing and the frame went
    // ragged there.
    const long = 'scope    : this call only, or the rest of this session for exactly this action';
    const rendered = box(['short', long], plain, glyphs(true), 60);
    const widths = new Set(rendered.split('\n').map(visibleWidth));
    assert.equal(widths.size, 1, `ragged box: ${[...widths].join(', ')}`);
    // Wrapped, not cut: a truncated policy statement reads as a narrower claim.
    assert.match(rendered, /exactly this action/);
  });

  test('a CJK line wider than the box wraps without breaking the frame either', () => {
    const rendered = box(['ok', '修复'.repeat(30)], plain, glyphs(true), 40);
    const widths = new Set(rendered.split('\n').map(visibleWidth));
    assert.equal(widths.size, 1, `ragged box: ${[...widths].join(', ')}`);
  });
  test('the frame, the title and the prompt all use one accent colour', () => {
    // One colour, and it is the accent: a frame in one colour and a title in
    // another reads as two unrelated things.
    //
    // The accent used to be blue and is now a warm terracotta, which has no ANSI
    // code — at four bits the nearest thing is `33`, and that is what `palette(true)`
    // produces. The 24-bit form is asserted separately below; asserting only the
    // four-bit codes here would let the table go wrong at the depth people see.
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
    assert.match(framed, new RegExp(`${ESC}\\[2;33m╭`), 'the frame is not in the accent');
    assert.match(framed, new RegExp(`${ESC}\\[1;33m✻`), 'the title mark is not the bold accent');
    assert.match(
      inputRule(fancy, glyphs(true), 40),
      new RegExp(`${ESC}\\[2;33m─+`),
      'the input rule is not in the accent',
    );
  });

  test('the accent is one hue at every depth, and only its precision changes', () => {
    // The whole point of the ink table: a terminal that can show #d97757 is asked
    // for it, and one that cannot gets the nearest thing rather than a second
    // design. Regressing this looks like nothing on a 4-bit terminal and like a
    // different program on a 24-bit one, which is the failure nobody notices.
    assert.match(palette(24).accent('x'), new RegExp(`^${ESC}\\[38;2;217;119;87m`));
    assert.match(palette(8).accent('x'), new RegExp(`^${ESC}\\[38;5;209m`));
    assert.match(palette(4).accent('x'), new RegExp(`^${ESC}\\[33m`));
    assert.equal(palette(0).accent('x'), 'x');
  });

  test('a deeper terminal is asked for more colour, and NO_COLOR still wins', () => {
    assert.equal(colourDepth({ COLORTERM: 'truecolor' }, true), 24);
    assert.equal(colourDepth({ TERM: 'xterm-256color' }, true), 8);
    assert.equal(colourDepth({ TERM: 'xterm' }, true), 4);
    assert.equal(colourDepth({ TERM: 'xterm' }, false), 0);
    // The one convention a user sets *because* something got this wrong before.
    assert.equal(colourDepth({ COLORTERM: 'truecolor', NO_COLOR: '1' }, true), 0);
    assert.equal(colourDepth({ TERM: 'dumb', COLORTERM: 'truecolor' }, true), 0);
    // And the override, at each of the levels the convention assigns.
    assert.equal(colourDepth({ FORCE_COLOR: '3' }, false), 24);
    assert.equal(colourDepth({ FORCE_COLOR: '1', COLORTERM: 'truecolor' }, true), 4);
  });

  test('the input frame closes on all four sides now, and the bare rule still does not', () => {
    // This used to assert the opposite, on the argument that a right-hand border
    // "would need the input line rewritten on every keystroke, which is the TUI
    // spec §1.3 rules out". The first half stopped being a cost when ADR-0032
    // replaced readline with an editor that rewrites every row of its block on
    // every keystroke anyway; the second half was never what §1.3 says — it rules
    // out an alternate screen and absolute positioning, and the frame uses
    // neither. So the box closed, and this test now says which is which.
    //
    // `inputRule` survives as the shape for anything that is not a live terminal.
    const rule = inputRule(plain, glyphs(true), 30);
    assert.match(rule, /^─+$/, `the rule is not a bare horizontal: ${JSON.stringify(rule)}`);
    assert.equal(rule.includes('│'), false, 'the bare rule grew a side');

    const frame = inputFrame(plain, glyphs(true), 30);
    assert.match(frame.top, /^╭─+╮$/);
    assert.match(frame.bottom, /^╰─+╯$/);
    assert.equal(frame.left, '│');
    assert.equal(frame.right, '│');
    assert.equal(
      visibleWidth(frame.top),
      30,
      'the frame does not span the width it was given, so the box will be ragged',
    );
  });

  test('the title sits at the left edge with the version at the right, at any width', () => {
    // It was centred, which is what a narrow box wants. The box is full width, and
    // a title floating in the middle of a hundred and twenty columns over a
    // hard-left column of labels has nothing to line up with. Left-aligned it
    // starts on the same vertical as the labels, the tool lines and the prompt.
    //
    // The version goes to the far right rather than trailing the name: it is the
    // thing you go looking for when filing a bug and never the thing you read
    // first, and a fixed corner is easier to find than a position that moves with
    // the length of the name.
    const info = {
      version: '0.1.0',
      model: 'm',
      profile: 'p',
      workspace: '/w',
      isolation: 'i',
      caveat: 'c',
    };
    for (const cols of [60, 120]) {
      const lines = banner(info, plain, glyphs(true), cols, []).split('\n');
      const frame = lines[0] ?? '';
      const title = lines[1] ?? '';
      assert.ok(
        visibleWidth(frame) >= cols - 4,
        `the frame is ${visibleWidth(frame)} wide in ${cols} columns`,
      );

      const inner = title.replace(/^.|.$/g, '');
      assert.match(inner, /^ ✻ MyCoder /, `the title is not against the left edge: ${inner}`);
      assert.match(inner, /0\.0\.1|0\.1\.0 $/, `the version is not against the right edge: ${inner}`);
      // Every row of the frame closes in the same column, the title row included.
      assert.equal(visibleWidth(title), visibleWidth(frame), `the title row is ragged in ${cols}`);
    }
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
    // Tips are passed explicitly and empty: one of the real tips contains the word
    // "context", and a test that grepped for it would pass or fail on a coin toss.
    assert.match(
      banner({ ...base, contextWindow: 65536 }, plain, glyphs(true), 80, []),
      /context\s+65,536 tokens/,
    );
    assert.equal(/context\s+\d/.test(banner(base, plain, glyphs(true), 80, [])), false);
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
    assert.match(written, /Running Shell… \(3s\)/);
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
    assert.equal(out, '⏺ Read(a.ts)\n  ⎿  12 B\n');
  });

  test('a denial is a failure line, whatever the payload says', () => {
    // `tool.denied` carries no `isError`, because a denial is not the tool
    // failing. On screen it still has to read as "this did not happen".
    const out = render([
      ['tool.call', { toolCallId: 'c1', name: 'Shell', argsSummary: '{"argv":["rm","-rf","/"]}' }],
      ['tool.denied', { toolCallId: 'c1' }],
    ]);
    assert.match(out, /⏺ Shell\(rm -rf \/\)/);
    assert.match(out, /⎿  denied/);
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

describe('the banner is full width, and tips are the part that gives way', () => {
  const info = {
    version: '0.1.0',
    model: 'deepseek',
    contextWindow: 65536,
    profile: 'workspace-dev',
    workspace: '/home/y/project',
    isolation: 'policy-enforced — network from Shell is best-effort',
    caveat: 'Kernel policy governs what tools may request.',
  };

  test('it spans the terminal rather than hugging its content', () => {
    const wide = banner(info, plain, glyphs(true), 140).split('\n')[0] ?? '';
    assert.ok(visibleWidth(wide) >= 136, `the frame is ${visibleWidth(wide)} wide in a 140-column terminal`);
  });

  test('tips appear when there is room for them', () => {
    const text = banner(info, plain, glyphs(true), 140, ['/help lists every control command']);
    assert.match(text, /Tips/);
    assert.match(text, /· \/help lists every control command/);
  });

  test('a narrow terminal drops the tips and keeps the isolation line whole', () => {
    // The left column is not decoration. Truncating an isolation line turns an
    // accurate claim into a different one, which is what invariant 5 is about.
    const text = banner(info, plain, glyphs(true), 80, TIPS.slice(0, 4));
    assert.equal(/Tips/.test(text), false, 'tips survived a terminal too narrow for them');
    assert.match(text, /policy-enforced — network from Shell is best-effort/);
  });

  test('the caveat under the frame is left-aligned, not centred', () => {
    const lines = banner(info, plain, glyphs(true), 100, []).split('\n');
    const prose = lines.filter((l) => l.startsWith('  Kernel policy'));
    assert.equal(prose.length, 1, 'the caveat moved or gained an indent');
  });

  test('pickTips returns distinct tips, and the source is injectable', () => {
    const picked = pickTips(3, () => 0);
    assert.equal(picked.length, 3);
    assert.equal(new Set(picked).size, 3, 'a tip was offered twice');
    assert.deepEqual(
      pickTips(3, () => 0),
      TIPS.slice(0, 3),
      'a fixed generator must be deterministic',
    );
  });

  test('the spinner has more than one word for waiting, and they all mean waiting', () => {
    // Decoration, and the only piece of it in this file — but it is the thing on
    // screen longest, and a fixed `Thinking` for ninety seconds reads as a hang.
    //
    // Synonyms rather than jokes, deliberately: this line also carries the elapsed
    // time and the running spend, and a punchline in front of a bill is the wrong
    // register. The assertion is the weakest one that would catch a joke slipping
    // in — every word is a plain gerund and none of them claims to be doing
    // anything in particular.
    assert.ok(THINKING.length > 1, 'one word is not a rotation');
    for (const word of THINKING) {
      assert.match(word, /^[A-Z][a-z]+ing$/, `${word} is not a plain gerund`);
    }
    assert.equal(
      pickThinking(() => 0),
      THINKING[0],
    );
    assert.equal(
      pickThinking(() => 0.999),
      THINKING[THINKING.length - 1],
    );
  });
});

describe('what it did, once it has done it', () => {
  test('the footer names the work in the words a person would use', () => {
    const counts = new Map([
      ['Read', 3],
      ['Grep', 3],
      ['Glob', 2],
      ['Shell', 27],
    ]);
    const footer = turnFooter(64_000, counts, plain, glyphs(true));
    assert.match(footer, /✻ Worked for 1m 4s/);
    assert.match(
      footer,
      /read 3 files, searched for 3 patterns, listed 2 directories, ran 27 shell commands/,
    );
  });

  test('one of a thing is singular', () => {
    assert.match(turnFooter(1000, new Map([['Read', 1]]), plain, glyphs(true)), /read 1 file(?!s)/);
  });

  test('a tool the list has never heard of is still counted, by name', () => {
    // Otherwise a tool added later disappears from the summary silently, which is
    // the same shape as every other defect this milestone found.
    assert.match(turnFooter(1000, new Map([['Newtool', 2]]), plain, glyphs(true)), /called Newtool 2 times/);
  });

  test('a turn that called nothing says only how long it took', () => {
    const footer = turnFooter(5000, new Map(), plain, glyphs(true));
    assert.equal(footer.includes('\n'), false, 'an empty summary line was printed anyway');
  });

  test('durations are whole units', () => {
    assert.equal(formatDuration(999), '1s');
    assert.equal(formatDuration(43_000), '43s');
    assert.equal(formatDuration(64_000), '1m 4s');
    assert.equal(formatDuration(7_380_000), '2h 3m');
  });

  test('the renderer counts from the events, not from the model', () => {
    let out = '';
    const renderer = new SessionRenderer({
      write: (t) => (out += t),
      palette: plain,
      glyphs: glyphs(true),
      live: false,
    });
    renderer.on('turn.started', {});
    for (const path of ['a.ts', 'b.ts']) {
      renderer.on('tool.call', { toolCallId: path, name: 'Read', argsSummary: `{"path":"${path}"}` });
      renderer.on('tool.result', { toolCallId: path, isError: false, contentBytes: 10 });
    }
    renderer.on('turn.completed', {});

    const footer = renderer.footer(() => Date.now() + 3000);
    assert.ok(footer, 'a turn with tool calls has no footer');
    assert.match(footer!, /read 2 files/);
    assert.ok(out.length > 0);
  });

  test('a fast turn that called nothing gets no footer at all', () => {
    const renderer = new SessionRenderer({
      write: () => {},
      palette: plain,
      glyphs: glyphs(true),
      live: false,
    });
    renderer.on('turn.started', {});
    assert.equal(
      renderer.footer(() => Date.now()),
      undefined,
    );
  });
});

describe('the input frame, before and after sending', () => {
  test('what was sent is marked in the margin, not repainted as a slab', () => {
    // It was a bar of `47;30` — black on white, hardcoded, which is not "inverse"
    // and does not follow a theme. On a dark terminal it was the brightest thing on
    // screen, brighter than the model's own answer, drawing the eye to the one line
    // whose contents the reader already knows; on a light one it was grey on grey.
    // And it ran one column past the text at each end, so the width of the slab
    // varied with the length of the prompt. A mark in the margin answers the same
    // question — which lines were mine — and costs one column.
    const block = submitted('fix the failing test', fancy, glyphs(true));
    assert.match(block, /❯/, 'the sent line lost its marker');
    assert.match(block, /fix the failing test/);
    assert.equal(block.includes('47;30'), false, 'the slab is back');
    assert.ok(block.endsWith('\n\n'), 'the sent line needs air under it');
  });

  test('it moves no cursor, because the editor has already taken its block down', () => {
    // It used to step up one row and clear, which was right when input was one
    // readline row. The editor's block is the prompt line, any wrapped rows and the
    // frame — so stepping up one left the prompt line on screen and the sent line
    // appeared twice: once as typed, once as the block. Found under a pty.
    const block = submitted('fix the failing test', fancy, glyphs(true));
    assert.equal(/\u001b\[\d*[ABCDJK]/.test(block), false, `it still moves: ${JSON.stringify(block)}`);
  });

  test('a long line still gets its mark, because that is when it matters most', () => {
    // There used to be a guard dropping the block for anything wider than the
    // terminal — a leftover from when this moved the cursor up one row. Once the
    // editor started clearing its own block, that guard meant a long line
    // disappeared from the transcript altogether.
    const block = submitted('x'.repeat(100), fancy, glyphs(true));
    assert.match(block, /x{100}/, 'a long line lost its text');
    assert.match(block, /❯/, 'and its marker');
  });

  test('a CJK line that wraps keeps its mark too', () => {
    const block = submitted('中'.repeat(50), fancy, glyphs(true));
    assert.match(block, /❯/);
    assert.match(block, /中{50}/);
  });

  test('every line of a multi-line send is marked, not just the first', () => {
    // A pasted task is several lines and all of them are the user's. Marking only
    // the first would leave the rest looking like the transcript resuming.
    const block = submitted('first\nsecond\nthird', fancy, glyphs(true));
    assert.equal(block.split('❯').length - 1, 3, `not every line was marked: ${JSON.stringify(block)}`);
  });

  test('the rule spans the terminal, like the banner above it', () => {
    assert.equal(visibleWidth(inputRule(plain, glyphs(true), 200)), 198);
    assert.equal(visibleWidth(inputRule(plain, glyphs(true), 40)), 38);
  });

  test('the status line reports what the session counted, and no context percentage', () => {
    const line = statusLine(
      {
        model: 'deepseek',
        contextWindow: 65536,
        requests: 3,
        tokens: 12_400,
        costUsd: 0.0031,
        elapsedMs: 5000,
      },
      plain,
    );
    assert.match(line, /deepseek/);
    assert.match(line, /66k ctx/);
    assert.match(line, /3 requests/);
    assert.match(line, /12\.4k tokens/);
    assert.match(line, /\$0\.0031/);
    assert.match(line, /5s/);
    // The authoritative context estimate lives on the control-plane host. A second
    // one computed here would disagree with `/status`, which is the shape of half
    // the defects this milestone found.
    assert.equal(/%/.test(line), false, 'a context percentage appeared from somewhere');
  });
});

describe('the answer, streamed', () => {
  // `model.stream` has always been emitted — `Session` forwards every `ModelEvent`
  // to the host. Nothing listened, so the answer was assembled in silence and
  // printed whole while the spinner said `Thinking`.

  function streaming() {
    const err: string[] = [];
    const out: string[] = [];
    const renderer = new SessionRenderer({
      write: (s) => err.push(s),
      palette: plain,
      glyphs: glyphs(true),
      live: false,
      writeAnswer: (s) => out.push(s),
      answerPalette: plain,
      columns: () => 80,
    });
    return { renderer, err, out, answer: (): string => out.join('') };
  }

  test('text deltas are written to the answer sink, not to the chrome one', () => {
    const s = streaming();
    s.renderer.on('turn.started', {});
    s.renderer.on('model.stream', { type: 'text_delta', text: 'hello ' });
    s.renderer.on('model.stream', { type: 'text_delta', text: 'world\n' });
    assert.match(s.answer(), /hello world/);
    assert.equal(s.err.join('').includes('hello'), false, 'the answer leaked onto stderr');
  });

  test('a renderer with no answer sink streams nothing, which is what --json needs', () => {
    const err: string[] = [];
    const renderer = new SessionRenderer({
      write: (s) => err.push(s),
      palette: plain,
      glyphs: glyphs(true),
      live: false,
    });
    renderer.on('turn.started', {});
    renderer.on('model.stream', { type: 'text_delta', text: 'hello' });
    assert.equal(renderer.streamedAnswer(), false);
    assert.equal(err.join('').includes('hello'), false);
  });

  test('anything that is not visible text is ignored, reasoning included', () => {
    const s = streaming();
    s.renderer.on('turn.started', {});
    s.renderer.on('model.stream', { type: 'reasoning_delta', text: 'let me think' });
    s.renderer.on('model.stream', { type: 'usage', usage: {} });
    s.renderer.on('model.stream', { type: 'tool_call_start', id: 'a', name: 'Read' });
    assert.equal(s.answer(), '');
    assert.equal(s.renderer.streamedAnswer(), false);
  });

  test('the caller is told whether it streamed, so the answer is not printed twice', () => {
    const s = streaming();
    s.renderer.on('turn.started', {});
    assert.equal(s.renderer.streamedAnswer(), false, 'nothing streamed yet');
    s.renderer.on('model.stream', { type: 'text_delta', text: 'partial' });
    assert.equal(s.renderer.streamedAnswer(), true);
    s.renderer.on('turn.started', {});
    assert.equal(s.renderer.streamedAnswer(), false, 'the next turn starts clean');
  });

  test('a tool call closes off the sentence the model was mid-way through', () => {
    // Otherwise `⏺ Read(...)` lands inside the prose on the same row.
    const s = streaming();
    s.renderer.on('turn.started', {});
    s.renderer.on('model.stream', { type: 'text_delta', text: 'Let me look at' });
    s.renderer.on('tool.call', { name: 'Read', toolCallId: 'c1', argsSummary: '{"path":"a.ts"}' });
    assert.match(s.answer(), /Let me look at\n$/, 'the answer was left mid-line');
  });

  test('a cancelled turn does not leave the cursor inside the prose', () => {
    const s = streaming();
    s.renderer.on('turn.started', {});
    s.renderer.on('model.stream', { type: 'text_delta', text: 'half a sen' });
    s.renderer.on('turn.cancelled', {});
    assert.match(s.answer(), /\n$/);
  });

  test('a code block in the answer is highlighted on the way past', () => {
    const seen: string[] = [];
    const renderer = new SessionRenderer({
      write: () => {},
      palette: plain,
      glyphs: glyphs(true),
      live: false,
      writeAnswer: (s) => seen.push(s),
      // The answer's palette, not the chrome's: this is the one that decides
      // whether the code block is coloured.
      answerPalette: fancy,
      columns: () => 80,
    });
    renderer.on('turn.started', {});
    renderer.on('model.stream', { type: 'text_delta', text: '```ts\nconst x = 1;\n```\n' });
    assert.match(seen.join(''), /\[34mconst\[0m/);
  });

  test('control characters from the model never reach the terminal', () => {
    // The answer is bytes a model chose, printed to something that obeys escape
    // sequences. This is the one property here that is not cosmetic.
    const s = streaming();
    s.renderer.on('turn.started', {});
    s.renderer.on('model.stream', { type: 'text_delta', text: `a${ESC}[2Jb\n` });
    assert.equal(s.answer().includes(ESC), false);
    assert.match(s.answer(), /a\[2Jb/);
  });
});

describe('live figures, without a scroll region', () => {
  // clio reserves a bottom bar with DECSTBM — absolute terminal state that outlives
  // the process, so a crash before it is restored leaves the terminal broken. The
  // spinner line is already live and already erases itself, so the figures go there.

  function ticking() {
    const out: string[] = [];
    let now = 0;
    const s = new Spinner(
      (t) => out.push(t),
      plain,
      glyphs(true),
      true,
      () => now,
    );
    return { s, out, advance: (ms: number) => (now += ms), last: () => out[out.length - 1] ?? '' };
  }

  test('the detail is appended to the line the spinner already writes', () => {
    const t = ticking();
    t.s.start('Thinking');
    t.s.setDetail('1.2k tokens · $0.0041');
    t.s.tick();
    assert.match(t.last(), /Thinking.*1\.2k tokens · \$0\.0041/);
    t.s.stop();
  });

  test('no detail means the line is exactly what it was before', () => {
    const t = ticking();
    t.s.start('Thinking');
    t.s.tick();
    assert.equal(t.last().includes('·'), false, `an empty detail left a separator: ${t.last()}`);
    t.s.stop();
  });

  test('it is still one line that erases itself, and no cursor is addressed', () => {
    const t = ticking();
    t.s.start('Running Shell');
    t.s.setDetail('99.9k tokens');
    t.advance(4000);
    t.s.tick();
    const line = t.last();
    assert.match(line, /^\r\[K/, 'a frame must start by clearing its own line');
    assert.equal(line.includes('\n'), false, 'the spinner grew a second row');
    assert.equal(/\[\d*[ABr]/.test(line), false, 'the spinner moved the cursor off its line');
    t.s.stop();
  });

  test('the renderer resets the figures when a new turn starts', () => {
    const out: string[] = [];
    const renderer = new SessionRenderer({
      write: (x) => out.push(x),
      palette: plain,
      glyphs: glyphs(true),
      live: false,
    });
    renderer.on('turn.started', {});
    renderer.on('model.request.completed', { usage: { inputTokens: 1000, outputTokens: 200 }, costUsd: 0.5 });
    renderer.on('model.request.completed', { usage: { inputTokens: 1000, outputTokens: 200 }, costUsd: 0.5 });
    // Two requests accumulate; a new turn starts from nothing. Asserted through the
    // public surface rather than by reaching into the renderer's fields.
    renderer.on('turn.started', {});
    assert.equal(renderer.streamedAnswer(), false);
  });
});
describe('the session picker (ADR-0029)', () => {
  test('ages are read at a glance, not to the second', () => {
    const now = 1_000_000_000;
    assert.equal(timeAgo(now - 5_000, now), 'just now');
    assert.equal(timeAgo(now - 14 * 60_000, now), '14m ago');
    assert.equal(timeAgo(now - 3 * 3_600_000, now), '3h ago');
    assert.equal(timeAgo(now - 50 * 3_600_000, now), '2d ago');
  });

  test('a session is offered by what it was asked, with the id still available', () => {
    const now = 1_000_000_000;
    const text = sessionList(
      [
        { sessionId: 'ses_a', title: 'fix the flaky ssh test', model: 'gpt', updatedAt: now, toolCalls: 12 },
        { sessionId: 'ses_b', model: 'fake', updatedAt: now - 86_400_000, toolCalls: 1 },
      ],
      '/repo',
      now,
      plain,
    );

    assert.match(text, /Sessions in \/repo/);
    assert.match(text, /1 {2}just now {2}fix the flaky ssh test/);
    assert.match(text, /gpt · 12 tool calls · ses_a/);
    // A session nobody asked anything is a real state, and it must not look like
    // a missing field.
    assert.match(text, /\(nothing was asked in this session\)/);
    assert.match(text, /1 tool call · ses_b/);
  });
});

describe('the footer counts what ran, not what was attempted (alpha.12)', () => {
  const p = palette(false);
  const gl = glyphs(false);

  /**
   * `calls` is incremented when a call *starts*, because that is when the
   * renderer learns the tool's name — so a refused call was counted as a
   * completed one. Seen on a real run: the model's own prose said "shell
   * approval was declined in this non-interactive session" three lines above a
   * footer claiming it ran one.
   */
  test('a refused call is not reported as one that ran', () => {
    const out = turnFooter(1000, new Map([['Shell', 1]]), p, gl, new Map([['Shell', 1]]));
    assert.ok(!/ran 1 shell command/.test(out), `still claims it ran: ${out}`);
    assert.match(out, /1 refused \(Shell\)/);
  });

  test('the ones that did run are still counted, alongside the ones that did not', () => {
    const out = turnFooter(
      1000,
      new Map([
        ['Shell', 3],
        ['Write', 2],
      ]),
      p,
      gl,
      new Map([['Shell', 2]]),
    );
    assert.match(out, /ran 1 shell command/);
    assert.match(out, /wrote 2 files/);
    assert.match(out, /2 refused \(Shell ×2\)/);
  });

  test('with nothing refused the footer is exactly what it always was', () => {
    const before = turnFooter(
      1000,
      new Map([
        ['Shell', 1],
        ['Read', 2],
      ]),
      p,
      gl,
    );
    const after = turnFooter(
      1000,
      new Map([
        ['Shell', 1],
        ['Read', 2],
      ]),
      p,
      gl,
      new Map(),
    );
    assert.equal(before, after);
    assert.match(after, /read 2 files, ran 1 shell command/);
  });

  test('a tool refused every time it was tried disappears from the ran list', () => {
    const out = turnFooter(1000, new Map([['Delete', 2]]), p, gl, new Map([['Delete', 2]]));
    assert.ok(!/deleted/.test(out), `claims a deletion happened: ${out}`);
    assert.match(out, /2 refused \(Delete ×2\)/);
  });
});

describe('the money line does not claim a cost it could not compute (alpha.12)', () => {
  const p = palette(false);
  const base = { model: 'gpt', requests: 1, tokens: 2400 };

  /**
   * `estimateCost` returns `provenance: 'unknown'` when a profile has no rates,
   * and the session correctly refuses to add such a figure to the total — so the
   * total stays at zero, and zero on its own reads as "this was free". A live
   * run against an unpriced model printed `$0.0000` for a session that had spent
   * real money. `ModelProfile.pricing` promises cost is reported as unknown when
   * it is unset; this is where that promise reaches the line people read.
   */
  test('nothing priced says so, rather than printing zero', () => {
    const out = statusLine({ ...base, costUsd: 0, unpricedRequests: 1 }, p);
    assert.ok(!/\$0\.0000/.test(out), `claims it was free: ${out}`);
    assert.match(out, /cost unknown \(1 unpriced request\)/);
  });

  test('a partly priced session reports a floor, not a total', () => {
    const out = statusLine({ ...base, costUsd: 0.0071, unpricedRequests: 2 }, p);
    assert.match(out, /≥\$0\.0071/);
    assert.match(out, /2 unpriced/);
  });

  test('a fully priced session is exactly what it always was', () => {
    const out = statusLine({ ...base, costUsd: 0.0071, unpricedRequests: 0 }, p);
    assert.match(out, /\$0\.0071/);
    assert.ok(!/≥/.test(out), `a complete total should not be hedged: ${out}`);
    assert.ok(!/unpriced/.test(out));
  });

  test('a genuinely free priced session still shows zero, because that is true', () => {
    const out = statusLine({ ...base, costUsd: 0, unpricedRequests: 0 }, p);
    assert.match(out, /\$0\.0000/);
  });

  test('a caller that knows nothing about pricing is unchanged', () => {
    // `unpricedRequests` is optional; omitting it must not turn a real figure
    // into a hedge.
    assert.match(statusLine({ ...base, costUsd: 0.5 }, p), /\$0\.5000/);
    assert.equal(statusLine({ ...base }, p).includes('$'), false);
  });
});

describe('a tool line when the arguments were too big to keep whole', () => {
  test('the path is recovered from a summary that is not valid JSON', () => {
    // `summarizeArgs` no longer produces one of these, and this is the guard for
    // everything that still can: an event log written by an older build, or a
    // caller that assembles the field itself. The old behaviour printed the raw
    // prefix, which for a `Write` is the beginning of the file's contents — the
    // one argument nobody wants on a transcript line, in place of the one they do.
    const truncated = '{"content":"\'use strict\';\\n\\n/**\\n * A long file…';
    assert.equal(summariseArgs('Write', truncated).includes('use strict'), true, 'the premise');

    const withPath = '{"path":"src/parse.js","content":"\'use strict\';\\n\\n/**\\n * A long…';
    assert.equal(summariseArgs('Write', withPath), 'src/parse.js');
  });

  test('an escaped path survives the recovery', () => {
    assert.equal(summariseArgs('Write', '{"path":"src/a\\"b.js","content":"x'), 'src/a"b.js');
  });

  test('a summary that parses is unaffected, whatever order the keys came in', () => {
    assert.equal(summariseArgs('Write', '{"content":"x","path":"src/b.js"}'), 'src/b.js');
    assert.equal(summariseArgs('Write', '{"path":"src/b.js","content":"x"}'), 'src/b.js');
  });
});

describe('results, when several tools ran at once', () => {
  const events = (renderer: SessionRenderer, out: () => string): string => {
    renderer.on('turn.started', {});
    renderer.on('tool.call', { toolCallId: 'a', name: 'Write', argsSummary: '{"path":"src/one.js"}' });
    renderer.on('tool.call', { toolCallId: 'b', name: 'Write', argsSummary: '{"path":"src/two.js"}' });
    renderer.on('tool.result', { toolCallId: 'b', contentBytes: 2048 });
    renderer.on('tool.result', { toolCallId: 'a', contentBytes: 731 });
    return out();
  };

  test('each result names the call it belongs to', () => {
    // A model that calls three tools in one step produces three call lines and
    // then three result lines, in whatever order they finished. A real session
    // wrote three files and reported `731 B`, `2.2 kB`, `2.0 kB` underneath, with
    // nothing saying which size was which file — and the results came back in a
    // different order from the calls, so reading them positionally was wrong.
    let written = '';
    const renderer = new SessionRenderer({
      write: (s) => (written += s),
      palette: plain,
      glyphs: glyphs(true),
      live: false,
    });
    const out = events(renderer, () => written);
    assert.match(out, /⎿ {2}Write\(src\/two\.js\) · 2\.0 kB/);
    assert.match(out, /⎿ {2}Write\(src\/one\.js\) · 731 B/);
  });

  test('a lone call is not labelled, because there is nothing to disambiguate', () => {
    // The label is worth four words on a line only when it answers a question.
    // On every line of an ordinary transcript it would be noise.
    let written = '';
    const renderer = new SessionRenderer({
      write: (s) => (written += s),
      palette: plain,
      glyphs: glyphs(true),
      live: false,
    });
    renderer.on('turn.started', {});
    renderer.on('tool.call', { toolCallId: 'a', name: 'Read', argsSummary: '{"path":"a.ts"}' });
    renderer.on('tool.result', { toolCallId: 'a', contentBytes: 12 });
    assert.equal(written, '⏺ Read(a.ts)\n  ⎿  12 B\n');
  });

  test('the batch is forgotten once it has finished, so the next call is bare', () => {
    let written = '';
    const renderer = new SessionRenderer({
      write: (s) => (written += s),
      palette: plain,
      glyphs: glyphs(true),
      live: false,
    });
    events(renderer, () => written);
    written = '';
    renderer.on('tool.call', { toolCallId: 'c', name: 'Read', argsSummary: '{"path":"a.ts"}' });
    renderer.on('tool.result', { toolCallId: 'c', contentBytes: 12 });
    assert.equal(written, '⏺ Read(a.ts)\n  ⎿  12 B\n');
  });
});

describe('two model requests in one turn', () => {
  test('the second does not continue the first mid-sentence', () => {
    // Seen on a real run: `Let me begin.Empty workspace. I'll scaffold the whole
    // project.` — two requests one step apart. The first ended without a newline,
    // its tail sat in the stream's buffer, and the second's first delta was
    // appended to it. `tool.call` already flushed for this reason; a step that
    // produces text and no tool call had nothing.
    let answer = '';
    const renderer = new SessionRenderer({
      write: () => {},
      writeAnswer: (s) => (answer += s),
      palette: plain,
      answerPalette: plain,
      glyphs: glyphs(true),
      live: false,
    });
    renderer.on('turn.started', {});
    renderer.on('model.stream', { type: 'text_delta', text: 'Let me begin.' });
    renderer.on('model.request.completed', { usage: {} });
    renderer.on('model.request.started', {});
    renderer.on('model.stream', { type: 'text_delta', text: 'Empty workspace.\n' });
    renderer.on('turn.completed', {});
    assert.equal(answer, 'Let me begin.\nEmpty workspace.\n');
  });
});

describe('wrapping a line that is a table, not a sentence', () => {
  test('the runs between the words survive, so a padded column stays a column', () => {
    // `wrapText` splits on `/\s+/` and rejoins with one space, which is right for
    // prose and wrong for the approval box: any row long enough to wrap came back
    // with its label padding collapsed, so `action   : …` became `action : …` and
    // the column was ragged in exactly the rows that needed reading most.
    const wrapped = wrapRuns('action   : run something quite long indeed', 24);
    assert.deepEqual(wrapped, ['action   : run something', 'quite long indeed']);
    assert.ok(
      wrapped.every((line) => visibleWidth(line) <= 24),
      'a wrapped line overran',
    );
    // The point of the whole thing: `wrapText` gives back `action : run …`.
    assert.equal(wrapText('action   : run something quite long indeed', 24)[0], 'action : run something');
  });

  test('a line that fits comes back untouched', () => {
    assert.deepEqual(wrapRuns('tool     : Shell', 40), ['tool     : Shell']);
  });
});

describe('which end of a long path to keep', () => {
  test('a path keeps its tail, because that is the part that identifies it', () => {
    // Five parallel reads on a real run were each labelled
    // `Read(~/Desktop/project…)` — five identical labels on a line
    // whose whole job was to tell them apart.
    assert.equal(
      summariseArgs('Read', '{"path":"/home/me/Desktop/logmap/src/format.js"}', 24),
      '…op/logmap/src/format.js',
    );
    assert.equal(truncatePath('/a/very/long/path/to/thing.js', 12), '…to/thing.js');
    assert.equal(truncatePath('short.js', 40), 'short.js', 'a short path is untouched');
  });

  test('anything that is not a path still keeps its head', () => {
    // A search pattern, a query, a command: the front is the part being read.
    assert.equal(summariseArgs('Grep', '{"pattern":"an extremely long search pattern"}', 12), 'an extremel…');
  });

  test('the elision is on a character boundary, so a wide glyph is never halved', () => {
    const cut = truncatePath('/项目/我的代码/文件.ts', 10);
    assert.ok(visibleWidth(cut) <= 10, `${visibleWidth(cut)} columns`);
    assert.equal(cut.includes('�'), false, 'a character was cut in half');
    assert.ok(cut.endsWith('.ts'), `the tail was not kept: ${cut}`);
  });
});

describe('a cost too small to round to a cent', () => {
  test('a real charge never renders as zero', () => {
    // Seen on the recording that went into the README: `3.5k tokens · $0.0000`,
    // on a session that was being billed. `toFixed(4)` on 4e-5 is `0.0000`, and
    // zero on its own reads as free — which is the exact sentence `costParts`
    // was already written to avoid one level up. The fix had stopped at the
    // case it was looking at.
    assert.equal(formatCost(0.00004), '<$0.0001');
    assert.equal(formatCost(0.000049), '<$0.0001');
    assert.equal(formatCost(0.0001), '$0.0001');
    assert.equal(formatCost(0.4213), '$0.4213');
  });

  test('and an actual zero still says zero, because that is true', () => {
    assert.equal(formatCost(0), '$0.0000');
  });

  test('the line the user reads uses it too, not just the spinner', () => {
    const line = statusLine({ model: 'm', requests: 1, tokens: 10, costUsd: 0.00004 }, plain);
    assert.match(line, /<\$0\.0001/);
    assert.equal(line.includes('$0.0000'), false, 'a billed session was reported as free');
  });
});

describe('why a call was refused, not just that it was', () => {
  test('the kernel-authored reason is shown beside the code', () => {
    // The asymmetry: a schema failure tells the *model* `$.limit is not an
    // allowed property (expected one of: path, offsetLine, limitLines)` and
    // told the person watching `TOOL_INVALID_ARGS`. The party that could act on
    // it got the detail; the party supervising got a code.
    const line = toolResultLine(
      { isError: true, errorCode: 'TOOL_INVALID_ARGS', why: '$.limit is not an allowed property' },
      plain,
      glyphs(true),
    );
    assert.equal(line, '  ⎿  TOOL_INVALID_ARGS — $.limit is not an allowed property');
  });

  test('a result with no kernel reason is exactly what it was', () => {
    // Most failures are a tool's own, and a tool's output is not this line's to
    // print: it is redacted, bounded and gated behind `--verbose` (ADR-0031).
    assert.equal(
      toolResultLine({ isError: true, errorCode: 'TOOL_FAILED' }, plain, glyphs(true)),
      '  ⎿  TOOL_FAILED',
    );
    assert.equal(toolResultLine({ contentBytes: 12 }, plain, glyphs(true)), '  ⎿  12 B');
  });

  test('the renderer takes it off the event, where the session puts it', () => {
    let written = '';
    const renderer = new SessionRenderer({
      write: (s) => (written += s),
      palette: plain,
      glyphs: glyphs(true),
      live: false,
    });
    renderer.on('turn.started', {});
    renderer.on('tool.call', { toolCallId: 'c1', name: 'Read', argsSummary: '{"path":"a.ts"}' });
    renderer.on('tool.result', {
      toolCallId: 'c1',
      isError: true,
      errorCode: 'TOOL_INVALID_ARGS',
      safeMessage: '$.limit is not an allowed property',
    });
    assert.match(written, /TOOL_INVALID_ARGS — \$\.limit is not an allowed property/);
  });
});
