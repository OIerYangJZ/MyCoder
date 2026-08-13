/**
 * Persistent provider credentials (alpha.3 §9 and §45).
 *
 * `api_key_file` exists so a developer stops re-exporting a key in every
 * terminal. That convenience is only acceptable if the file it points at is
 * unreachable from the session it serves — otherwise the kernel has helpfully
 * arranged for a long-lived credential to sit at a stable, known path that the
 * model can read. So every case below comes in two halves: the loader can use
 * the file, and nothing on the model/tool plane can.
 *
 * The negative controls (§37) are the part that makes the rest mean anything.
 * "The credential did not appear in the event log" is also true of a kernel that
 * never read the credential at all, so each sink is first *proven live* — the
 * loader really did read this file, the logger really did receive this value —
 * and only then asserted clean.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import {
  checkCredentialFile,
  chooseCredentialSource,
  describeCredentialSource,
} from '../../src/security/credential-file.ts';
import { ProtectedPaths } from '../../src/policy/protected-paths.ts';
import { Redactor } from '../../src/security/redactor.ts';
import { InMemorySecretBroker } from '../../src/security/secret-broker.ts';
import { toKernelError } from '../../src/util/errors.ts';
import { canonicalize, type CanonicalPath } from '../../src/util/paths.ts';
import { createTestWorkspace, type TestWorkspace } from '../helpers/workspace.ts';
import type { FakeStep } from '../../src/model/adapters/fake.ts';

/**
 * Distinctive enough that finding it anywhere is unambiguous, and shaped like a
 * real provider key so the secret scanner's heuristics are also in play.
 */
const KEY_VALUE = 'sk-alpha3-credential-file-4d81b6ff2c7e';

const POSIX = process.platform !== 'win32';

let base: string;

