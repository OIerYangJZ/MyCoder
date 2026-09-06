/**
 * The interactive approval prompt (spec §11.4, `src/cli/prompter.ts`).
 *
 * The *text* of an approval is covered in `tests/integration/control-plane.test.ts`,
 * against `renderApproval`. This file is about the part that touches the terminal,
 * and it exists because of one defect that made the prompt nearly unusable:
 *
 * The renderer starts a spinner on `tool.call` and the spinner erases its own line
 * every 90ms with carriage-return and erase-to-end-of-line. An approval prompt opens
 * *during* that tool call, so every tick wiped the line the user was typing on. The
 * keystrokes reached readline — pressing Enter worked — but nothing was visible, and
 * the text left on screen was `⠹ Running Shell` with the cursor after it. Reported
 * as "I have to type y/n after Thinking… and I cannot see what I type", which is
 * exactly what it looks like from outside.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { EventEmitter } from 'node:events';

import { TerminalApprovalPrompter, approvalChoices, renderApproval } from '../../src/cli/prompter.ts';
import { box, glyphs, palette, visibleWidth } from '../../src/cli/render.ts';
import type { ApprovalRequest } from '../../src/tools/runtime.ts';

const REQUEST: ApprovalRequest = {
  subject: {
    key: 'Shell:npm:install',
    title: 'Run npm install zod',
    details: ['command: npm install zod', 'directory: .'],
    risk: 'high',
  },
  toolName: 'Shell',
  toolCallId: 'call_1',
  pending: [],
};

/** A readline stand-in that records what it was asked and answers from a script. */
function fakeRl(answers: readonly string[], onQuestion?: () => void) {
  const asked: string[] = [];
  let index = 0;
  return {
    asked,
    // eslint-disable-next-line @typescript-eslint/require-await
    question: async (prompt: string): Promise<string> => {
      asked.push(prompt);
      onQuestion?.();
      return answers[index++] ?? 'n';
    },
    pause: () => {},
    resume: () => {},
  };
}

const ESC = String.fromCharCode(27);

/** A stdin stand-in with the three methods the menu drives it through. */
function fakeKeys() {
  const bus = new EventEmitter();
  return {
    on: (e: 'data', l: (c: Buffer | string) => void) => void bus.on(e, l),
    off: (e: 'data', l: (c: Buffer | string) => void) => void bus.off(e, l),
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    send: (s: string) => bus.emit('data', Buffer.from(s)),
  };
}

