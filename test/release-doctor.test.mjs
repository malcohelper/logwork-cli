import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { parseReleaseArgs } from '../release-cli.mjs';
import {
  formatReleaseDoctorReport,
  runReleaseDoctor
} from '../lib/release-doctor.mjs';

test('release doctor passes fast checks for a publishable version', async () => {
  const result = await runReleaseDoctor({
    cwd: '/repo',
    readFileFn: fakePackageReader({
      version: '1.2.4'
    }),
    readdirFn: async () => [],
    runCommand: fakeCommandRunner({
      'git status --short --branch': ok('## main...origin/main\n'),
      'npm config get registry': ok('https://registry.npmjs.org/\n'),
      'npm whoami': ok('malco\n'),
      'npm view logwork-helper version': ok('1.2.3\n'),
      'git tag --list v1.2.4': ok(''),
      'git ls-remote --tags origin v1.2.4': ok(''),
      'gh auth status': ok("Token scopes: 'repo', 'workflow'\n"),
      'gh release view v1.2.4 --repo tructran2598/logwork-helper': fail('release not found')
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.version, '1.2.4');
  assert.equal(result.checks.find((check) => check.name === 'npm latest').status, 'ok');
  assert.match(formatReleaseDoctorReport(result), /Run `logwork-helper release doctor --full`/);
});

test('release doctor reports blocking publish problems', async () => {
  const result = await runReleaseDoctor({
    cwd: '/repo',
    readFileFn: fakePackageReader({
      version: '1.2.4',
      rootDependency: true
    }),
    readdirFn: async () => ['logwork-helper-1.2.4.tgz'],
    runCommand: fakeCommandRunner({
      'git status --short --branch': ok('## main...origin/main [ahead 1]\n M package.json\n'),
      'npm config get registry': ok('https://registry.npmjs.org/\n'),
      'npm whoami': fail('npm error code E401\nnpm error 401 Unauthorized'),
      'npm view logwork-helper version': ok('1.2.4\n'),
      'git tag --list v1.2.4': ok('v1.2.4\n'),
      'git ls-remote --tags origin v1.2.4': ok('abc\trefs/tags/v1.2.4\n'),
      'gh auth status': fail('not logged in'),
      'gh release view v1.2.4 --repo tructran2598/logwork-helper': ok('v1.2.4\n')
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.find((check) => check.name === 'self dependency').status, 'fail');
  assert.equal(result.checks.find((check) => check.name === 'npm auth').status, 'fail');
  assert.equal(result.checks.find((check) => check.name === 'npm latest').status, 'fail');
  assert.equal(result.checks.find((check) => check.name === 'tarball artifacts').status, 'warn');
  assert.match(formatReleaseDoctorReport(result), /npm login/);
});

test('release doctor full mode runs slow gates', async () => {
  const calls = [];
  const result = await runReleaseDoctor({
    cwd: '/repo',
    full: true,
    readFileFn: fakePackageReader({
      version: '1.2.4'
    }),
    readdirFn: async () => [],
    runCommand: async (command, args) => {
      calls.push(`${command} ${args.join(' ')}`);
      return fakeCommandRunner({
        'git status --short --branch': ok('## main...origin/main\n'),
        'npm config get registry': ok('https://registry.npmjs.org/\n'),
        'npm whoami': ok('malco\n'),
        'npm view logwork-helper version': ok('1.2.3\n'),
        'git tag --list v1.2.4': ok(''),
        'git ls-remote --tags origin v1.2.4': ok(''),
        'gh auth status': ok("Token scopes: 'repo', 'workflow'\n"),
        'gh release view v1.2.4 --repo tructran2598/logwork-helper': fail('release not found'),
        'git diff --check': ok(''),
        'npm test': ok('tests passed\n'),
        'npm run audit:prod': ok('found 0 vulnerabilities\n'),
        'npm pack --dry-run --cache /private/tmp/logwork-helper-npm-cache': ok('logwork-helper-1.2.4.tgz\n')
      })(command, args);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.full, true);
  assert.equal(result.checks.find((check) => check.name === 'npm test').status, 'ok');
  assert.ok(calls.includes('npm pack --dry-run --cache /private/tmp/logwork-helper-npm-cache'));
});

test('release CLI parser supports doctor full mode', () => {
  assert.deepEqual(parseReleaseArgs([]), {
    type: 'help'
  });
  assert.deepEqual(parseReleaseArgs(['doctor']), {
    type: 'doctor',
    full: false
  });
  assert.deepEqual(parseReleaseArgs(['doctor', '--full']), {
    type: 'doctor',
    full: true
  });
  assert.throws(() => parseReleaseArgs(['publish']), /Unknown release command/);
});

function fakePackageReader({
  version,
  rootDependency = false,
  lockVersion = version
}) {
  return async (filePath) => {
    if (filePath === join('/repo', 'package.json')) {
      return JSON.stringify({
        name: 'logwork-helper',
        version,
        repository: {
          type: 'git',
          url: 'git+https://github.com/tructran2598/logwork-helper.git'
        },
        dependencies: rootDependency
          ? { 'logwork-helper': 'file:logwork-helper-1.2.4.tgz' }
          : {}
      });
    }

    if (filePath === join('/repo', 'package-lock.json')) {
      return JSON.stringify({
        name: 'logwork-helper',
        version: lockVersion,
        packages: {
          '': {
            name: 'logwork-helper',
            version: lockVersion,
            dependencies: rootDependency
              ? { 'logwork-helper': 'file:logwork-helper-1.2.4.tgz' }
              : {}
          }
        }
      });
    }

    throw new Error(`Unexpected read: ${filePath}`);
  };
}

function fakeCommandRunner(responses) {
  return async (command, args) => {
    const key = `${command} ${args.join(' ')}`;
    const response = responses[key];
    if (!response) {
      throw new Error(`Unexpected command: ${key}`);
    }
    return response;
  };
}

function ok(stdout = '') {
  return {
    code: 0,
    stdout,
    stderr: ''
  };
}

function fail(stderr = '') {
  return {
    code: 1,
    stdout: '',
    stderr
  };
}