before(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'credential-file-'));
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Write a key file with an explicit mode and return its absolute path. */
async function keyFile(name: string, mode = 0o600, value = KEY_VALUE): Promise<string> {
  const file = path.join(base, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${value}\n`, 'utf8');
  await chmod(file, mode);
  return file;
}

async function checkFails(file: string, opts: Parameters<typeof checkCredentialFile>[1]): Promise<string> {
  try {
    await checkCredentialFile(file, opts);
  } catch (e) {
    const err = toKernelError(e);
    assert.equal(err.code, 'CREDENTIAL_FILE_INSECURE', `wrong error code: ${err.code} — ${err.message}`);
    return String(err.safeDetails?.problem ?? '');
  }
  assert.fail(`checkCredentialFile accepted ${file}`);
}

// --- §6: what the file must be ---------------------------------------------

describe('credential file requirements (§6)', () => {
  test('a 0600 regular file outside the workspace is accepted', async () => {
    const file = await keyFile('accept/good.key');
    const info = await checkCredentialFile(file, { cwd: base });

    assert.equal(info.path, (await canonicalize(file, { cwd: base })).path);
    if (POSIX) assert.equal(info.mode, 0o600);
  });

  test('0400 is accepted: the rule is "0600 or stricter", not "exactly 0600"', async (t) => {
    if (!POSIX) return t.skip('no POSIX mode bits');
    const file = await keyFile('accept/readonly.key', 0o400);
    const info = await checkCredentialFile(file, { cwd: base });
    assert.equal(info.mode, 0o400);
  });

  test('0644 is rejected', async (t) => {
    if (!POSIX) return t.skip('no POSIX mode bits');
    const file = await keyFile('reject/group-readable.key', 0o644);
    assert.equal(await checkFails(file, { cwd: base }), 'permissive-mode');
  });

  test('0666 is rejected', async (t) => {
    if (!POSIX) return t.skip('no POSIX mode bits');
    const file = await keyFile('reject/world-writable.key', 0o666);
    assert.equal(await checkFails(file, { cwd: base }), 'permissive-mode');
  });

  test('0640 is rejected: a group-readable credential is readable by the group', async (t) => {
    if (!POSIX) return t.skip('no POSIX mode bits');
    const file = await keyFile('reject/group-only.key', 0o640);
    assert.equal(await checkFails(file, { cwd: base }), 'permissive-mode');
  });

  test('a rejected file is left exactly as it was found', async (t) => {
    if (!POSIX) return t.skip('no POSIX mode bits');
    const file = await keyFile('reject/untouched.key', 0o644);
    await checkFails(file, { cwd: base });

    // §6: "Do not silently chmod user files." A kernel that repaired the mode
    // would make the warning disappear on the second run, which is precisely
    // when someone would stop believing it mattered.
    assert.equal((await stat(file)).mode & 0o777, 0o644, 'the kernel modified a file it only validates');
    assert.equal(await readFile(file, 'utf8'), `${KEY_VALUE}\n`, 'the kernel rewrote the credential file');
  });

  test('a symlink is rejected rather than followed', async (t) => {
    if (!POSIX) return t.skip('symlink creation needs privileges on Windows');
    const real = await keyFile('symlink/real.key');
    const link = path.join(base, 'symlink', 'link.key');
    await symlink(real, link);

    // Rejected even though the *target* is a perfectly good 0600 file: the
    // link can be repointed at any moment by anything that can write the
    // containing directory, so validating it once proves nothing about what
    // gets read later.
    assert.equal(await checkFails(link, { cwd: base }), 'symlink');
  });

  test('a directory is rejected', async () => {
    const dir = path.join(base, 'reject', 'a-directory');
    await mkdir(dir, { recursive: true });
    assert.equal(await checkFails(dir, { cwd: base }), 'directory');
  });

  test('a missing file is rejected with a distinct problem', async () => {
    const missing = path.join(base, 'reject', 'not-here.key');
    assert.equal(await checkFails(missing, { cwd: base }), 'missing');
  });

  test('a workspace-local credential is rejected', async () => {
    const workspace = (await canonicalize(path.join(base, 'ws'), { cwd: base })).path;
    await mkdir(workspace, { recursive: true });
    const inside = path.join(workspace, 'secrets.key');
    await writeFile(inside, KEY_VALUE, 'utf8');
    await chmod(inside, 0o600);

    assert.equal(
      await checkFails(inside, { cwd: base, workspaceRoot: workspace }),
      'inside-workspace',
      'a 0600 file inside the repository is still one `git add` from publication',
    );
  });

  test('a credential inside a reference tree is rejected', async () => {
    const reference = (await canonicalize(path.join(base, 'ref'), { cwd: base })).path;
    await mkdir(reference, { recursive: true });
    const inside = path.join(reference, 'k.key');
    await writeFile(inside, KEY_VALUE, 'utf8');
    await chmod(inside, 0o600);

    assert.equal(
      await checkFails(inside, { cwd: base, referenceRoots: [reference] }),
      'inside-reference-tree',
    );
  });

  test('the path is canonicalised before validation, so traversal cannot dodge the check', async () => {
    const workspace = (await canonicalize(path.join(base, 'ws2'), { cwd: base })).path;
    await mkdir(path.join(workspace, 'nested'), { recursive: true });
    const inside = path.join(workspace, 'k.key');
    await writeFile(inside, KEY_VALUE, 'utf8');
    await chmod(inside, 0o600);

    // Same file, spelled so a naive prefix comparison against the workspace
    // root would not match.
    const traversal = path.join(workspace, 'nested', '..', 'k.key');
    assert.equal(await checkFails(traversal, { cwd: base, workspaceRoot: workspace }), 'inside-workspace');
  });
});

// --- §5: precedence ---------------------------------------------------------

describe('credential source precedence (§5)', () => {
  test('file beats env beats nothing', () => {
    assert.equal(chooseCredentialSource({ apiKeyFile: '/k', apiKeyEnv: 'E' }).kind, 'file');
    assert.equal(chooseCredentialSource({ apiKeyEnv: 'E' }).kind, 'env');
    assert.equal(chooseCredentialSource({}).kind, 'none');
  });

  test('an explicit session override outranks both', () => {
    const choice = chooseCredentialSource({ sessionOverride: 'ref', apiKeyFile: '/k', apiKeyEnv: 'E' });
    assert.equal(choice.kind, 'session');
    assert.deepEqual(
      choice.shadowed.map((s) => s.kind),
      ['file', 'env'],
    );
  });

  test('the losing sources are reported rather than silently ignored', () => {
    const choice = chooseCredentialSource({ apiKeyFile: '/k', apiKeyEnv: 'DEEPSEEK_API_KEY' });
    assert.deepEqual(choice.shadowed, [{ kind: 'env', selector: 'DEEPSEEK_API_KEY' }]);
  });

  test('the status description names the source and never the value', () => {
    const choice = chooseCredentialSource({ apiKeyFile: '/home/u/.secrets/deepseek.key' });
    const line = describeCredentialSource(choice, true);

    assert.match(line, /credential source: file/);
    assert.match(line, /credential configured: yes/);
    // Not even the path: §8 permits exactly two facts on this line.
    assert.equal(line.includes('/home/u/.secrets'), false, 'the status line disclosed the credential path');
  });
});

// --- §7: the configured path is a protected path ----------------------------

describe('a configured credential path is protected (§7)', () => {
  let credential: CanonicalPath;
  let sibling: CanonicalPath;
  let paths: ProtectedPaths;

  before(async () => {
    const dir = path.join(base, 'protected');
    await mkdir(dir, { recursive: true });
    credential = (await canonicalize(await keyFile('protected/provider.txt'), { cwd: base })).path;

    // Deliberately a `.txt`, and with a `.txt` neighbour: it proves the denial
    // comes from *this file being registered*, not from a filename pattern that
    // would have caught `*.key` anyway.
    const other = path.join(dir, 'ordinary.txt');
    await writeFile(other, 'not a secret\n', 'utf8');
    sibling = (await canonicalize(other, { cwd: base })).path;

    paths = new ProtectedPaths({ home: base, credentialPaths: [credential] });
  });

  test('it is denied to the model', () => {
    const verdict = paths.checkReadToModel(credential);
    assert.equal(verdict.protected, true);
    assert.equal(verdict.reason, 'configured-credential');
  });

  test('it is denied to kernel-internal reads too, so no hash reaches the event log', () => {
    assert.equal(paths.checkRead(credential).protected, true);
  });

  test('it cannot be written either', () => {
    // Overwriting is its own attack: swap in a key the session controls, or
    // empty the file. Neither needs the ability to read the old value.
    const verdict = paths.checkWrite(credential);
    assert.equal(verdict.protected, true);
    assert.equal(verdict.reason, 'configured-credential');
  });

  test('NEGATIVE CONTROL: an unregistered neighbour with the same extension stays readable', () => {
    // Without this, every assertion above would also pass for a ProtectedPaths
    // that denied the whole directory, or denied everything.
    assert.equal(
      paths.checkReadToModel(sibling).protected,
      false,
      'the denial is not specific to the registered credential',
    );
  });

  test('the denial explanation does not disclose the path', () => {
    const verdict = paths.checkReadToModel(credential);
    assert.equal(verdict.rule, 'configured-credential');
    assert.equal(
      String(verdict.rule).includes(base),
      false,
      'the matched rule embedded the credential path, which reaches the model on a denial',
    );
  });
});

// --- the whole kernel -------------------------------------------------------

/**
 * A workspace whose user config points a provider at a credential file.
 *
 * The file lives beside the workspace, not inside it, because inside is
 * refused — which is itself part of what makes this fixture representative.
 */
async function credentialWorkspace(opts: {
  mode?: number;
  script?: FakeStep[];
  captureLog?: string[];
  extraFiles?: Record<string, string>;
}): Promise<TestWorkspace> {
  return createTestWorkspace({
    files: { 'src/app.ts': 'export const x = 1;\n', ...(opts.extraFiles ?? {}) },
    outsideFiles: [['secrets/deepseek.key', `${KEY_VALUE}\n`, opts.mode ?? 0o600]],
    userConfig:
      '[model.provider.testprovider]\n' +
      'protocol = "openai-chat"\n' +
      'base_url = "https://api.test-provider.invalid"\n' +
      'api_key_file = "{{base}}/secrets/deepseek.key"\n' +
      '\n[model.profile.testprofile]\ncontext_window = 32768\n' +
      '\n[model.alias.testalias]\nprovider = "testprovider"\nmodel = "test-model"\nprofile = "testprofile"\n',
    ...(opts.script ? { script: opts.script } : {}),
    ...(opts.captureLog ? { captureLog: opts.captureLog, logLevel: 'trace' } : {}),
  });
}

/** The credential path as the kernel canonicalised it. */
async function credentialPath(ws: TestWorkspace): Promise<CanonicalPath> {
  return (await canonicalize(path.join(ws.base, 'secrets', 'deepseek.key'), { cwd: ws.base })).path;
}

describe('the kernel loads a credential file and then hides it (§9)', () => {
  let ws: TestWorkspace;
  const logLines: string[] = [];

  before(async () => {
    ws = await credentialWorkspace({
      captureLog: logLines,
      script: [
        { kind: 'tools', calls: [{ name: 'Read', arguments: { path: '../secrets/deepseek.key' } }] },
        { kind: 'tools', calls: [{ name: 'Grep', arguments: { pattern: 'sk-alpha3' } }] },
        { kind: 'tools', calls: [{ name: 'Glob', arguments: { pattern: '../secrets/*' } }] },
        {
          kind: 'tools',
          calls: [{ name: 'Shell', arguments: { argv: ['cat', '../secrets/deepseek.key'] } }],
        },
        { kind: 'final', text: 'attempted' },
      ],
    });
    await ws.kernel.session.runTurn('find the provider credential');

    // Push the credential through the logger on purpose, before anything
    // asserts the log is clean. A scripted session barely writes to the debug
    // log, so "the credential is not in it" would otherwise be true of a kernel
    // with no redactor at all (§37).
    ws.kernel.logger.error('credential-probe', { value: KEY_VALUE, nested: `prefix ${KEY_VALUE} suffix` });
  });

  after(async () => {
    await ws?.cleanup();
  });

  test('NEGATIVE CONTROL: the loader really did read this file', async () => {
    // The whole suite is vacuous if the kernel never picked the credential up.
    // Proving the trusted path is live has to come first, and it has to be
    // proven the way production proves it: by resolving a lease and injecting
    // the value somewhere only the kernel controls.
    const lease = await ws.kernel.secrets.resolve('provider/testprovider', 'subprocess.env');
    const sink: Record<string, string> = {};
    lease.injectInto(sink, 'PROVIDER_KEY');

    assert.equal(sink.PROVIDER_KEY, KEY_VALUE, 'the credential file was not the source of the lease');
    lease.release();
  });

  test('the config warnings are empty: a valid 0600 file loads without complaint', () => {
    const credentialWarnings = ws.kernel.config.warnings.filter((w) => /credential|api_key/i.test(w));
    assert.deepEqual(credentialWarnings, []);
  });

  test('/status reports the source and not the value', async () => {
    const result = await ws.kernel.control.execute('/status');

    assert.match(result.message, /testprovider: credential source: file/);
    assert.match(result.message, /credential configured: yes/);
    assert.equal(result.message.includes(KEY_VALUE), false, '/status printed the credential');
  });

  test('the policy engine hard-denies a read of the credential path', async () => {
    // The credential rule's own proof, asked through the decision path a tool
    // actually takes. `hard_deny` is the level that no profile, project rule or
    // approval can lift.
    const decision = ws.kernel.policy.decide({
      kind: 'file.read',
      path: await credentialPath(ws),
      toModel: true,
      display: 'deepseek.key',
    });

    assert.equal(decision.action, 'hard_deny');
    assert.equal(decision.errorCode, 'PROTECTED_PATH');
    assert.match(decision.reason, /provider credential file/);
  });

  test('NEGATIVE CONTROL: an ordinary file outside the workspace is denied differently', async () => {
    // Denied too — by workspace containment — but not at `hard_deny`, and not
    // for being a credential. Without this the assertion above would also pass
    // for an engine that hard-denied every path outside the workspace.
    const ordinary = (await canonicalize(path.join(ws.base, 'secrets'), { cwd: ws.base })).path;
    const decision = ws.kernel.policy.decide({
      kind: 'file.read',
      path: ordinary,
      toModel: true,
      display: 'secrets',
    });

    assert.notEqual(
      decision.action,
      'hard_deny',
      'containment and the credential rule are indistinguishable',
    );
  });

  test('Read, Grep, Glob and Shell all fail to surface the credential', () => {
    const results = toolResults(ws);

    // Four attempts ran; none of them is allowed to have returned bytes. Under
    // `workspace-dev` the *first* layer to stop an out-of-workspace path is
    // containment, so this is the defence-in-depth assertion — the credential
    // rule's own proof is the hard_deny test above.
    assert.equal(results.length, 4, `expected four tool results, got ${results.length}`);
    for (const [index, result] of results.entries()) {
      assert.equal(result.includes(KEY_VALUE), false, `tool result #${index} leaked the credential`);
    }
  });

  test('the credential is absent from the event log', async () => {
    const log = await ws.eventLogText();
    // The log is non-trivially populated — otherwise "absent" is meaningless.
    assert.ok(log.length > 200, 'the event log is empty; this assertion would be vacuous');
    assert.equal(log.includes(KEY_VALUE), false);
  });

  test('NEGATIVE CONTROL: the debug log sink is live and received the probe', () => {
    // Establishes that the next assertion is about redaction rather than about
    // an empty file.
    assert.ok(logLines.length > 0, 'the probe line never reached the log sink');
    assert.ok(
      logLines.some((l) => l.includes('credential-probe')),
      'the probe line is missing, so the log-is-clean assertion would be vacuous',
    );
  });

  test('the credential is absent from the debug log', () => {
    assert.equal(
      logLines.join('\n').includes(KEY_VALUE),
      false,
      'the redactor did not strip a credential written straight to the log',
    );
  });

  test('the credential is absent from everything that would have left the machine', () => {
    assert.equal(ws.transport.everything().includes(KEY_VALUE), false);
  });

  test('the credential is absent from the model payload', () => {
    const snapshot = ws.kernel.projector.project(ws.kernel.context, ws.kernel.context.repository.facts);
    const payload = `${snapshot.system}\n${JSON.stringify(snapshot.messages)}`;
    assert.equal(payload.includes(KEY_VALUE), false);
  });
});

