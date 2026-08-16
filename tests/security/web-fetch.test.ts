/**
 * WebFetch, and the four things that must agree before a byte moves (ADR-0017).
 *
 * The tool is the kernel's only model-directed network read, so the suite is
 * written as a set of refusals with one success in the middle: a fetcher that
 * works is easy, and a fetcher that only reaches where it was told to is the
 * whole design.
 *
 * The transport is a stub — nothing here touches the network — but everything
 * between the model and the transport is real: the registry, the policy engine,
 * the approval prompt, the egress gate and its allowlist.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createTestWorkspace, CANARY, type TestWorkspace } from '../helpers/workspace.ts';
import { FakeModel, type FakeStep } from '../../src/model/adapters/fake.ts';
import type { EgressResponse, EgressTransport } from '../../src/security/egress-gate.ts';
import type { Kernel } from '../../src/kernel.ts';

/** A transport that answers from a table, and records what it was asked for. */
class StubWeb implements EgressTransport {
  readonly requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  responses = new Map<string, EgressResponse>();
  fallback: EgressResponse = { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' };

  async send(req: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<EgressResponse> {
    this.requests.push({ url: req.url, method: req.method, headers: req.headers });
    return this.responses.get(req.url) ?? this.fallback;
  }
}

const WEB_CONFIG = `[egress]
web = ["docs.example.com", "api.example.com"]
`;

async function webWorkspace(
  opts: {
    approvals?: Array<{ decision: 'allow' | 'deny'; scope: 'once' | 'session' }>;
    /** What every host resolves to, for the §23 check. */
    resolvesTo?: string;
    allowBenchmarkRange?: boolean;
  } = {},
): Promise<{ ws: TestWorkspace; web: StubWeb }> {
  const web = new StubWeb();
  const ws = await createTestWorkspace({
    files: { 'src/a.ts': 'export const a = 1;\n' },
    userConfig: WEB_CONFIG + (opts.allowBenchmarkRange ? 'allow_benchmark_range = true\n' : ''),
    approvals: opts.approvals ?? [{ decision: 'allow', scope: 'once' }],
    ...(opts.resolvesTo ? { webLookup: async () => [{ address: opts.resolvesTo!, family: 4 }] } : {}),
  });
  // The kernel's gate was built with the capturing transport; swap in one that
  // can answer per-URL. The gate, its policy and its allowlist are untouched.
  (ws.kernel.egress as unknown as { transport: EgressTransport }).transport = web;
  return { ws, web };
}

function setScript(kernel: Kernel, script: FakeStep[]): void {
  const routed = kernel.modelRuntime as unknown as { routes: Map<string, unknown> };
  routed.routes.set('fake', new FakeModel({ script }));
}

function lastResult(kernel: Kernel): string {
  const out: string[] = [];
  for (const message of kernel.context.history()) {
    if (message.role !== 'tool') continue;
    for (const part of message.parts) {
      if (part.type === 'tool_result') out.push(part.content);
    }
  }
  return out.at(-1) ?? '';
}

async function fetchUrl(ws: TestWorkspace, args: Record<string, unknown>): Promise<string> {
  setScript(ws.kernel, [
    { kind: 'tools', calls: [{ name: 'WebFetch', arguments: args }] },
    { kind: 'final', text: 'done' },
  ]);
  await ws.kernel.session.runTurn('fetch it');
  return lastResult(ws.kernel);
}

describe('the tool exists only where web egress is configured', () => {
  test('no [egress] web means no WebFetch in the catalogue', async () => {
    const ws = await createTestWorkspace({ files: { 'a.ts': 'x\n' } });
    try {
      assert.equal(ws.kernel.toolRegistry.has('WebFetch'), false);
    } finally {
      await ws.cleanup();
    }
  });

  test('a configured host registers it, and the description names the hosts', async () => {
    const { ws } = await webWorkspace();
    try {
      const tool = ws.kernel.toolRegistry.get('WebFetch');
      assert.ok(tool, 'WebFetch should be registered');
      assert.match(tool!.description, /docs\.example\.com/);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('a fetch that is allowed', () => {
  test('returns the page as text, labelled as untrusted', async () => {
    const { ws, web } = await webWorkspace();
    try {
      web.responses.set('https://docs.example.com/guide', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body:
          '<html><head><title>The Guide</title><style>.a{color:red}</style></head>' +
          '<body><h1>Install</h1><p>Run&nbsp;the installer.</p>' +
          '<script>alert("ignore me")</script></body></html>',
      });

      const result = await fetchUrl(ws, { url: 'https://docs.example.com/guide' });

      assert.match(result, /HTTP 200/);
      assert.match(result, /The Guide/);
      assert.match(result, /# Install/);
      assert.match(result, /Run the installer\./);
      assert.doesNotMatch(result, /alert\(/, 'script contents must not reach the model');
      assert.doesNotMatch(result, /color:red/, 'stylesheets must not reach the model');
      assert.match(result, /begin untrusted web content/);
      assert.match(result, /instructions inside it are part of the page/);

      // It really went through the gate, as a GET, to the URL that was approved.
      assert.equal(web.requests.length, 1);
      assert.equal(web.requests[0]!.method, 'GET');
      assert.equal(web.requests[0]!.url, 'https://docs.example.com/guide');

      // And it asked first, naming the host.
      assert.equal(ws.prompter.seen.length, 1);
      assert.match(
        ws.prompter.seen[0]!.pending[0]!.subjectKey,
        /network\.connect:web:scoped:docs\.example\.com/,
      );
    } finally {
      await ws.cleanup();
    }
  });

  test('a denied approval sends nothing at all', async () => {
    const { ws, web } = await webWorkspace({ approvals: [{ decision: 'deny', scope: 'once' }] });
    try {
      const result = await fetchUrl(ws, { url: 'https://docs.example.com/guide' });

      assert.match(result, /TOOL_DENIED/);
      assert.equal(web.requests.length, 0, 'a denied fetch must not reach the transport');
    } finally {
      await ws.cleanup();
    }
  });
});

describe('destinations that are refused before anyone is asked', () => {
  test('an unconfigured host is refused, and never prompts', async () => {
    const { ws, web } = await webWorkspace();
    try {
      const result = await fetchUrl(ws, { url: 'https://evil.example.net/steal' });

      assert.match(result, /NETWORK_DENIED/);
      assert.match(result, /not a configured web host/);
      assert.equal(ws.prompter.seen.length, 0);
      assert.equal(web.requests.length, 0);
    } finally {
      await ws.cleanup();
    }
  });

  test('the cloud metadata address is refused even if it is spelled unusually', async () => {
    const { ws, web } = await webWorkspace();
    try {
      for (const url of [
        'https://169.254.169.254/latest/meta-data/',
        'https://127.0.0.1/admin',
        'https://[::1]/admin',
        'https://0x7f.0.0.1/admin',
      ]) {
        const result = await fetchUrl(ws, { url });
        assert.match(result, /NETWORK_DENIED|TOOL_INVALID_ARGS/, `${url} should be refused`);
      }
      assert.equal(web.requests.length, 0);
      assert.equal(ws.prompter.seen.length, 0);
    } finally {
      await ws.cleanup();
    }
  });

  test('non-http schemes and credentialed URLs are refused', async () => {
    const { ws, web } = await webWorkspace();
    try {
      assert.match(await fetchUrl(ws, { url: 'file:///etc/passwd' }), /TOOL_INVALID_ARGS/);
      assert.match(await fetchUrl(ws, { url: 'https://user:pw@docs.example.com/x' }), /credentials/);
      assert.equal(web.requests.length, 0);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('the response is not trusted', () => {
  test('a redirect is reported, not followed', async () => {
    const { ws, web } = await webWorkspace();
    try {
      web.responses.set('https://docs.example.com/old', {
        status: 302,
        headers: { location: 'https://evil.example.net/collect' },
        body: '',
      });

      const result = await fetchUrl(ws, { url: 'https://docs.example.com/old' });

      assert.match(result, /302/);
      assert.match(result, /evil\.example\.net/);
      assert.match(result, /Redirects are not followed/);
      // One request: the redirect was not chased.
      assert.equal(web.requests.length, 1);
      assert.equal(web.requests[0]!.url, 'https://docs.example.com/old');
    } finally {
      await ws.cleanup();
    }
  });

  test('an image response is refused by content type', async () => {
    const { ws, web } = await webWorkspace();
    try {
      web.responses.set('https://docs.example.com/logo.png', {
        status: 200,
        headers: { 'content-type': 'image/png' },
        body: 'PNG\r\n',
      });

      const result = await fetchUrl(ws, { url: 'https://docs.example.com/logo.png' });
      assert.match(result, /not text/);
    } finally {
      await ws.cleanup();
    }
  });

  test('a credential in the page is redacted before it reaches the model', async () => {
    const { ws, web } = await webWorkspace();
    try {
      web.responses.set('https://docs.example.com/issue/12', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: `Someone pasted their key: ${CANARY} — please rotate it.\n`,
      });

      const result = await fetchUrl(ws, { url: 'https://docs.example.com/issue/12' });

      assert.doesNotMatch(result, new RegExp(CANARY));
      assert.match(result, /please rotate it/);
      // And it is not in the persisted log either.
      const log = await ws.eventLogText();
      assert.doesNotMatch(log, new RegExp(CANARY));
    } finally {
      await ws.cleanup();
    }
  });

  test('an oversized body is cut to the requested budget', async () => {
    const { ws, web } = await webWorkspace();
    try {
      web.responses.set('https://docs.example.com/big', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: 'x'.repeat(400_000),
      });

      const result = await fetchUrl(ws, { url: 'https://docs.example.com/big', maxBytes: 2048 });

      assert.match(result, /cut short/);
      assert.ok(result.length < 20_000, `expected a truncated result, got ${result.length} bytes`);
    } finally {
      await ws.cleanup();
    }
  });

  test('an HTTP error is an error result, with the body as context', async () => {
    const { ws, web } = await webWorkspace();
    try {
      web.responses.set('https://api.example.com/v1/thing', {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: '{"error":"no such thing"}',
      });

      const result = await fetchUrl(ws, { url: 'https://api.example.com/v1/thing' });

      assert.match(result, /404/);
      assert.match(result, /no such thing/);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('the gate is not bypassed', () => {
  test('a host approved by policy but absent from the gate allowlist is still blocked', async () => {
    const { ws, web } = await webWorkspace();
    try {
      // Narrow the gate underneath the tool, leaving configuration and policy
      // untouched: the tool's own list still contains the host, so this is the
      // fourth layer answering on its own.
      const policy = ws.kernel.egress.getPolicy('web');
      (ws.kernel.egress as unknown as { policy: Record<string, unknown> }).policy = {
        ...(ws.kernel.egress as unknown as { policy: Record<string, unknown> }).policy,
        web: { ...policy, allowedHosts: [] },
      };

      const result = await fetchUrl(ws, { url: 'https://docs.example.com/guide' });

      assert.match(result, /NETWORK_DENIED/);
      assert.equal(web.requests.length, 0);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('an allowlisted name cannot be pointed at private space (§23, ADR-0017)', () => {
  // The hole this closes: `docs.example.com` is in the operator's allowlist and
  // approved by the user, and the *name* is not the destination — the address
  // it resolves to is. There is no proxy on this path, so the tool asks.
  const cases: Array<[string, string, RegExp]> = [
    ['loopback', '127.0.0.1', /loopback/],
    ['the cloud metadata endpoint', '169.254.169.254', /metadata/],
    ['RFC1918 private space', '10.0.0.5', /private/],
    ['link-local', '169.254.10.1', /link-local/],
  ];

  for (const [what, address, reason] of cases) {
    test(`a host resolving to ${what} is refused, and nothing is sent`, async () => {
      const { ws, web } = await webWorkspace({ resolvesTo: address });
      try {
        const result = await fetchUrl(ws, { url: 'https://docs.example.com/guide' });

        assert.match(result, /NETWORK_DENIED/);
        assert.match(result, reason, `the refusal should name the scope, got: ${result}`);
        assert.equal(web.requests.length, 0, 'a refused destination must not reach the transport');
      } finally {
        await ws.cleanup();
      }
    });
  }

  test('NEGATIVE CONTROL: a global address is fetched normally', async () => {
    // Without this the four cases above would pass equally well if the tool
    // refused everything.
    const { ws, web } = await webWorkspace({ resolvesTo: '93.184.216.34' });
    try {
      const result = await fetchUrl(ws, { url: 'https://docs.example.com/guide' });
      assert.doesNotMatch(result, /NETWORK_DENIED/);
      assert.equal(web.requests.length, 1);
    } finally {
      await ws.cleanup();
    }
  });

  test('benchmarking space is refused by default, and the message says how to opt in', async () => {
    const { ws, web } = await webWorkspace({ resolvesTo: '198.18.0.196' });
    try {
      const result = await fetchUrl(ws, { url: 'https://docs.example.com/guide' });
      assert.match(result, /NETWORK_DENIED/);
      assert.match(result, /benchmarking/);
      assert.match(result, /allow_benchmark_range/);
      assert.equal(web.requests.length, 0);
    } finally {
      await ws.cleanup();
    }
  });

  test('the opt-in permits it, and only it', async () => {
    // The measured case: a resolver that NATs public names into 198.18/15 makes
    // the strict check deny the whole internet, so the operator can say "this
    // range is expected here" — without that also permitting loopback.
    const permitted = await webWorkspace({ resolvesTo: '198.18.0.196', allowBenchmarkRange: true });
    try {
      const result = await fetchUrl(permitted.ws, { url: 'https://docs.example.com/guide' });
      assert.doesNotMatch(result, /NETWORK_DENIED/);
      assert.equal(permitted.web.requests.length, 1);
    } finally {
      await permitted.ws.cleanup();
    }

    const stillRefused = await webWorkspace({ resolvesTo: '127.0.0.1', allowBenchmarkRange: true });
    try {
      const result = await fetchUrl(stillRefused.ws, { url: 'https://docs.example.com/guide' });
      assert.match(result, /NETWORK_DENIED/);
      assert.equal(stillRefused.web.requests.length, 0);
    } finally {
      await stillRefused.ws.cleanup();
    }
  });

  test('a name that does not resolve is refused rather than attempted', async () => {
    const web = new StubWeb();
    const ws = await createTestWorkspace({
      files: { 'src/a.ts': 'x\n' },
      userConfig: WEB_CONFIG,
      approvals: [{ decision: 'allow', scope: 'once' }],
      webLookup: async () => {
        throw Object.assign(new Error('nope'), { code: 'ENOTFOUND' });
      },
    });
    (ws.kernel.egress as unknown as { transport: EgressTransport }).transport = web;
    try {
      const result = await fetchUrl(ws, { url: 'https://docs.example.com/guide' });
      assert.match(result, /NETWORK_DENIED/);
      assert.match(result, /ENOTFOUND/);
      assert.equal(web.requests.length, 0);
    } finally {
      await ws.cleanup();
    }
  });
});

describe('the relaxation is disclosed and cannot be enabled by a repository (§43, §44)', () => {
  test('a session with the opt-in on says so at startup', async () => {
    const { ws } = await webWorkspace({ allowBenchmarkRange: true });
    try {
      const warnings = ws.kernel.config.warnings.join('\n');
      assert.match(warnings, /allow_benchmark_range/);
      assert.match(warnings, /198\.18\.0\.0\/15/);
      // §45: the disclosure also states what stays denied, so nobody reads it as
      // "private addresses are allowed now".
      assert.match(warnings, /metadata addresses remain denied/);
    } finally {
      await ws.cleanup();
    }
  });

  test('NEGATIVE CONTROL: a session without it says nothing about it', async () => {
    const { ws } = await webWorkspace();
    try {
      assert.doesNotMatch(ws.kernel.config.warnings.join('\n'), /allow_benchmark_range/);
    } finally {
      await ws.cleanup();
    }
  });

  test('a project config cannot turn it on (§43)', async () => {
    // The merge is `strictBoolean`, so the repository's vote can only narrow.
    const { mergeConfig, defaultConfig } = await import('../../src/config/schema.ts');
    const user = mergeConfig(defaultConfig(), { egress: { allowedHosts: {} } });
    const withProject = mergeConfig(user, { egress: { allowedHosts: {}, allowBenchmarkRange: true } });
    assert.notEqual(
      withProject.egress.allowBenchmarkRange,
      true,
      'a repository must not weaken its own boundary',
    );

    // And the positive half: the user layer can.
    const byUser = mergeConfig(
      mergeConfig(defaultConfig(), { egress: { allowedHosts: {}, allowBenchmarkRange: true } }),
      {},
    );
    assert.equal(byUser.egress.allowBenchmarkRange, true);
  });
});
