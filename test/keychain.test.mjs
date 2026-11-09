import test from 'node:test';
import assert from 'node:assert/strict';
import { createKeychainValueStorage, formatAddPasswordCommand } from '../lib/keychain.mjs';

test('Keychain set passes the secret on stdin, never in argv', async () => {
  const calls = [];
  const storage = createKeychainValueStorage({
    service: 'logwork-cli',
    account: 'resourceoptimiser',
    run: async (args, options) => {
      calls.push({ args, options });
      return { stdout: '', stderr: '' };
    }
  });
  await storage.set('{"refresh_token":"secret value"}');
  assert.deepEqual(calls[0].args, ['-i']);
  assert.doesNotMatch(JSON.stringify(calls[0].args), /secret/);
  const hex = Buffer.from('{"refresh_token":"secret value"}').toString('hex');
  assert.equal(calls[0].options.input, `add-generic-password -U -s "logwork-cli" -a "resourceoptimiser" -X ${hex}\n`);
});

test('Keychain command refuses service names that would need quoting', () => {
  assert.throws(() => formatAddPasswordCommand({ service: 'bad name', account: 'a', value: 'x' }), /Unsupported Keychain service/);
});