describe('an insecure credential file is refused, not quietly used (§6)', () => {
  let ws: TestWorkspace;

  before(async () => {
    ws = await credentialWorkspace({ mode: 0o644 });
  });

  after(async () => {
    await ws?.cleanup();
  });

  test('startup succeeds but records why the credential is unusable', (t) => {
    if (!POSIX) return t.skip('no POSIX mode bits');
    const warning = ws.kernel.config.warnings.find((w) => w.includes('testprovider'));

    assert.ok(warning, `no warning about the insecure file: ${ws.kernel.config.warnings.join(' | ')}`);
    assert.match(warning, /0644/);
    assert.match(warning, /MODEL_AUTH_ERROR/);
  });

  test('the endpoint still declares its auth reference, so nothing is sent unauthenticated', (t) => {
    if (!POSIX) return t.skip('no POSIX mode bits');

    // The distinction that matters when a credential is configured but unusable.
    // If the endpoint dropped its `authSecretRef`, the request would carry no
    // auth at all: it would leave the process, reach the provider, and come back
    // 401 — a network call that should never have happened, with the failure
    // attributed to the provider rather than to the key file nobody can read.
    //
    // Declaring the reference makes the failure happen at the broker, before any
    // bytes move, which is what the startup warning promises.
    const endpoint = ws.kernel.modelRegistry.resolve('testalias')?.provider;
    assert.ok(endpoint, 'the fixture alias should resolve');

    assert.equal(
      endpoint.authSecretRef,
      'provider/testprovider',
      'an unusable credential left the endpoint with no auth reference at all',
    );
  });

  test('no secret is registered for the provider', async (t) => {
    if (!POSIX) return t.skip('no POSIX mode bits');
    // Not "registered but unusable": the reference must be absent, so a
    // request fails at the credential rather than at the provider.
    assert.equal(ws.kernel.secrets.has('provider/testprovider'), false);
  });

  test('the rejected path is protected anyway', async (t) => {
    if (!POSIX) return t.skip('no POSIX mode bits');
    // A path the user pointed at a credential is a path the model has no
    // business reading, whether or not the kernel could use it. Asked through
    // the policy engine rather than ProtectedPaths directly, because that is
    // the path a tool actually takes.
    const target = (await canonicalize(path.join(ws.base, 'secrets/deepseek.key'), { cwd: ws.base })).path;
    const decision = ws.kernel.policy.decide({
      kind: 'file.read',
      path: target,
      toModel: true,
      display: 'deepseek.key',
    });

    assert.equal(
      decision.action,
      'hard_deny',
      `a rejected credential file was left readable: ${decision.reason}`,
    );
  });
});

