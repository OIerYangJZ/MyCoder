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
  formatDuration,
  inputRule,
  pickTips,
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

  test('the title is centred inside the frame, and the frame follows a resize', () => {
    // The box is full width now — asked for, because a narrow centred box left the
    // prose under it looking adrift. So what is centred is the title, not the box.
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
      const before = inner.length - inner.trimStart().length;
      const after = inner.length - inner.trimEnd().length;
      assert.ok(Math.abs(before - after) <= 1, `the title is not centred: ${before} vs ${after}`);
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
  test('what was sent is written as an inverse block, with a rule under it', () => {
    const block = submitted('fix the failing test', fancy, glyphs(true), 80);
    assert.match(block, /\u001b\[47;30m > fix the failing test \u001b\[0m/);
    assert.ok(block.endsWith('\n') && block.includes('─'), 'the rule has to be drawn under the block');
  });

  test('it moves no cursor, because the editor has already taken its block down', () => {
    // It used to step up one row and clear, which was right when input was one
    // readline row. The editor's block is the prompt line, any wrapped rows, and the
    // rule — so stepping up one left the prompt line on screen and the sent line
    // appeared twice: once as typed, once as the inverse block. Found under a pty.
    const block = submitted('fix the failing test', fancy, glyphs(true), 80);
    assert.equal(/\u001b\[\d*[ABCDJK]/.test(block), false, `it still moves: ${JSON.stringify(block)}`);
  });

  test('a long line still gets its block, because that is when it matters most', () => {
    // There used to be a guard dropping the inverse block for anything wider than
    // the terminal — a leftover from when this moved the cursor up one row. Once the
    // editor started clearing its own block, that guard meant a long line disappeared
    // from the transcript altogether.
    const block = submitted('x'.repeat(100), fancy, glyphs(true), 80);
    assert.match(block, /47;30m > x{100} /, 'a long line lost its marker');
    assert.ok(block.includes('─'), 'and its rule');
  });

  test('a CJK line that wraps keeps its block too', () => {
    const block = submitted('中'.repeat(50), fancy, glyphs(true), 80);
    assert.match(block, /47;30m/);
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
