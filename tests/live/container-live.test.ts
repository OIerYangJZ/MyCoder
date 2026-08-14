/**
 * Container isolation suite — the attack matrix (alpha.5 §22, §26, §32–§35, §59).
 *
 * This is the suite the milestone exists for. Every case runs a real command in a
 * real container through the real backend, and asserts on what the *mechanism*
 * did, not on whether the kernel would have refused. That distinction is the
 * whole point: through alpha.4 a test could assert "reading `~/.ssh/id_rsa` is
 * denied" and be satisfied by a policy string comparison. Here the file is not in
 * the mount namespace, so the failure is `No such file or directory` from the
 * kernel of the machine — a different kind of fact.
 *
 * Two disciplines are worth naming, because a suite like this is easy to write
 * badly:
 *
 *  1. **Negative controls (§35).** "The canary did not leak" is not evidence
 *     unless the same test can show the mechanism was live. So every filesystem
 *     case has a positive twin — a file that *is* mounted and *is* readable — and
 *     the network cases run the identical command with networking granted, where
 *     it must succeed. A zero-leak result from a container that failed to start
 *     looks exactly like a zero-leak result from enforcement working.
 *
 *  2. **The attempt must be real.** `python3 -c "open(...)"` only proves
 *     something if python3 exists in the image. Where a case depends on an
 *     interpreter, the interpreter's presence is asserted first, so a missing
 *     binary can never masquerade as a blocked syscall.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, test } from 'node:test';

import {
  containerRequirement,
  containerSkip,
  createContainerFixture,
  sh,
  HOST_CANARY,
  WORKSPACE_CANARY,
  type ContainerFixture,
} from './container-harness.ts';
import { containerName, dockerRunArgs } from '../../src/execution/container-plan.ts';
import { KernelErrorException } from '../../src/util/errors.ts';
import type { CanonicalPath } from '../../src/util/paths.ts';

const skip = await containerSkip();
const requirement = await containerRequirement();

describe('container isolation', { ...skip, timeout: 600_000 }, () => {
  let fx: ContainerFixture;

  before(async () => {
    fx = await createContainerFixture({
      files: {
        'src/readable.txt': 'this file is inside the workspace and mounted\n',
      },
      symlinks: {
        // §33: a symlink out of the workspace, the classic path-scanner bypass.
        'link-to-host-secret': '../host-secret.txt',
        'link-to-etc-passwd': '/etc/passwd',
      },
    });
  });

  after(async () => {
    await fx?.cleanup();
  });

  test('the runtime and platform are recorded', () => {
    const info = requirement.info!;
    // Printed rather than asserted: §37 asks for the environment to be recorded,
    // and the values differ legitimately between a laptop and the release runner.
    assert.ok(info.serverVersion.length > 0);
    assert.ok(info.serverPlatform.includes('/'));
    console.log(
      `      runtime: docker ${info.serverVersion} · ${info.operatingSystem} · ${info.serverPlatform} · ` +
        `kernel ${info.kernelVersion} · nativeLinux=${info.nativeLinux} · rootless=${info.rootless}`,
    );
  });

  test('the image digest is recorded (§11 provenance)', () => {
    console.log(
      `      image: ${fx.backend.image.configured} @ ${fx.backend.image.digest ?? '(local, no digest)'}`,
    );
    assert.ok(fx.backend.image.resolvedId?.startsWith('sha256:'));
  });

  // --- negative controls: the mechanism is live ----------------------------

  describe('negative controls — §35', () => {
    test('a mounted workspace file IS readable', async () => {
      const r = await fx.run(sh('cat src/readable.txt'));
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout, /inside the workspace and mounted/);
    });

    test('a granted writable root IS writable', async () => {
      const r = await fx.run(sh('echo written > dist/proof.txt && cat dist/proof.txt'));
      assert.equal(r.exitCode, 0);
      assert.match(r.stdout, /written/);
    });

    test('an ungranted workspace path is NOT writable', async () => {
      const r = await fx.run(sh('echo nope > src/app.ts 2>&1; echo "exit=$?"'));
      assert.match(r.stdout + r.stderr, /Read-only file system|Permission denied/);
      assert.match(r.stdout, /exit=[1-9]/);
    });

    test('the same command that fails with no network succeeds with network granted', async () => {
      // The pair is the control. `getent hosts` needs only DNS, so it is the
      // cheapest thing that distinguishes "no network namespace" from
      // "networking works but this host is unreachable".
      const denied = await fx.run(sh('getent hosts example.com > /dev/null; echo "exit=$?"'));
      assert.match(denied.stdout, /exit=[1-9]/, 'DNS must fail with --network none');

      const granted = await fx.run(sh('getent hosts example.com > /dev/null; echo "exit=$?"'), {
        profile: { network: { hosts: ['example.com'] } },
      });
      if (!granted.stdout.includes('exit=0')) {
        // A machine with no internet is a legitimate reason for this half of the
        // control to be unavailable, and it must be visible rather than silently
        // turning the pair into a single assertion.
        console.log('      NOTE: outbound DNS unavailable on this machine; positive control not proven');
      } else {
        assert.match(granted.stdout, /exit=0/);
      }
    });
  });

  // --- §59 attack matrix ---------------------------------------------------

  describe('filesystem attacks — §33, §59', () => {
    test('cat of the host canary path finds nothing', async () => {
      const r = await fx.run(sh(`cat ${fx.hostCanaryPath} 2>&1; echo "exit=$?"`));
      assert.ok(!r.stdout.includes(HOST_CANARY), 'the host canary must not be readable');
      assert.match(r.stdout, /No such file or directory/);
      assert.match(r.stdout, /exit=[1-9]/);
    });

    test('a `../` traversal out of the workspace finds nothing', async () => {
      // `ls` output only, deliberately: the `cat` runs in a second command whose
      // *error message* quotes the path it could not open, so a naive search of
      // the combined output for "host-secret.txt" matches the proof of absence.
      const r = await fx.run(sh('cat ../host-secret.txt > /dev/null 2>&1; echo "cat=$?"; ls -1 .. 2>&1'));
      assert.ok(!r.stdout.includes(HOST_CANARY));
      assert.match(r.stdout, /cat=[1-9]/);
      // `..` of /workspace is the container's `/`, so this lists the image root —
      // which contains no host file at all.
      const listed = r.stdout.split('\n').slice(1);
      assert.ok(!listed.includes('host-secret.txt'), `image root listing leaked a host file: ${listed}`);
      assert.ok(listed.includes('usr') && listed.includes('etc'), 'expected the image root, not the host');
    });

    test('a workspace symlink pointing at the host canary is a dangling link', async () => {
      const r = await fx.run(sh('cat link-to-host-secret 2>&1; echo "exit=$?"'));
      assert.ok(!r.stdout.includes(HOST_CANARY));
      assert.match(r.stdout, /No such file/);
    });

    test('a workspace symlink pointing at a host system path resolves inside the image, not the host', async () => {
      const r = await fx.run(sh('cat link-to-etc-passwd | head -1'));
      // /etc/passwd exists in the image, so this succeeds — and what it read is
      // the *image's* file. The proof is that the host's user is absent.
      const hostUser = process.env.USER ?? '';
      if (hostUser !== '' && hostUser !== 'root') {
        assert.ok(!r.stdout.includes(hostUser), 'the container must not see the host /etc/passwd');
      }
    });

    test('python3 open() of the host canary fails, and python3 is really there', async () => {
      const version = await fx.run(sh('python3 --version'));
      assert.equal(version.exitCode, 0, 'the image must have python3 for this case to mean anything');
      const r = await fx.run(
        sh(`python3 -c "print(open('${fx.hostCanaryPath}').read())" 2>&1; echo "exit=$?"`),
      );
      assert.ok(!r.stdout.includes(HOST_CANARY));
      assert.match(r.stdout, /FileNotFoundError|No such file/);
    });

    test('node fs.readFileSync of the host canary fails', async () => {
      const r = await fx.run(
        sh(
          `node -e "console.log(require('fs').readFileSync('${fx.hostCanaryPath}','utf8'))" 2>&1; echo "exit=$?"`,
        ),
      );
      assert.ok(!r.stdout.includes(HOST_CANARY));
      assert.match(r.stdout, /ENOENT/);
    });

    test('find over the whole container filesystem never turns up the canary', async () => {
      const r = await fx.run(
        sh('find / -name "host-secret*" -o -name ".ssh" -type d 2>/dev/null | head -20'),
        { timeoutMs: 120_000 },
      );
      assert.ok(!r.stdout.includes('host-secret'));
    });

    test('tar + base64 exfiltration of the workspace cannot include the masked secret', async () => {
      // The alpha.4 defect this descends from: redaction cannot recognise a
      // secret re-encoded at an arbitrary byte offset, so the only real defence
      // is that the bytes are not there to encode.
      const r = await fx.run(sh('tar cf - . 2>/dev/null | base64 -w0 | head -c 200000'), {
        timeoutMs: 120_000,
      });
      const decoded = Buffer.from(r.stdout.replace(/\s+/g, ''), 'base64').toString('latin1');
      assert.ok(!decoded.includes(WORKSPACE_CANARY), 'the masked .env must not be inside the archive');
      assert.ok(!decoded.includes(HOST_CANARY));
    });

    test('the host home directory is absent', async () => {
      const r = await fx.run(
        sh('ls /Users /home /root 2>&1 | head -20; echo "---"; echo $HOME; ls -a $HOME'),
      );
      const hostUser = process.env.USER ?? '';
      if (hostUser !== '' && hostUser !== 'root') {
        assert.ok(!r.stdout.includes(`/${hostUser}`), 'the host home must not be mounted');
      }
      // HOME points at the tmpfs, so a tool that writes a cache has somewhere to
      // write that is not the workspace and does not survive the container.
      assert.match(r.stdout, /\/tmp/);
    });

    test('credential directories are absent, not merely denied', async () => {
      const r = await fx.run(
        sh('for p in ~/.ssh ~/.aws ~/.kube ~/.docker ~/.config/gcloud ~/.gnupg; do ls -d $p 2>&1; done'),
      );
      assert.equal(/No such file or directory/.test(r.stdout), true);
      assert.ok(!/id_rsa|credentials|config\.json/.test(r.stdout));
    });

    test('the protected .env inside the workspace is masked: present, empty, canary absent', async () => {
      const r = await fx.run(sh('ls -la .env; echo "---"; cat .env; echo "---end"; wc -c < .env'));
      assert.ok(!r.stdout.includes(WORKSPACE_CANARY), 'the workspace canary must not be readable');
      assert.match(r.stdout, /---\n---end/, 'the masked file must read as empty');
    });

    test('.git is present and read-only', async () => {
      const fx2 = await createContainerFixture({ files: { '.git/config': '[core]\n' } });
      try {
        const r = await fx2.run(sh('cat .git/config; echo x > .git/config 2>&1; echo "write=$?"'));
        assert.match(r.stdout, /\[core\]/);
        assert.match(r.stdout, /write=[1-9]/);
        assert.match(r.stdout + r.stderr, /Read-only file system/);
      } finally {
        await fx2.cleanup();
      }
    });

    test('writing outside the workspace fails', async () => {
      const r = await fx.run(
        sh(`echo x > ${fx.hostCanaryPath} 2>&1; echo "exit=$?"; echo y > /etc/x 2>&1; echo "etc=$?"`),
      );
      assert.match(r.stdout, /exit=[1-9]/);
      assert.match(r.stdout, /etc=[1-9]/);
      // The host file is untouched: read it back through the host, not the container.
      const { readFile } = await import('node:fs/promises');
      assert.match(await readFile(fx.hostCanaryPath, 'utf8'), /HOST_CANARY_SECRET/);
    });
  });

  describe('socket and privilege attacks — §19, §32', () => {
    test('the Docker socket is absent everywhere it is normally found', async () => {
      const r = await fx.run(
        sh(
          'for s in /var/run/docker.sock /run/docker.sock /var/run/containerd/containerd.sock ' +
            '/run/containerd/containerd.sock; do ls -l $s 2>&1; done',
        ),
      );
      assert.equal(/No such file or directory/.test(r.stdout), true);
      assert.ok(!r.stdout.includes('srw'), 'no socket may be present');
    });

    test('a docker client inside the container cannot reach a daemon', async () => {
      // Belt and braces for §32: even if a socket appeared, there is no client —
      // and if a workload brought one, there is nothing to connect to.
      const r = await fx.run(sh('command -v docker || echo "no docker client"'));
      assert.match(r.stdout, /no docker client/);
    });

    test('the process is unprivileged and cannot escalate', async () => {
      const r = await fx.run(
        sh(
          'id; echo "---"; su -c id root 2>&1 | head -2; echo "su=$?"; echo "---"; cat /proc/self/status | grep -i cap',
        ),
      );
      assert.ok(!/uid=0\(root\)/.test(r.stdout.split('---')[0] ?? ''), 'the workload must not run as root');
      // `CapEff: 0000000000000000` is `--cap-drop=ALL` visible from inside.
      assert.match(r.stdout, /CapEff:\s*0+\b/);
    });

    test('no-new-privileges blocks setuid escalation', async () => {
      const r = await fx.run(
        sh('ls -l /usr/bin/su /bin/su 2>/dev/null | head -2; su root -c "id" 2>&1 | tail -1'),
      );
      assert.ok(!/uid=0\(root\)/.test(r.stdout), 'a setuid binary must not yield root');
    });

    test('host namespaces are not shared: the container sees its own PID 1', async () => {
      const r = await fx.run(sh('ls /proc | grep -c "^[0-9]*$"; cat /proc/1/comm'));
      // A handful of processes, not the host's hundreds, and PID 1 is the workload.
      const [count, comm] = r.stdout.trim().split('\n');
      assert.ok(Number(count) < 30, `expected a private PID namespace, saw ${count} processes`);
      assert.match(comm ?? '', /sh|node/);
    });

    test('the root filesystem is read-only', async () => {
      const r = await fx.run(
        sh('echo x > /oops 2>&1; echo "root=$?"; echo y > /usr/bin/oops 2>&1; echo "usr=$?"'),
      );
      assert.match(r.stdout, /root=[1-9]/);
      assert.match(r.stdout, /usr=[1-9]/);
      assert.match(r.stdout + r.stderr, /Read-only file system/);
    });

    test('tmpfs is writable and does not survive the container', async () => {
      const first = await fx.run(sh('echo ephemeral > /tmp/marker && cat /tmp/marker'));
      assert.match(first.stdout, /ephemeral/);
      const second = await fx.run(sh('cat /tmp/marker 2>&1; echo "exit=$?"'));
      assert.match(second.stdout, /No such file/, 'each execution gets a fresh container (§27)');
    });
  });

  describe('network attacks — §22, §23', () => {
    const cases: Array<[string, string]> = [
      ['curl', 'curl -sS -m 5 https://example.com > /dev/null 2>&1; echo "exit=$?"'],
      [
        'node fetch',
        "node -e \"fetch('https://example.com').then(()=>{console.log('REACHED')},e=>{console.log('BLOCKED',e.cause?.code||e.message)})\"",
      ],
      [
        'python urllib',
        'python3 -c "import urllib.request;urllib.request.urlopen(\'https://example.com\',timeout=5)" 2>&1 | tail -1',
      ],
      ['DNS', 'getent hosts example.com; echo "exit=$?"'],
      [
        'raw socket to a literal IP',
        // No DNS involved at all: this is the case that proves the *route* is
        // gone, not just the resolver.
        "python3 -c \"import socket;s=socket.create_connection(('1.1.1.1',443),5);print('REACHED')\" 2>&1 | tail -1",
      ],
      [
        'node raw TCP',
        "node -e \"require('net').createConnection({host:'1.1.1.1',port:443}).on('connect',()=>console.log('REACHED')).on('error',e=>console.log('BLOCKED',e.code))\"",
      ],
      [
        'apt (package manager)',
        'apt-get -o Acquire::http::Timeout=5 update > /dev/null 2>&1; echo "exit=$?"',
      ],
    ];

    for (const [name, script] of cases) {
      test(`${name} is blocked by the network namespace, not by a command scanner`, async () => {
        const r = await fx.run(sh(script), { timeoutMs: 90_000 });
        const output = `${r.stdout}\n${r.stderr}`;
        assert.ok(!output.includes('REACHED'), `${name} reached the network: ${output.slice(0, 300)}`);
        // The blocker is a network-layer error from the interpreter, which is what
        // distinguishes this from a kernel-side refusal: nothing in the kernel
        // inspected the command at all — the profile simply produced
        // `--network none`, and the syscall had nowhere to go.
        assert.match(
          output,
          /exit=[1-9]|BLOCKED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|Network is unreachable|Temporary failure|URLError|gaierror|Could not resolve/i,
          `${name} should fail with a network error, got: ${output.slice(0, 300)}`,
        );
      });
    }

    test('the container has a loopback interface and no default route', async () => {
      // `/proc/net/*` rather than `ip`, which the image does not ship. This is
      // the shape of `--network none` from inside: `lo` exists, and the route
      // table has nothing but link-local entries.
      const r = await fx.run(
        sh(
          'echo "ifaces:"; cut -d: -f1 /proc/net/dev | tail -n +3 | tr -d " "; echo "routes:"; tail -n +2 /proc/net/route | wc -l',
        ),
      );
      const [ifaces, routes] = r.stdout.split('routes:');
      assert.match(ifaces ?? '', /\blo\b/, 'lo is expected to exist even with --network none');
      assert.ok(!/\beth0\b/.test(ifaces ?? ''), 'no external interface may be attached');
      assert.equal((routes ?? '').trim(), '0', 'there must be no route out');
    });

    test('granting network changes the plan from none to bridge, and says so honestly', async () => {
      await fx.run(sh('true'), { profile: { network: { hosts: ['registry.npmjs.org'] } } });
      const plan = fx.plans.at(-1)!;
      assert.equal(plan.network, 'bridge');
      // §23: bridge networking does not enforce the hostname. The descriptor and
      // the approval text both have to say that, and the test asserts the
      // descriptor rather than trusting the prose.
      assert.equal(fx.backend.environment.enforcement.networkAllowlist, 'best-effort');
    });
  });

  describe('environment isolation — §25', () => {
    test('the workload environment contains nothing credential-shaped', async () => {
      const r = await fx.run(sh('env | sort'));
      const names = r.stdout
        .split('\n')
        .map((l) => l.split('=')[0] ?? '')
        .filter((n) => n !== '');
      for (const forbidden of [
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'GITHUB_TOKEN',
        'GH_TOKEN',
        'SSH_AUTH_SOCK',
        'DOCKER_HOST',
        'KUBECONFIG',
      ]) {
        assert.ok(!names.includes(forbidden), `${forbidden} must not be in the container environment`);
      }
      assert.ok(!/API_KEY|_TOKEN=|_SECRET=/.test(r.stdout));
      // A small, explicit environment rather than a filtered copy of the host's.
      assert.ok(names.length < 15, `expected a minimal environment, got ${names.length}: ${names.join(',')}`);
    });

    test('SSH_AUTH_SOCK is not forwarded even when the host has one', async () => {
      const r = await fx.run(sh('echo "sock=[$SSH_AUTH_SOCK]"; ls $SSH_AUTH_SOCK 2>&1 | tail -1'));
      assert.match(r.stdout, /sock=\[\]/);
    });

    test('an injected secret arrives, and does so without appearing in the docker argv', async () => {
      const { InMemorySecretBroker } = await import('../../src/security/secret-broker.ts');
      const { Redactor } = await import('../../src/security/redactor.ts');
      const broker = new InMemorySecretBroker(new Redactor());
      broker.register('test/token', { kind: 'literal', value: 'injected-secret-value-9f2c' });
      const lease = await broker.resolve('test/token', 'subprocess.env');

      // Its *length*, never the value: a test that echoed the secret would put it
      // in the CI log, which is one of the six sinks the canary suite exists to
      // keep it out of.
      const r = await fx.run(sh('echo "len=${#SUPPLIED_TOKEN}"'), {
        profile: { secretInjections: [{ envName: 'SUPPLIED_TOKEN', lease }] },
      });
      assert.match(r.stdout, /len=26/, 'the value must reach the workload');

      // And the argv that reached the daemon carries only the *name*: a secret in
      // `-e NAME=value` would be readable by every user on the host through ps.
      const argv = dockerRunArgs(fx.plans.at(-1)!);
      assert.ok(argv.includes('SUPPLIED_TOKEN'));
      assert.ok(
        !argv.some((a) => a.includes('injected-secret-value')),
        'the secret value must never appear in the docker command line',
      );
    });
  });

  describe('lifecycle — §21, §26, §27', () => {
    test('a timeout kills the container promptly and reports timedOut', async () => {
      const started = Date.now();
      const r = await fx.run(sh('sleep 300'), { timeoutMs: 3_000 });
      const elapsed = Date.now() - started;
      assert.equal(r.timedOut, true);
      // The bound is the regression, not the flag. `docker run` forwards SIGTERM
      // to a PID 1 that ignores it, so before the container was force-removed on
      // teardown this returned when `sleep 300` finished — with `timedOut: true`
      // set correctly the whole time and nobody waiting on it.
      assert.ok(elapsed < 30_000, `timeout took ${elapsed}ms; the container was not terminated`);
    });

    test('a cancelled execution returns promptly and leaves no container behind', async () => {
      const controller = new AbortController();
      const started = Date.now();
      const pending = fx.run(sh('sleep 300'), { timeoutMs: 300_000, signal: controller.signal });
      // Long enough for the container to actually be running, short enough that
      // the test is not slow. A cancel that arrives before `docker run` has
      // created anything would pass trivially.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      controller.abort();
      await pending.catch(() => undefined);
      const elapsed = Date.now() - started;

      assert.ok(elapsed < 40_000, `cancellation took ${elapsed}ms; the container outlived the cancel`);
      const name = fx.plans.at(-1)!.name;
      assert.equal(await fx.backend.containerExists(name), false, `container ${name} leaked`);
    });

    test('no container from this fixture is still running at the end of the suite', async () => {
      for (const plan of fx.plans) {
        assert.equal(await fx.backend.containerExists(plan.name), false, `${plan.name} leaked`);
      }
    });

    test('a fork bomb hits the pid limit instead of the host', async () => {
      const r = await fx.run(
        sh('i=0; while [ $i -lt 2000 ]; do sleep 30 & i=$((i+1)); done 2>/dev/null; echo "spawned=$i"'),
        { timeoutMs: 60_000 },
      );
      // The assertion is not that it failed — it is that the machine survived and
      // the limit was in the plan. `--pids-limit` is what makes that true.
      assert.equal(fx.plans.at(-1)!.limits.pids, 512);
      assert.ok(r.exitCode !== null || r.timedOut);
    });

    test('each execution is its own container, named uniquely', async () => {
      await fx.run(sh('true'));
      await fx.run(sh('true'));
      const names = fx.plans.slice(-2).map((p) => p.name);
      assert.notEqual(names[0], names[1]);
      assert.ok(names.every((n) => n.startsWith('mycoder-')));
    });
  });

  describe('plan-level refusals — §50', () => {
    test('a cwd outside the workspace is refused before docker is invoked', async () => {
      const executor = await fx.backend.enforce(
        fx.profile({ readRoots: [fx.root, fx.base as CanonicalPath] }),
      );
      try {
        await assert.rejects(
          () =>
            executor.exec({ argv: ['sh', '-c', 'pwd'], cwd: fx.base as CanonicalPath, timeoutMs: 10_000 }),
          (e: unknown) =>
            e instanceof KernelErrorException && e.kernelError.code === 'PATH_OUTSIDE_WORKSPACE',
        );
      } finally {
        executor.dispose();
      }
    });

    test('a profile without exec cannot run anything', async () => {
      const executor = await fx.backend.enforce(fx.profile({ allowExec: false }));
      try {
        await assert.rejects(
          () => executor.exec({ argv: ['sh', '-c', 'true'], cwd: fx.root, timeoutMs: 10_000 }),
          (e: unknown) => e instanceof KernelErrorException && e.kernelError.code === 'TOOL_DENIED',
        );
      } finally {
        executor.dispose();
      }
    });

    test('the backend refuses to execute outside a capability profile at all', async () => {
      await assert.rejects(
        () =>
          fx.backend.process.exec({
            argv: ['sh', '-c', 'true'],
            cwd: fx.root,
            env: {},
            timeoutMs: 1_000,
          }),
        (e: unknown) => e instanceof KernelErrorException && e.kernelError.code === 'TOOL_DENIED',
      );
    });
  });

  describe('truthfulness — §7, §41, §42', () => {
    test('the descriptor reports container enforcement for the process and policy for the broker', () => {
      const e = fx.backend.environment.enforcement;
      assert.equal(e.processFilesystem, 'container-enforced');
      assert.equal(e.processNetwork, 'container-enforced');
      assert.equal(e.processPrivileges, 'container-enforced');
      assert.equal(e.environmentIsolation, 'container-enforced');
      assert.equal(e.hostFileBroker, 'policy-enforced');
      assert.equal(e.networkAllowlist, 'best-effort');
      assert.equal(fx.backend.environment.sandboxStrength, 'container-enforced');
    });

    test('the platform note does not claim native-Linux isolation on a VM-backed daemon', () => {
      const notes = (fx.backend.environment.enforcement.platformNotes ?? []).join(' ');
      if (requirement.info!.nativeLinux) {
        assert.match(notes, /Native Linux/);
      } else {
        assert.match(notes, /virtual machine/);
        assert.match(notes, /native-Linux-equivalent isolation is not claimed/);
      }
    });

    test('the trusted broker still reaches the host, and is reported as policy-enforced', async () => {
      // §28's separation, demonstrated rather than asserted in prose: Read works
      // on a file the *container* cannot see, because Read is not a container
      // operation. Reporting that as container-enforced would be the overclaim.
      const executor = await fx.backend.enforce(fx.profile({ readRoots: [fx.root] }));
      try {
        const content = await executor.fs.readFile(`${fx.root}/src/readable.txt` as CanonicalPath);
        assert.match(content.toString(), /mounted/);
      } finally {
        executor.dispose();
      }
    });
  });

  describe('conformance basics on this backend', () => {
    test('a non-zero exit is a result, not an infrastructure error', async () => {
      const r = await fx.run(sh('exit 3'));
      assert.equal(r.exitCode, 3);
      assert.equal(r.timedOut, false);
    });

    test('stdout and stderr are separated', async () => {
      const r = await fx.run(sh('echo out; echo err 1>&2'));
      assert.match(r.stdout, /out/);
      assert.match(r.stderr, /err/);
    });

    test('stdin is delivered', async () => {
      const executor = await fx.backend.enforce(fx.profile());
      try {
        const r = await executor.exec({
          argv: ['sh', '-c', 'cat'],
          cwd: fx.root,
          timeoutMs: 30_000,
          stdin: 'piped-input\n',
        });
        assert.match(r.stdout, /piped-input/);
      } finally {
        executor.dispose();
      }
    });

    test('a relative cwd inside the workspace is honoured', async () => {
      const r = await fx.run(sh('pwd'), { cwd: `${fx.root}/src` });
      assert.match(r.stdout.trim(), /^\/workspace\/src$/);
    });

    test('output is redacted on the way back', async () => {
      const r = await fx.run(sh('echo "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"'));
      assert.ok(!r.stdout.includes('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'));
    });

    test('a container name is never derived from model input', async () => {
      await fx.run(sh('true'));
      const name = fx.plans.at(-1)!.name;
      assert.match(name, /^mycoder-[a-f0-9]{10}$/);
      assert.equal(containerName('mycoder', 'x'.repeat(200)).length <= 60, true);
    });
  });
});
