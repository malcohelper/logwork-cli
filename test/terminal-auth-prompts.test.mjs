import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthRequiredError } from '../lib/auth-errors.mjs';
import { createTerminalCredentialProvider } from '../lib/terminal-auth-prompts.mjs';

const CANCEL = Symbol('cancel');
const tty = { isTTY: true };

function fakePrompts(answers = []) {
  const queue = [...answers];
  const calls = [];
  const answer = (kind) => async (options) => {
    calls.push({ kind, options });
    return queue.shift();
  };
  return {
    calls,
    text: answer('text'),
    password: answer('password'),
    select: answer('select'),
    isCancel: (value) => value === CANCEL
  };
}

function fakeEmailStorage({ remembered = null, getError = null, setError = null } = {}) {
  const saved = [];
  return {
    saved,
    async get() {
      if (getError) {
        throw getError;
      }
      return remembered;
    },
    async set(value) {
      if (setError) {
        throw setError;
      }
      saved.push(value);
    }
  };
}

function provider({ prompts, emailStorage = fakeEmailStorage(), stdin = tty, stdout = tty } = {}) {
  return createTerminalCredentialProvider({ prompts, emailStorage, stdin, stdout });
}

test('every request needs an interactive terminal', async () => {
  const prompts = fakePrompts();
  for (const [stdin, stdout] of [[{ isTTY: false }, tty], [tty, { isTTY: false }], [null, tty]]) {
    const credentials = provider({ prompts, stdin, stdout });
    for (const request of [
      () => credentials.requestCredentials(),
      () => credentials.requestPasswordUpdate(),
      () => credentials.requestDeviceSelection([{}, {}]),
      () => credentials.requestOtp()
    ]) {
      await assert.rejects(request(), (error) => isAuthRequiredError(error));
    }
  }
  assert.equal(prompts.calls.length, 0);
});

test('requestCredentials prefills the remembered email, trims it and saves it', async () => {
  const prompts = fakePrompts(['  me@example.com ', 's3cret']);
  const emailStorage = fakeEmailStorage({ remembered: 'old@example.com' });

  const result = await provider({ prompts, emailStorage }).requestCredentials();

  assert.deepEqual(result, { email: 'me@example.com', password: 's3cret' });
  assert.deepEqual(emailStorage.saved, ['me@example.com']);
  const [emailPrompt, passwordPrompt] = prompts.calls;
  assert.equal(emailPrompt.kind, 'text');
  assert.equal(emailPrompt.options.initialValue, 'old@example.com');
  assert.equal(emailPrompt.options.validate('  '), 'Email is required.');
  assert.equal(emailPrompt.options.validate('a@b.c'), undefined);
  assert.equal(passwordPrompt.kind, 'password');
  assert.equal(passwordPrompt.options.validate(''), 'Password is required.');
  assert.equal(passwordPrompt.options.validate('x'), undefined);
});

test('requestCredentials keeps going when the email store fails', async () => {
  const prompts = fakePrompts(['me@example.com', 'pw']);
  const emailStorage = fakeEmailStorage({ getError: new Error('locked'), setError: new Error('locked') });

  assert.deepEqual(await provider({ prompts, emailStorage }).requestCredentials(), { email: 'me@example.com', password: 'pw' });
  assert.equal(prompts.calls[0].options.initialValue, '');
});

test('requestPasswordUpdate asks twice and checks the confirmation matches', async () => {
  const prompts = fakePrompts(['new-pass', 'new-pass']);
  assert.deepEqual(await provider({ prompts }).requestPasswordUpdate(), {
    newPassword: 'new-pass',
    confirmPassword: 'new-pass'
  });
  const [first, second] = prompts.calls;
  assert.equal(first.options.validate(''), 'New password is required.');
  assert.equal(second.options.validate(''), 'Password confirmation is required.');
  assert.equal(second.options.validate('other'), 'Passwords do not match.');
  assert.equal(second.options.validate('new-pass'), undefined);
});

test('requestDeviceSelection skips the prompt for zero or one device', async () => {
  const prompts = fakePrompts(['1']);
  const credentials = provider({ prompts });
  const devices = [{ label: 'Phone' }, { name: 'device', value: 'b' }];

  assert.equal(await credentials.requestDeviceSelection([]), null);
  assert.equal(await credentials.requestDeviceSelection(null), null);
  assert.equal(await credentials.requestDeviceSelection([devices[0]]), devices[0]);
  assert.equal(prompts.calls.length, 0);

  assert.equal(await credentials.requestDeviceSelection(devices), devices[1]);
  assert.deepEqual(prompts.calls[0].options.options, [
    { value: '0', label: 'Phone' },
    { value: '1', label: 'Device 2' }
  ]);
});

test('requestOtp trims the code and requires one', async () => {
  const prompts = fakePrompts([' 123456 ']);
  assert.equal(await provider({ prompts }).requestOtp(), '123456');
  assert.equal(prompts.calls[0].options.validate(' '), '2FA code is required.');
  assert.equal(prompts.calls[0].options.validate('1'), undefined);
});

test('a cancelled prompt stops authentication', async () => {
  const cancelled = /User cancelled Resource Optimiser authentication\./;
  await assert.rejects(provider({ prompts: fakePrompts([CANCEL]) }).requestCredentials(), cancelled);
  await assert.rejects(provider({ prompts: fakePrompts(['me@example.com', CANCEL]) }).requestCredentials(), cancelled);
  await assert.rejects(provider({ prompts: fakePrompts([CANCEL]) }).requestPasswordUpdate(), cancelled);
  await assert.rejects(provider({ prompts: fakePrompts([CANCEL]) }).requestDeviceSelection([{}, {}]), cancelled);
  await assert.rejects(provider({ prompts: fakePrompts([CANCEL]) }).requestOtp(), cancelled);
});
