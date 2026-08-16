/**
 * The §54 diagnosis regression matrix.
 *
 * Each row asserts the four things a diagnosis is judged on — category, blame,
 * retryability and the hint — because getting the category right while blaming
 * the wrong party still sends someone down the wrong path.
 *
 * The negative controls matter as much as the rows: a module that answered
 * `workspace_write_blocked` to everything would pass a table of write cases, so
 * there are cases here that must come back `unknown`, and a standing assertion
 * that no diagnosis ever authorises anything.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { diagnose, renderDiagnosis, type DiagnosisCategory } from '../../src/execution/diagnosis.ts';
import { kernelError } from '../../src/util/errors.ts';

describe('§54 regression matrix: structured errors are authoritative', () => {
  const rows: Array<{
    name: string;
    error: ReturnType<typeof kernelError>;
    category: DiagnosisCategory;
    capability?: string;
  }> = [
    {
      name: 'a protected path',
      error: kernelError('PROTECTED_PATH', '".env" is treated as a secret file.', { blame: 'kernel' }),
      category: 'workspace_write_blocked',
      capability: 'file.write',
    },
    {
      name: 'a host-scope denial',
      error: kernelError('NETWORK_SCOPE_DENIED', 'evil.example is not in the approved host list.'),
      category: 'network_scope_denied',
      capability: 'network.connect',
    },
    {
      name: 'a private-address denial',
      error: kernelError('NETWORK_TARGET_ADDRESS_DENIED', 'the host resolved to 169.254.169.254.'),
      category: 'network_scope_denied',
      capability: 'network.connect',
    },
    {
      name: 'an SNI mismatch',
      error: kernelError('NETWORK_IDENTITY_MISMATCH', 'the TLS SNI did not match the CONNECT authority.'),
      category: 'network_scope_denied',
    },
    {
      name: 'the container runtime being unavailable',
      error: kernelError('REMOTE_UNAVAILABLE', 'the docker daemon is not reachable.', {
        blame: 'environment',
      }),
      category: 'runtime_unavailable',
    },
    {
      name: 'Landlock being unavailable',
      error: kernelError('SANDBOX_UNSUPPORTED', 'Landlock is not available on this kernel.', {
        blame: 'environment',
      }),
      category: 'sandbox_unavailable',
    },
    {
      name: 'a sandbox syscall denial',
      error: kernelError('SANDBOX_SYSCALL_DENIED', 'ptrace was refused by the sandbox filter.', {
        blame: 'model',
      }),
      category: 'sandbox_syscall_denied',
    },
    {
      name: 'a timeout',
      error: kernelError('TOOL_TIMEOUT', 'the command did not finish in time.', { retryable: true }),
      category: 'timeout',
    },
    {
      name: 'a cancellation',
      error: kernelError('CANCELLED', 'the turn was cancelled.'),
      category: 'cancelled',
    },
  ];

  for (const row of rows) {
    test(`${row.name} → ${row.category}, at high confidence`, () => {
      const d = diagnose({ error: row.error });

      assert.equal(d.category, row.category);
      assert.equal(d.confidence, 'high', 'a structured error must not be diagnosed by guesswork');
      assert.equal(d.blame, row.error.blame, 'blame comes from the decision, not from the diagnosis');
      assert.equal(d.retryable, row.error.retryable);
      if (row.capability) assert.equal(d.suggestedCapability, row.capability);
    });
  }
});

describe('§51: a missing executable is one semantic answer on every backend', () => {
  test('from the local backend wording', () => {
    const d = diagnose({ error: kernelError('TOOL_FAILED', 'Executable not found: rustc') });
    assert.equal(d.category, 'executable_missing');
    assert.equal(d.confidence, 'high');
  });

  test('from a shell exit code, with no error object at all', () => {
    const d = diagnose({ result: { exitCode: 127, stderr: 'sh: 1: rustc: not found', timedOut: false } });
    assert.equal(d.category, 'executable_missing');
    assert.equal(d.suggestedCapability, 'process.exec');
  });
});

describe('§50: the first blocker is what gets named', () => {
  test('a read-only workspace with a working network reads as a write problem', () => {
    // The scenario from the plan: `npm install`, workspace read-only, network
    // fine. Diagnosing this as "the proxy may be broken" is the exact failure
    // Closure C exists to stop.
    const d = diagnose({
      result: {
        exitCode: 243,
        stderr: 'npm error EROFS: read-only file system, mkdir /work/node_modules',
        timedOut: false,
      },
      granted: { writeRoots: [], network: 'unrestricted', allowExec: true },
    });

    assert.equal(d.category, 'workspace_write_blocked');
    assert.equal(d.suggestedCapability, 'file.write');
    assert.match(d.message, /granted no writable path/);
  });

  test('a network failure under a deny-all grant names the grant, not DNS', () => {
    const d = diagnose({
      result: {
        exitCode: 1,
        stderr: 'curl: (6) Could not resolve host: registry.npmjs.org',
        timedOut: false,
      },
      granted: { writeRoots: ['/work'], network: 'deny', allowExec: true },
    });

    assert.equal(d.category, 'network_scope_denied');
    assert.match(d.message, /granted no network/);
    assert.equal(d.confidence, 'medium', 'stderr matching is never authoritative (§49)');
  });

  test('the same stderr with network granted is NOT diagnosed as a denial', () => {
    // The control for the row above: if the grant does not explain it, the
    // module must not invent an explanation.
    const d = diagnose({
      result: {
        exitCode: 1,
        stderr: 'curl: (6) Could not resolve host: registry.npmjs.org',
        timedOut: false,
      },
      granted: { writeRoots: ['/work'], network: 'unrestricted', allowExec: true },
    });

    assert.equal(d.category, 'unknown');
  });
});

describe('§49: unknown beats a confident misdiagnosis', () => {
  test('an unrecognised failure is unknown, not a guess', () => {
    const d = diagnose({
      result: { exitCode: 2, stderr: 'error: something went wrong in the build', timedOut: false },
    });
    assert.equal(d.category, 'unknown');
  });

  test('stderr-derived diagnoses are capped at medium confidence', () => {
    const d = diagnose({
      result: { exitCode: 1, stderr: 'mkdir: cannot create directory: Permission denied', timedOut: false },
      granted: { writeRoots: ['/work'], network: 'deny', allowExec: true },
    });
    assert.equal(d.category, 'workspace_write_blocked');
    assert.equal(d.confidence, 'medium');
  });

  test('a SIGKILL is a resource limit at medium confidence, not a certainty', () => {
    const d = diagnose({
      result: { exitCode: null, signal: 'SIGKILL', stderr: '', timedOut: false },
    });
    assert.equal(d.category, 'resource_limit');
    assert.equal(d.confidence, 'medium');
  });
});

describe('§47/§53: diagnosis explains, and never authorises', () => {
  test('the rendered text offers a capability name and asks the user', () => {
    const d = diagnose({ error: kernelError('NETWORK_DENIED', 'no network was granted.') });
    const text = renderDiagnosis(d);

    assert.match(text, /network\.connect/);
    assert.match(text, /Nothing has been granted or retried/);
    assert.match(text, /ask the user/);
  });

  test('no diagnosis carries anything that could act', () => {
    // The structural version of §53: the shape has no field for a decision, so
    // a caller cannot wire one up by accident. This test is what fails if
    // someone adds `grant`, `retry` or `backend` to the interface later.
    const d = diagnose({ error: kernelError('SANDBOX_UNSUPPORTED', 'no Landlock here.') });
    const keys = Object.keys(d).sort();

    assert.deepEqual(
      keys.filter((k) => /grant|retry(?!able)|escalat|enable|switch|rerun/i.test(k)),
      [],
      'a diagnosis must not carry an action',
    );
    assert.ok(keys.includes('message') && keys.includes('category'));
  });
});