describe('the approval prompt and the terminal', () => {
  test('whatever else is drawing on the terminal is stopped before anything is asked', () => {
    // The ordering is the whole point: `quiet` has to run before the frame is
    // written, not merely before the question, or the first tick lands between the
    // two and eats the top of the box.
    const order: string[] = [];
    const rl = fakeRl(['y'], () => order.push('question'));
    const prompter = new TerminalApprovalPrompter({
      rl: rl as never,
      write: () => order.push('write'),
      quiet: () => order.push('quiet'),
      palette: palette(false),
      glyphs: glyphs(false),
    });

    return prompter.request(REQUEST).then(() => {
      assert.equal(order[0], 'quiet', `nothing may draw before the prompt: ${order.join(' → ')}`);
      assert.ok(order.indexOf('quiet') < order.indexOf('write'));
      assert.ok(order.indexOf('write') < order.indexOf('question'));
    });
  });

  test('it is quietened again on every re-ask, not only the first', async () => {
    // An unrecognised answer loops. The spinner is restarted by any event that
    // arrives in between, so each pass has to quieten again — the second prompt is
    // no more typeable than the first if it does not.
    const order: string[] = [];
    const rl = fakeRl(['what', 'y'], () => order.push('question'));
    const prompter = new TerminalApprovalPrompter({
      rl: rl as never,
      write: () => order.push('write'),
      quiet: () => order.push('quiet'),
      palette: palette(false),
      glyphs: glyphs(false),
    });

    await prompter.request(REQUEST);
    // Stated as the invariant rather than a count: every question is immediately
    // preceded by a quiet. A count would have to be revised every time the prompt
    // gains or loses a line, which is how a test stops describing anything.
    const questions = order.reduce<number[]>((at, o, i) => (o === 'question' ? [...at, i] : at), []);
    assert.equal(questions.length, 2, 'the unrecognised answer should have looped');
    for (const at of questions) {
      assert.equal(order[at - 1], 'quiet', `question at ${at} was not quietened: ${order.join(' → ')}`);
    }
  });

  test('a prompter with nothing to quieten still works', async () => {
    // `quiet` is optional: the scripted and piped paths have no spinner at all.
    const rl = fakeRl(['s']);
    const prompter = new TerminalApprovalPrompter({ rl: rl as never, write: () => {} });
    const outcome = await prompter.request(REQUEST);
    assert.deepEqual(outcome, { decision: 'allow', scope: 'session' });
  });

  test('with a terminal it is a menu, and Enter alone still denies', async () => {
    // The default has to survive the change of shape. Pressing Enter without reading
    // the box granted nothing before and must grant nothing now, so the highlight
    // starts on the first denying answer rather than on the first answer.
    const input = fakeKeys();
    const prompter = new TerminalApprovalPrompter({
      rl: fakeRl([]) as never,
      write: () => {},
      keys: input,
      palette: palette(false),
      glyphs: glyphs(false),
    });
    const outcome = prompter.request(REQUEST);
    input.send('\r');
    assert.deepEqual(await outcome, { decision: 'deny', scope: 'once' });
  });

  test('the arrows reach every answer, in the order they are shown', async () => {
    const run = async (keys: readonly string[]) => {
      const input = fakeKeys();
      const prompter = new TerminalApprovalPrompter({
        rl: fakeRl([]) as never,
        write: () => {},
        keys: input,
        palette: palette(false),
        glyphs: glyphs(false),
      });
      const outcome = prompter.request(REQUEST);
      for (const key of keys) input.send(key);
      return outcome;
    };

    const UP = `${ESC}[A`;
    const DOWN = `${ESC}[B`;
    // The highlight starts on `No`, the third of four.
    assert.deepEqual(await run([UP, UP, '\r']), { decision: 'allow', scope: 'once' }, 'Yes');
    assert.deepEqual(await run([UP, '\r']), { decision: 'allow', scope: 'session' }, "Yes, don't ask");
    assert.deepEqual(await run(['\r']), { decision: 'deny', scope: 'once' }, 'No');
    assert.equal((await run([DOWN, '\r'])).scope, 'session', "No, don't ask");
  });

  test('abandoning the menu denies, because that is the safe reading of leaving', async () => {
    for (const key of [ESC, String.fromCharCode(3)]) {
      const input = fakeKeys();
      const prompter = new TerminalApprovalPrompter({
        rl: fakeRl([]) as never,
        write: () => {},
        keys: input,
        palette: palette(false),
        glyphs: glyphs(false),
      });
      const outcome = prompter.request(REQUEST);
      input.send(key);
      assert.deepEqual(await outcome, { decision: 'deny', scope: 'once' });
    }
  });

  test('the lasting answers name the subject, so the screen says what is remembered', () => {
    const labels = approvalChoices(REQUEST).map((c) => c.label);
    assert.deepEqual(labels[0], 'Yes');
    assert.match(labels[1] ?? '', /don't ask again for: Run npm install zod/);
    assert.deepEqual(labels[2], 'No');
    assert.match(labels[3] ?? '', /^No, and don't ask again/);
  });

  test('readline is paused for the menu and resumed afterwards', async () => {
    // Otherwise readline eats the arrow keys before the menu sees them.
    const events: string[] = [];
    const input = fakeKeys();
    const rl = {
      ...fakeRl([]),
      pause: () => events.push('pause'),
      resume: () => events.push('resume'),
    };
    const prompter = new TerminalApprovalPrompter({
      rl: rl as never,
      write: () => {},
      keys: input,
      palette: palette(false),
      glyphs: glyphs(false),
    });
    const outcome = prompter.request(REQUEST);
    input.send('\r');
    await outcome;
    assert.deepEqual(events, ['pause', 'resume']);
  });

  test('the answers map to the four scopes, and Enter alone denies', async () => {
    const run = async (answer: string) => {
      const prompter = new TerminalApprovalPrompter({
        rl: fakeRl([answer]) as never,
        write: () => {},
      });
      return prompter.request(REQUEST);
    };

    assert.deepEqual(await run('y'), { decision: 'allow', scope: 'once' });
    assert.deepEqual(await run('s'), { decision: 'allow', scope: 'session' });
    assert.deepEqual(await run('n'), { decision: 'deny', scope: 'once' });
    assert.equal((await run('d')).scope, 'session');
    // The default is denial, deliberately.
    assert.deepEqual(await run(''), { decision: 'deny', scope: 'once' });
  });
});

describe('the label column, all the way down the box', () => {
  const shellRequest = {
    toolName: 'Shell',
    toolCallId: 'call_1' as never,
    subject: {
      key: 'process.exec:npm:test',
      title: 'Run npm test',
      // A tool writes its own details, and they are `key: value` by convention.
      details: ['command: npm test', 'directory: .', 'network: none requested'],
      risk: 'low' as const,
    },
    pending: [],
  };

  test("a tool's own details line up with the labels this function owns", () => {
    // They did not, and it showed on the one screen a user is *required* to read:
    //
    //     tool     : Shell
    //     action   : Run npm test
    //     command: npm test        <- the tool wrote this one
    //     directory: .
    //     scope    : this call only, …
    //
    // Half the box padded by this function, half passed through as the tool wrote
    // it. Both halves were right on their own terms, which is how it survived.
    const text = renderApproval(shellRequest as never);
    const colons = [...text.matchAll(/^ {2}\S.*?\s:(?= |$)/gm)].map((m) => m[0].length);
    assert.ok(colons.length >= 5, `too few labelled rows to be a column: ${colons.length}`);
    assert.equal(new Set(colons).size, 1, `the label column is ragged: ${colons.join(', ')}`);
  });

  test('a detail that is not a label is left exactly as the tool wrote it', () => {
    // Conservative on purpose: the text of an approval is a security surface and
    // this is presentation only. Anything that is not plainly `key: value` is
    // passed through rather than guessed at.
    const prose = 'This command was seen to reach the network on a previous run.';
    const text = renderApproval({
      ...shellRequest,
      subject: { ...shellRequest.subject, details: [prose, 'command: npm test'] },
    } as never);
    assert.ok(text.includes(`  ${prose}`), `the prose detail was reformatted: ${text}`);
  });

  test('a wrapped row keeps its padding, so the column survives the frame', () => {
    // `box` used to re-flow with `wrapText`, which splits on `/\s+/` and rejoins
    // with one space — so any row long enough to wrap lost the padding this
    // function had just given it.
    const long = 'x'.repeat(90);
    const framed = box(
      renderApproval({
        ...shellRequest,
        subject: { ...shellRequest.subject, title: `Run ${long}` },
      } as never).split('\n'),
      palette(false),
      glyphs(true),
      70,
    );
    // The colons still line up *inside* the frame, which is the thing the wrap
    // used to destroy: `wrapText` rejoins on one space, so `action    : …` came
    // back as `action : …` on exactly the rows long enough to need wrapping.
    const rows = framed
      .split('\n')
      .map((line) => line.slice(2, -2))
      .filter((line) => /^ {2}\S.*?\s:(?= |$)/.test(line));
    const colons = rows.map((line) => (/^ {2}\S.*?\s:(?= |$)/.exec(line) ?? [''])[0].length);
    assert.ok(colons.length >= 4, `too few labelled rows survived the frame: ${colons.length}`);
    assert.equal(new Set(colons).size, 1, `the column went ragged in the frame: ${colons.join(', ')}`);

    const widths = new Set(framed.split('\n').map(visibleWidth));
    assert.equal(widths.size, 1, `the frame went ragged: ${[...widths].join(', ')}`);
  });
});

describe('who is holding stdin', () => {
  test('the arrow-key path never opens a readline interface', async () => {
    // Found by redirecting stdout on a real run and reading the file: the first
    // line of it was the *task the user had typed*. A `terminal: true` readline
    // attaches its own listener to stdin and echoes every printable character to
    // its output — and one was being created up front for a typed fallback that,
    // on an interactive terminal, is unreachable. The editor sets raw mode and
    // resumes the same stream, so readline saw every key and wrote it to stdout,
    // which `docs/cli-contract.md` reserves for the payload. It also printed its
    // own `> ` each time the menu handed the terminal back.
    let opened = 0;
    const source = new EventEmitter() as EventEmitter & {
      setRawMode: () => void;
      resume: () => void;
      pause: () => void;
    };
    source.setRawMode = (): void => {};
    source.resume = (): void => {};
    source.pause = (): void => {};

    const prompter = new TerminalApprovalPrompter({
      openRl: () => {
        opened += 1;
        return fakeRl(['y']) as never;
      },
      write: () => {},
      keys: source as never,
    });

    const answer = prompter.request(REQUEST);
    // Enter, on the answer the menu starts on.
    source.emit('data', '\r');
    await answer;
    assert.equal(opened, 0, 'the menu path opened a readline interface it never used');
  });

  test('with no arrows and no way to open one, the answer is denial', async () => {
    // The same rule `select` follows: a prompt that cannot ask must not answer.
    const prompter = new TerminalApprovalPrompter({ write: () => {} });
    const outcome = await prompter.request(REQUEST);
    assert.equal(outcome.decision, 'deny');
  });

  test('the typed path opens one, once, and asks on it', async () => {
    let opened = 0;
    const rl = fakeRl(['y']);
    const prompter = new TerminalApprovalPrompter({
      openRl: () => {
        opened += 1;
        return rl as never;
      },
      write: () => {},
    });
    assert.equal((await prompter.request(REQUEST)).decision, 'allow');
    assert.equal((await prompter.request(REQUEST)).decision, 'deny', 'the script is exhausted');
    assert.equal(opened, 1, 'a second interface was opened for the second question');
  });
});

describe('"no — do this instead"', () => {
  test('the answer exists, and it is the only one that asks a follow-up', () => {
    // Refusing used to be a dead end: four answers, all of them yes or no, and
    // the only way to say *why* was to let the turn fail and start another. But
    // somebody declining a command almost always knows what they wanted instead,
    // and the model is about to guess.
    const choices = approvalChoices(REQUEST);
    const withReason = choices.filter((c) => c.needsReason);
    assert.equal(withReason.length, 1, 'exactly one answer should stop to ask');
    assert.equal(withReason[0]?.outcome.decision, 'deny', 'it is a refusal, not a conditional yes');
    assert.match(withReason[0]?.label ?? '', /differently/);
  });

  test('the default answer is still No, and still costs one keystroke', () => {
    // The new choice must not become what Enter lands on, and must not make the
    // common answers slower.
    const choices = approvalChoices(REQUEST);
    const initial = choices.findIndex((c) => c.outcome.decision === 'deny');
    assert.equal(choices[initial]?.label, 'No');
    assert.equal(choices[initial]?.needsReason, undefined);
  });

  test('what the user typed becomes the reason the model is given', async () => {
    const prompter = new TerminalApprovalPrompter({
      openRl: () => fakeRl(['r', 'use node -e instead of sed']) as never,
      write: () => {},
    });
    const outcome = await prompter.request(REQUEST);
    assert.equal(outcome.decision, 'deny');
    assert.equal(outcome.reason, 'use node -e instead of sed');
  });

  test('an empty answer is a plain refusal, not an empty reason', async () => {
    // Somebody who changes their mind about explaining should not be made to
    // type something to get out of the prompt.
    const prompter = new TerminalApprovalPrompter({
      openRl: () => fakeRl(['r', '   ']) as never,
      write: () => {},
    });
    const outcome = await prompter.request(REQUEST);
    assert.equal(outcome.decision, 'deny');
    assert.equal(outcome.reason, undefined);
  });
});
