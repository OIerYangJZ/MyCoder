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

import { TerminalApprovalPrompter, approvalChoices } from '../../src/cli/prompter.ts';
import { glyphs, palette } from '../../src/cli/render.ts';
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
