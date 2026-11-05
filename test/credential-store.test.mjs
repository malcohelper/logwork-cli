import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCredentialEmailStorage,
  createCredentialJiraStorage,
  createCredentialTokenStorage,
  credentialStoreLabel
} from '../lib/credential-store.mjs';
import {
  createWindowsCredentialValueStorage,
  runPowerShellCredentialCommand,
  windowsCredentialTarget
} from '../lib/windows-credential-manager.mjs';

test('credential store labels supported platforms', () => {
  assert.equal(credentialStoreLabel({ platform: 'darwin' }), 'macOS Keychain');
  assert.equal(credentialStoreLabel({ platform: 'win32' }), 'Windows Credential Manager');
  assert.equal(credentialStoreLabel({ platform: 'linux' }), 'OS credential store');
});

test('unsupported credential platform reports a clear error', async () => {
  const storage = createCredentialTokenStorage({ platform: 'linux' });
  await assert.rejects(
    storage.get(),
    /Unsupported operating system.*macOS and Windows/
  );
});

test('Windows credential storage maps get, set, and delete requests', async () => {
  const calls = [];
  const storage = createWindowsCredentialValueStorage({
    service: 'logwork-test',
    account: 'resourceoptimiser',
    run: async (request) => {
      calls.push(request);
      if (request.action === 'get') {
        return { found: true, value: 'stored-session' };
      }
      if (request.action === 'delete') {
        return { deleted: true };
      }
      return { ok: true };
    }
  });

  assert.equal(await storage.get(), 'stored-session');
  await storage.set('new-session');
  assert.equal(await storage.delete(), true);

  assert.deepEqual(calls, [
    {
      action: 'get',
      target: 'logwork-test:resourceoptimiser',
      username: 'resourceoptimiser'
    },
    {
      action: 'set',
      target: 'logwork-test:resourceoptimiser',
      username: 'resourceoptimiser',
      value: 'new-session'
    },
    {
      action: 'delete',
      target: 'logwork-test:resourceoptimiser',
      username: 'resourceoptimiser'
    }
  ]);
});

test('platform credential storage creates Windows token and email targets', async () => {
  const requests = [];
  const tokenStorage = createCredentialTokenStorage({
    platform: 'win32',
    run: async (request) => {
      requests.push(request);
      return { ok: true };
    }
  });
  const emailStorage = createCredentialEmailStorage({
    platform: 'win32',
    run: async (request) => {
      requests.push(request);
      return { ok: true };
    }
  });

  await tokenStorage.set('token-session');
  await emailStorage.set('user@example.com');

  assert.equal(requests[0].target, 'logwork-helper:resourceoptimiser');
  assert.equal(requests[1].target, 'logwork-helper:resourceoptimiser-email');
});

test('platform credential storage creates separate Jira target', async () => {
  const requests = [];
  const jiraStorage = createCredentialJiraStorage({
    platform: 'win32',
    run: async (request) => {
      requests.push(request);
      return { ok: true };
    }
  });

  await jiraStorage.set('jira-session');

  assert.equal(requests[0].target, 'logwork-helper:jira');
  assert.equal(requests[0].username, 'jira');
});

test('Windows credential target includes service and account', () => {
  assert.equal(windowsCredentialTarget('logwork-helper', 'resourceoptimiser'), 'logwork-helper:resourceoptimiser');
});

test('Windows Credential Manager stores, reads, and deletes a test credential', {
  skip: process.platform !== 'win32' ? 'Windows Credential Manager integration test only runs on Windows.' : false
}, async () => {
  const service = `logwork-helper-test-${Date.now()}-${process.pid}`;
  const account = 'resourceoptimiser-test';
  const storage = createWindowsCredentialValueStorage({ service, account });
  const secret = `session-${Date.now()}`;

  try {
    await storage.set(secret);
    assert.equal(await storage.get(), secret);
    assert.equal(await storage.delete(), true);
    assert.equal(await storage.get(), null);
  } finally {
    await storage.delete().catch(() => {});
  }
});

test('PowerShell credential runner sends request JSON over stdin', async () => {
  let stdinText = '';
  const fakeChild = {
    stdout: fakeStream(),
    stderr: fakeStream(),
    stdin: {
      end(value) {
        stdinText = value;
        queueMicrotask(() => {
          fakeChild.stdout.emitData('{"ok":true}');
          fakeChild.emitClose(0);
        });
      }
    },
    on(event, handler) {
      fakeChild[`on_${event}`] = handler;
    },
    emitClose(code) {
      fakeChild.on_close(code);
    }
  };

  const result = await runPowerShellCredentialCommand({
    action: 'set',
    target: 'logwork-helper:resourceoptimiser',
    username: 'resourceoptimiser',
    value: 'secret'
  }, {
    spawnFn: (command, args, options) => {
      assert.equal(command, 'powershell.exe');
      assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
      assert.equal(options.windowsHide, true);
      return fakeChild;
    }
  });

  assert.deepEqual(JSON.parse(stdinText), {
    action: 'set',
    target: 'logwork-helper:resourceoptimiser',
    username: 'resourceoptimiser',
    value: 'secret'
  });
  assert.deepEqual(result, { ok: true });
});

function fakeStream() {
  return {
    setEncoding() {},
    on(event, handler) {
      this[`on_${event}`] = handler;
    },
    emitData(value) {
      this.on_data(value);
    }
  };
}