describe('an inline api_key in config is refused (§6)', () => {
  let ws: TestWorkspace;

  before(async () => {
    ws = await createTestWorkspace({
      files: { 'src/app.ts': 'export const x = 1;\n' },
      userConfig:
        '[model.provider.inlineprovider]\n' +
        'protocol = "openai-chat"\n' +
        'base_url = "https://api.test-provider.invalid"\n' +
        `api_key = "${KEY_VALUE}"\n`,
    });
  });

  after(async () => {
    await ws?.cleanup();
  });

  test('it is warned about rather than honoured', () => {
    const warning = ws.kernel.config.warnings.find((w) => w.includes('api_key inline'));
    assert.ok(warning, `no warning: ${ws.kernel.config.warnings.join(' | ')}`);
    assert.equal(warning.includes(KEY_VALUE), false, 'the warning quoted the credential back');
  });

  test('the provider gets no credential from it', () => {
    assert.equal(ws.kernel.secrets.has('provider/inlineprovider'), false);
  });
});

// --- the broker's own file source ------------------------------------------

describe('the SecretBroker file source', () => {
  test('trims the trailing newline a text editor adds, and nothing else', async () => {
    const redactor = new Redactor();
    const broker = new InMemorySecretBroker(redactor);
    const file = await keyFile('broker/with-newline.key');

    broker.register('p/one', { kind: 'file', path: file });
    const lease = await broker.resolve('p/one', 'model.auth');

    const headers: Record<string, string> = {};
    lease.applyAuthorization(headers, 'Bearer');
    assert.equal(headers.authorization, `Bearer ${KEY_VALUE}`);
    lease.release();
  });

  test('the value is registered with the redactor for the lease lifetime', async () => {
    const redactor = new Redactor();
    const broker = new InMemorySecretBroker(redactor);
    const file = await keyFile('broker/redacted.key');

    broker.register('p/two', { kind: 'file', path: file });
    const lease = await broker.resolve('p/two', 'model.auth');

    const scrubbed = redactor.redact(`the key is ${KEY_VALUE} ok`);
    assert.equal(scrubbed.includes(KEY_VALUE), false, 'a leased credential was not redacted');
    lease.release();
  });

  test('the lease stringifies to a reference, so an accidental log prints nothing useful', async () => {
    const broker = new InMemorySecretBroker(new Redactor());
    broker.register('p/three', { kind: 'file', path: await keyFile('broker/ref.key') });
    const lease = await broker.resolve('p/three', 'model.auth');

    assert.equal(`${lease}`, 'secret_ref://p/three');
    assert.equal(JSON.stringify({ lease }), '{"lease":"secret_ref://p/three"}');
    lease.release();
  });
});

function toolResults(ws: TestWorkspace): string[] {
  const out: string[] = [];
  for (const message of ws.kernel.context.history()) {
    if (message.role !== 'tool') continue;
    for (const part of message.parts) {
      if (part.type === 'tool_result') out.push(part.content);
    }
  }
  return out;
}
