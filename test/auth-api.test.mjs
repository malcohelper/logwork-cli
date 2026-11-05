import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authenticateWithApi,
  buildKeycloakAuthorizeUrl,
  exchangeSigninKeycloak,
  exchangeSigninKeycloakSession,
  extractRoToken,
  extractRoSession,
  parseHtmlForms,
  selectNextKeycloakForm
} from '../lib/api-auth.mjs';

test('buildKeycloakAuthorizeUrl creates Resource Optimiser OIDC authorize URL', () => {
  const url = new URL(buildKeycloakAuthorizeUrl({
    state: 'state-value',
    nonce: 'nonce-value'
  }));

  assert.equal(url.origin + url.pathname, 'https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/auth');
  assert.equal(url.searchParams.get('client_id'), 'localhost');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.resourceoptimiser.com/vinova/check-login');
  assert.equal(url.searchParams.get('response_mode'), 'fragment');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid');
  assert.equal(url.searchParams.get('state'), 'state-value');
  assert.equal(url.searchParams.get('nonce'), 'nonce-value');

  const randomUrl = new URL(buildKeycloakAuthorizeUrl());
  assert.match(randomUrl.searchParams.get('state'), /^[0-9a-f-]{36}$/);
  assert.match(randomUrl.searchParams.get('nonce'), /^[0-9a-f-]{36}$/);
});

test('parseHtmlForms finds Keycloak credential, device, and OTP forms', () => {
  const credentials = selectNextKeycloakForm(`
    <form action="https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?session_code=secret" method="post">
      <input type="hidden" name="credentialId" value="">
      <input name="username">
      <input name="password" type="password">
    </form>
  `);
  assert.equal(credentials.kind, 'credentials');
  assert.equal(credentials.fields.some((field) => field.name === 'password'), true);

  const [device] = parseHtmlForms(`
    <form action="/device" method="post">
      <input type="hidden" name="code" value="session-code">
      <input type="radio" id="phone" name="credentialId" value="phone">
      <label for="phone">Mobile phone</label>
    </form>
  `, 'https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?execution=step');
  assert.equal(device.kind, 'device');
  assert.equal(device.action, 'https://keycloak.vinova.sg/device');
  assert.deepEqual(device.devices[0], {
    type: 'radio',
    name: 'credentialId',
    value: 'phone',
    label: 'Mobile phone'
  });

  const otp = selectNextKeycloakForm(`
    <form action="/otp" method="post">
      <input type="text" name="otp">
    </form>
  `);
  assert.equal(otp.kind, 'otp');

  const mixedOtpDevice = selectNextKeycloakForm(`
    <form action="/mixed" method="post">
      <input type="radio" id="phone-again" name="credentialId" value="phone">
      <label for="phone-again">Mobile phone</label>
      <input type="text" name="otp">
    </form>
  `);
  assert.equal(mixedOtpDevice.kind, 'otp');
  assert.equal(mixedOtpDevice.devices[0].label, 'Mobile phone');

  const mixedBeforeDeviceSubmit = selectNextKeycloakForm(`
    <form action="/mixed" method="post">
      <input type="radio" id="phone-again" name="credentialId" value="phone">
      <label for="phone-again">Mobile phone</label>
      <input type="text" name="otp">
    </form>
  `, undefined, { preferDevice: true });
  assert.equal(mixedBeforeDeviceSubmit.kind, 'otp');

  const otpPreferredOverDevice = selectNextKeycloakForm(`
    <form action="/device" method="post">
      <input type="radio" id="phone" name="credentialId" value="phone">
      <label for="phone">Mobile phone</label>
    </form>
    <form action="/otp" method="post">
      <input type="text" name="totp">
    </form>
  `);
  assert.equal(otpPreferredOverDevice.kind, 'otp');

  const visibleCodeWithoutOtpHint = selectNextKeycloakForm(`
    <form action="/not-otp" method="post">
      <input type="text" name="code" id="country-code">
    </form>
  `);
  assert.equal(visibleCodeWithoutOtpHint, null);

  const visibleCodeWithOtpHint = selectNextKeycloakForm(`
    <form action="/otp-code" method="post">
      <input type="text" name="code" autocomplete="one-time-code">
    </form>
  `);
  assert.equal(visibleCodeWithOtpHint.kind, 'otp');

  const variantCredentials = selectNextKeycloakForm(`
    <form action="/login" method="post">
      <input name="login" autocomplete="username">
      <input name="passwd" type="password">
    </form>
  `);
  assert.equal(variantCredentials.kind, 'credentials');

  const passwordUpdate = selectNextKeycloakForm(`
    <form action="/auth/realms/resource/login-actions/required-action?execution=UPDATE_PASSWORD" method="post">
      <input type="password" id="password-new" name="password-new" autocomplete="new-password">
      <input type="password" id="password-confirm" name="password-confirm" autocomplete="new-password">
      <input type="submit" value="Submit">
    </form>
  `, 'https://keycloak.vinova.sg/auth/realms/resource/login-actions/required-action');
  assert.equal(passwordUpdate.kind, 'password-update');

  const mfaCode = selectNextKeycloakForm(`
    <form action="/mfa" method="post">
      <input type="text" name="mfa_code">
    </form>
  `);
  assert.equal(mfaCode.kind, 'otp');

  const verificationCode = selectNextKeycloakForm(`
    <form action="/verify" method="post">
      <input type="text" name="verification_code">
    </form>
  `);
  assert.equal(verificationCode.kind, 'otp');

  const [wrappedDeviceLabel] = parseHtmlForms(`
    <form action="/device" method="post">
      <label><input type="radio" name="credentialId" value="phone"> Mobile phone</label>
    </form>
  `, 'https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?execution=step');
  assert.equal(wrappedDeviceLabel.kind, 'device');
  assert.equal(wrappedDeviceLabel.devices[0].label, 'Mobile phone');
});

test('authenticateWithApi submits credentials, device, OTP, token exchange, and signinKeyCloak', async () => {
  const finalToken = makeJwt({ id: 115, exp: futureExp() });
  const requests = [];
  const events = [];
  let devicePromptCount = 0;
  let otpPromptCount = 0;
  const responses = [
    htmlResponse(`<form action="/auth/realms/resource/login-actions/authenticate?session_code=s1&execution=e1&tab_id=t1" method="post"><input name="username"><input name="password" type="password"><input name="credentialId" value=""></form>`),
    htmlResponse(`<form action="https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?session_code=s2&execution=e2&tab_id=t2" method="post"><input type="hidden" name="code" value="session-code"><input type="radio" id="phone" name="credentialId" value="phone"><label for="phone">Phone</label></form>`),
    htmlResponse(`<form action="https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?session_code=s3&execution=e3&tab_id=t3" method="post"><input type="radio" id="phone-again" name="credentialId" value="phone"><label for="phone-again">Phone</label><input name="otp"></form>`),
    redirectResponse('https://app.resourceoptimiser.com/vinova/check-login#code=auth-code&state=state-value'),
    jsonResponse({ access_token: makeJwt({ sub: 'keycloak-user', exp: futureExp() }) }),
    jsonResponse({ accessToken: finalToken })
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push({
      url: String(url),
      method: options.method || 'GET',
      body: String(options.body || '')
    });
    return responses.shift();
  };

  const token = await authenticateWithApi({
    keycloakState: 'state-value',
    keycloakNonce: 'nonce-value',
    fetchImpl,
    diagnosticsRecorder: {
      event(name, details) {
        events.push({ name, details });
      }
    },
    credentialProvider: {
      async requestCredentials() {
        return {
          email: 'user@example.com',
          password: 'secret-password'
        };
      },
      async requestDeviceSelection(devices) {
        devicePromptCount += 1;
        assert.equal(devices[0].label, 'Phone');
        return devices[0];
      },
      async requestOtp() {
        otpPromptCount += 1;
        return '654321';
      }
    }
  });

  assert.equal(token, finalToken);
  assert.equal(devicePromptCount, 1);
  assert.equal(otpPromptCount, 1);
  assert.match(requests[0].url, /^https:\/\/keycloak\.vinova\.sg\/auth\/realms\/resource\/protocol\/openid-connect\/auth\?/);
  assert.equal(new URL(requests[0].url).searchParams.get('client_id'), 'localhost');
  assert.equal(new URL(requests[0].url).searchParams.get('redirect_uri'), 'https://app.resourceoptimiser.com/vinova/check-login');
  assert.equal(requests[1].url, 'https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?session_code=s1&execution=e1&tab_id=t1');
  assert.equal(requests[1].body.includes('username=user%40example.com'), true);
  assert.equal(requests[1].body.includes('password=secret-password'), true);
  assert.equal(requests[2].body.includes('credentialId=phone'), true);
  assert.equal(requests[3].body.includes('otp=654321'), true);
  assert.equal(requests[4].url, 'https://keycloak.vinova.sg/auth/realms/resource/protocol/openid-connect/token');
  assert.equal(requests[4].body.includes('code=auth-code'), true);
  assert.match(requests[5].url, /\/api\/v1\/auth\/signinKeyCloak$/);
  assert.deepEqual(events.map((event) => event.name), [
    'authorize_request',
    'authorize_response',
    'keycloak_form_detected',
    'credentials_submit_result',
    'keycloak_form_detected',
    'device_submit_result',
    'keycloak_form_detected',
    'otp_submit_result',
    'authorization_code_received',
    'keycloak_token_response',
    'signin_keycloak_response'
  ]);
  assert.equal(events[0].details.host, 'keycloak.vinova.sg');
  assert.equal(events[0].details.path, '/auth/realms/resource/protocol/openid-connect/auth');
  assert.deepEqual(events.at(-2).details.jsonKeys, ['access_token']);
  assert.deepEqual(events.at(-1).details.jsonKeys, ['accessToken']);
});

test('authenticateWithApi submits variant credential and OTP field names', async () => {
  const finalToken = makeJwt({ id: 115, exp: futureExp() });
  const requests = [];
  const responses = [
    htmlResponse(`
      <form action="/auth/realms/resource/login-actions/authenticate?session_code=s1&execution=e1&tab_id=t1" method="post">
        <input name="login" autocomplete="username">
        <input name="passwd" type="password">
      </form>
    `),
    htmlResponse(`
      <form action="https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?session_code=s2&execution=e2&tab_id=t2" method="post">
        <input type="text" name="mfa_code" autocomplete="one-time-code">
      </form>
    `),
    redirectResponse('https://app.resourceoptimiser.com/vinova/check-login#code=auth-code&state=state-value'),
    jsonResponse({ access_token: makeJwt({ sub: 'keycloak-user', exp: futureExp() }) }),
    jsonResponse({ accessToken: finalToken })
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push({
      url: String(url),
      method: options.method || 'GET',
      body: String(options.body || '')
    });
    return responses.shift();
  };

  const token = await authenticateWithApi({
    keycloakState: 'state-value',
    keycloakNonce: 'nonce-value',
    fetchImpl,
    credentialProvider: {
      async requestCredentials() {
        return {
          email: 'user@example.com',
          password: 'secret-password'
        };
      },
      async requestDeviceSelection() {
        throw new Error('device should not be requested');
      },
      async requestOtp() {
        return '654321';
      }
    }
  });

  assert.equal(token, finalToken);
  assert.equal(requests[1].body.includes('login=user%40example.com'), true);
  assert.equal(requests[1].body.includes('passwd=secret-password'), true);
  assert.equal(requests[1].body.includes('username='), false);
  assert.equal(requests[1].body.includes('password='), false);
  assert.equal(requests[2].body.includes('mfa_code=654321'), true);
  assert.equal(requests[2].body.includes('otp='), false);
});

test('authenticateWithApi completes required password update after OTP', async () => {
  const finalToken = makeJwt({ id: 115, exp: futureExp() });
  const requests = [];
  const events = [];
  let passwordUpdatePromptCount = 0;
  const responses = [
    htmlResponse(`<form action="/auth/realms/resource/login-actions/authenticate?session_code=s1&execution=e1&tab_id=t1" method="post"><input name="username"><input name="password" type="password"></form>`),
    htmlResponse(`<form action="/auth/realms/resource/login-actions/authenticate?session_code=s2&execution=e2&tab_id=t2" method="post"><input name="otp"></form>`),
    htmlResponse(`
      <html><head><title>Sign in to resource</title></head><body>
        <h1>Update password</h1>
        <p>You need to change your password to activate your account.</p>
        <form action="/auth/realms/resource/login-actions/required-action?session_code=s3&execution=UPDATE_PASSWORD&tab_id=t3" method="post">
          <input type="password" id="password-new" name="password-new" autocomplete="new-password">
          <input type="password" id="password-confirm" name="password-confirm" autocomplete="new-password">
          <input type="submit" value="Submit">
        </form>
      </body></html>
    `),
    redirectResponse('https://app.resourceoptimiser.com/vinova/check-login#code=auth-code&state=state-value'),
    jsonResponse({ access_token: makeJwt({ sub: 'keycloak-user', exp: futureExp() }) }),
    jsonResponse({ accessToken: finalToken })
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push({
      url: String(url),
      method: options.method || 'GET',
      body: String(options.body || '')
    });
    return responses.shift();
  };

  const token = await authenticateWithApi({
    keycloakState: 'state-value',
    keycloakNonce: 'nonce-value',
    fetchImpl,
    diagnosticsRecorder: {
      event(name, details) {
        events.push({ name, details });
      }
    },
    credentialProvider: {
      async requestCredentials() {
        return {
          email: 'user@example.com',
          password: 'old-secret-password'
        };
      },
      async requestOtp() {
        return '654321';
      },
      async requestPasswordUpdate() {
        passwordUpdatePromptCount += 1;
        return {
          newPassword: 'new-secret-password',
          confirmPassword: 'new-secret-password'
        };
      }
    }
  });

  assert.equal(token, finalToken);
  assert.equal(passwordUpdatePromptCount, 1);
  assert.equal(requests[3].url, 'https://keycloak.vinova.sg/auth/realms/resource/login-actions/required-action?session_code=s3&execution=UPDATE_PASSWORD&tab_id=t3');
  assert.equal(requests[3].body.includes('password-new=new-secret-password'), true);
  assert.equal(requests[3].body.includes('password-confirm=new-secret-password'), true);
  assert.equal(events.some((event) => event.name === 'password_update_submit_result'), true);
  assert.equal(JSON.stringify(events).includes('new-secret-password'), false);
});

test('authenticateWithApi submits mixed OTP and device form in one request', async () => {
  const finalToken = makeJwt({ id: 115, exp: futureExp() });
  const requests = [];
  const events = [];
  let devicePromptCount = 0;
  let otpPromptCount = 0;
  const responses = [
    htmlResponse(`<form action="/auth/realms/resource/login-actions/authenticate?session_code=s1&execution=e1&tab_id=t1" method="post"><input name="username"><input name="password" type="password"><input name="credentialId" value=""></form>`),
    htmlResponse(`
      <form action="https://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate?session_code=s2&execution=e2&tab_id=t2" method="post">
        <input type="radio" id="device-m" name="credentialId" value="m">
        <label for="device-m">m</label>
        <input type="radio" id="device-aa" name="credentialId" value="aa">
        <label for="device-aa">aa</label>
        <input name="otp">
      </form>
    `),
    redirectResponse('https://app.resourceoptimiser.com/vinova/check-login#code=auth-code&state=state-value'),
    jsonResponse({ access_token: makeJwt({ sub: 'keycloak-user', exp: futureExp() }) }),
    jsonResponse({ accessToken: finalToken })
  ];
  const fetchImpl = async (url, options = {}) => {
    requests.push({
      url: String(url),
      method: options.method || 'GET',
      body: String(options.body || '')
    });
    return responses.shift();
  };

  const token = await authenticateWithApi({
    keycloakState: 'state-value',
    keycloakNonce: 'nonce-value',
    fetchImpl,
    diagnosticsRecorder: {
      event(name, details) {
        events.push({ name, details });
      }
    },
    credentialProvider: {
      async requestCredentials() {
        return {
          email: 'user@example.com',
          password: 'secret-password'
        };
      },
      async requestDeviceSelection(devices) {
        devicePromptCount += 1;
        assert.deepEqual(devices.map((device) => device.label), ['m', 'aa']);
        return devices[1];
      },
      async requestOtp() {
        otpPromptCount += 1;
        return '654321';
      }
    }
  });

  assert.equal(token, finalToken);
  assert.equal(devicePromptCount, 1);
  assert.equal(otpPromptCount, 1);
  assert.equal(requests[2].body.includes('credentialId=aa'), true);
  assert.equal(requests[2].body.includes('otp=654321'), true);
  assert.equal(requests[2].body.includes('credentialId=m'), false);
  assert.equal(events.some((event) => event.name === 'device_submit_result'), false);
  const otpSubmit = events.find((event) => event.name === 'otp_submit_result');
  assert.equal(otpSubmit.details.otpFormHasDevices, true);
  assert.equal(otpSubmit.details.selectedDeviceSubmitted, true);
});

test('authenticateWithApi rejects authorization state mismatch', async () => {
  const responses = [
    htmlResponse(`<form action="/auth/realms/resource/login-actions/authenticate" method="post"><input name="username"><input name="password" type="password"></form>`),
    redirectResponse('https://app.resourceoptimiser.com/vinova/check-login#code=auth-code&state=wrong-state')
  ];

  await assert.rejects(
    authenticateWithApi({
      keycloakState: 'state-value',
      keycloakNonce: 'nonce-value',
      fetchImpl: async () => responses.shift(),
      credentialProvider: {
        async requestCredentials() {
          return {
            email: 'user@example.com',
            password: 'secret-password'
          };
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /state did not match/);
      return true;
    }
  );
});

test('authenticateWithApi blocks off-domain Keycloak form actions before credentials', async () => {
  let credentialsRequested = false;

  await assert.rejects(
    authenticateWithApi({
      keycloakState: 'state-value',
      keycloakNonce: 'nonce-value',
      fetchImpl: async () => htmlResponse(`
        <form action="https://evil.example/login" method="post">
          <input name="username">
          <input name="password" type="password">
        </form>
      `),
      credentialProvider: {
        async requestCredentials() {
          credentialsRequested = true;
          throw new Error('credentials should not be requested');
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /Blocked Keycloak form submission/);
      assert.equal(credentialsRequested, false);
      return true;
    }
  );
});

test('authenticateWithApi blocks insecure Keycloak form actions before credentials', async () => {
  let credentialsRequested = false;

  await assert.rejects(
    authenticateWithApi({
      keycloakState: 'state-value',
      keycloakNonce: 'nonce-value',
      fetchImpl: async () => htmlResponse(`
        <form action="http://keycloak.vinova.sg/auth/realms/resource/login-actions/authenticate" method="post">
          <input name="username">
          <input name="password" type="password">
        </form>
      `),
      credentialProvider: {
        async requestCredentials() {
          credentialsRequested = true;
          throw new Error('credentials should not be requested');
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /must use HTTPS/);
      assert.equal(credentialsRequested, false);
      return true;
    }
  );
});

test('authenticateWithApi blocks off-domain auth redirects', async () => {
  await assert.rejects(
    authenticateWithApi({
      keycloakState: 'state-value',
      keycloakNonce: 'nonce-value',
      fetchImpl: async () => redirectResponse('https://evil.example/callback#code=auth-code&state=state-value'),
      credentialProvider: {
        async requestCredentials() {
          throw new Error('credentials should not be requested');
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /Blocked auth redirect/);
      return true;
    }
  );
});

test('authenticateWithApi blocks Keycloak token endpoint origin mismatch', async () => {
  let called = false;

  await assert.rejects(
    authenticateWithApi({
      keycloakTokenUrl: 'https://evil.example/auth/realms/resource/protocol/openid-connect/token',
      fetchImpl: async () => {
        called = true;
        throw new Error('fetch should not be called');
      },
      credentialProvider: {
        async requestCredentials() {
          throw new Error('credentials should not be requested');
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /token endpoint origin did not match/);
      assert.equal(called, false);
      return true;
    }
  );
});

test('authenticateWithApi rejects Keycloak token nonce mismatch when nonce is present', async () => {
  const responses = [
    htmlResponse(`<form action="/auth/realms/resource/login-actions/authenticate" method="post"><input name="username"><input name="password" type="password"></form>`),
    redirectResponse('https://app.resourceoptimiser.com/vinova/check-login#code=auth-code&state=state-value'),
    jsonResponse({ access_token: makeKeycloakJwt({ nonce: 'wrong-nonce', exp: futureExp() }) })
  ];

  await assert.rejects(
    authenticateWithApi({
      keycloakState: 'state-value',
      keycloakNonce: 'nonce-value',
      fetchImpl: async () => responses.shift(),
      credentialProvider: {
        async requestCredentials() {
          return {
            email: 'user@example.com',
            password: 'secret-password'
          };
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /nonce did not match/);
      return true;
    }
  );
});

test('authenticateWithApi records repeated OTP page without leaking OTP', async () => {
  const events = [];
  let otpPromptCount = 0;
  const responses = [
    htmlResponse(`<form action="/auth/realms/resource/login-actions/authenticate?session_code=s1&execution=e1&tab_id=t1" method="post"><input name="username"><input name="password" type="password"></form>`),
    htmlResponse(`<form action="/auth/realms/resource/login-actions/authenticate?session_code=s2&execution=e2&tab_id=t2" method="post"><input type="radio" id="phone" name="credentialId" value="phone"><label for="phone">Phone</label></form>`),
    htmlResponse(`<form action="/auth/realms/resource/login-actions/authenticate?session_code=s3&execution=e3&tab_id=t3" method="post"><input name="otp"></form>`),
    htmlResponse(`<html><head><title>OTP failed</title></head><body><form action="/auth/realms/resource/login-actions/authenticate?session_code=s4&execution=e4&tab_id=t4" method="post"><input name="otp"></form><p>Invalid authenticator code.</p></body></html>`)
  ];

  await assert.rejects(
    authenticateWithApi({
      keycloakState: 'state-value',
      keycloakNonce: 'nonce-value',
      fetchImpl: async () => responses.shift(),
      diagnosticsRecorder: {
        event(name, details) {
          events.push({ name, details });
        }
      },
      credentialProvider: {
        async requestCredentials() {
          return {
            email: 'user@example.com',
            password: 'secret-password'
          };
        },
        async requestDeviceSelection(devices) {
          return devices[0];
        },
        async requestOtp() {
          otpPromptCount += 1;
          if (otpPromptCount > 1) {
            throw new Error('stop after reprompt');
          }
          return '654321';
        }
      }
    }),
    /stop after reprompt/
  );

  assert.equal(events.some((event) => event.name === 'otp_reprompt'), true);
  const serialized = JSON.stringify(events);
  assert.equal(serialized.includes('654321'), false);
  assert.equal(serialized.includes('secret-password'), false);
  assert.equal(serialized.includes('session_code=s4'), false);
});

test('authenticateWithApi stops repeated Keycloak device form loops safely', async () => {
  let devicePromptCount = 0;
  const repeatedDeviceForm = `
    <html>
      <body>
        <form action="/auth/realms/resource/login-actions/authenticate?session_code=secret&execution=execution-id&tab_id=tab-id" method="post">
          <input type="radio" id="phone" name="credentialId" value="phone">
          <label for="phone">Phone</label>
        </form>
        <script>const password = "secret-password"; const otp = "123456";</script>
      </body>
    </html>
  `;

  await assert.rejects(
    authenticateWithApi({
      keycloakState: 'state-value',
      keycloakNonce: 'nonce-value',
      maxApiAuthSteps: 3,
      fetchImpl: async () => htmlResponse(repeatedDeviceForm),
      credentialProvider: {
        async requestCredentials() {
          throw new Error('credentials should not be requested');
        },
        async requestDeviceSelection(devices) {
          devicePromptCount += 1;
          return devices[0];
        },
        async requestOtp() {
          throw new Error('otp should not be requested');
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /stopped after 3 Keycloak form steps/);
      assert.match(error.message, /Forms: 1 \(device\)/);
      assert.equal(error.message.includes('secret-password'), false);
      assert.equal(error.message.includes('123456'), false);
      assert.equal(error.message.includes('session_code=secret'), false);
      return true;
    }
  );
  assert.equal(devicePromptCount, 3);
});

test('authenticateWithApi reports safe diagnostics when Keycloak returns no supported form', async () => {
  await assert.rejects(
    authenticateWithApi({
      keycloakState: 'state-value',
      keycloakNonce: 'nonce-value',
      fetchImpl: async () => htmlResponse(`
        <html>
          <head><title>Login unavailable</title></head>
          <body><h1>Unexpected page</h1><p>No form rendered.</p><script>const token = "raw-token";</script></body>
        </html>
      `),
      credentialProvider: {
        async requestCredentials() {
          throw new Error('credentials should not be requested');
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /Current page: keycloak\.vinova\.sg\/auth\/realms\/resource\/protocol\/openid-connect\/auth/);
      assert.match(error.message, /Status: 200/);
      assert.match(error.message, /Forms: 0/);
      assert.match(error.message, /Title: Login unavailable/);
      assert.equal(error.message.includes('<script>'), false);
      assert.equal(error.message.includes('raw-token'), false);
      assert.equal(error.message.includes('password='), false);
      assert.equal(error.message.includes('Cookie'), false);
      return true;
    }
  );
});

test('authenticateWithApi reports safe unsupported form field diagnostics', async () => {
  await assert.rejects(
    authenticateWithApi({
      keycloakState: 'state-value',
      keycloakNonce: 'nonce-value',
      fetchImpl: async () => htmlResponse(`
        <html>
          <head><title>Unsupported login</title></head>
          <body>
            <form action="/unsupported" method="post">
              <input name="mystery" value="hidden-secret">
              <input name="country_code" id="country-code" value="84">
            </form>
          </body>
        </html>
      `),
      credentialProvider: {
        async requestCredentials() {
          throw new Error('credentials should not be requested');
        }
      }
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /Forms: 1 \(unknown\)/);
      assert.match(error.message, /Fields: form1\{kind=unknown fields=\[mystery:text,country_code:text\]\}/);
      assert.equal(error.message.includes('hidden-secret'), false);
      assert.equal(error.message.includes('<input'), false);
      assert.equal(error.message.includes('password='), false);
      return true;
    }
  );
});

test('extractRoToken ignores Keycloak-shaped objects unless final token field is present', () => {
  const token = makeRoJwt({ id: 115, exp: futureExp() });
  const refreshToken = makeRoJwt({ id: 115, exp: futureExp() + 600 });
  assert.equal(extractRoToken({ data: { user: { token } } }), token);
  assert.equal(extractRoToken({ data: { auth: { accessToken: token } } }), token);
  assert.equal(extractRoToken({ result: { session: { jwt: token } } }), token);
  assert.deepEqual(extractRoSession({
    data: {
      auth: {
        accessToken: token,
        refreshToken
      }
    }
  }), {
    accessToken: token,
    refreshToken
  });
  assert.equal(extractRoSession({ refreshToken }), null);
  assert.equal(extractRoToken({ accessToken: makeKeycloakJwt() }), null);
  assert.equal(extractRoToken({ nope: 'missing' }), null);
});

test('exchangeSigninKeycloak accepts Resource Optimiser token from authorization header', async () => {
  const token = makeRoJwt({ id: 115, email: 'user@example.com', exp: futureExp() });
  const session = {
    async request(url, options) {
      assert.match(url, /\/auth\/signinKeyCloak$/);
      assert.equal(JSON.parse(options.body).accessToken, 'keycloak-token');
      return {
        status: 200,
        headers: new Headers({
          Authorization: `Bearer ${token}`
        }),
        body: JSON.stringify({ ok: true })
      };
    }
  };

  assert.equal(await exchangeSigninKeycloak(session, {
    apiBase: 'https://api.resourceoptimiser.com/api/v1',
    signinKeycloakPath: '/auth/signinKeyCloak',
    accessToken: 'keycloak-token'
  }), token);
});

test('exchangeSigninKeycloakSession returns Resource Optimiser access and refresh tokens', async () => {
  const accessToken = makeRoJwt({ id: 115, email: 'user@example.com', exp: futureExp() });
  const refreshToken = makeRoJwt({ id: 115, email: 'user@example.com', exp: futureExp() + 600 });
  const session = {
    async request() {
      return {
        status: 200,
        headers: new Headers(),
        body: JSON.stringify({
          data: {
            auth: {
              accessToken,
              refreshToken
            }
          }
        })
      };
    }
  };

  assert.deepEqual(await exchangeSigninKeycloakSession(session, {
    apiBase: 'https://api.resourceoptimiser.com/api/v1',
    signinKeycloakPath: '/auth/signinKeyCloak',
    accessToken: 'keycloak-token'
  }), {
    accessToken,
    refreshToken
  });
});

test('exchangeSigninKeycloak reports sanitized diagnostics without leaking tokens', async () => {
  const keycloakToken = makeKeycloakJwt();
  const session = {
    async request() {
      return {
        status: 200,
        headers: new Headers(),
        body: JSON.stringify({
          accessToken: keycloakToken,
          data: {
            user: {
              name: 'Example User'
            }
          }
        })
      };
    }
  };

  await assert.rejects(
    exchangeSigninKeycloak(session, {
      apiBase: 'https://api.resourceoptimiser.com/api/v1',
      signinKeycloakPath: '/auth/signinKeyCloak',
      accessToken: 'keycloak-token'
    }),
    (error) => {
      assert.equal(error.code, 'API_AUTH_FAILED');
      assert.match(error.message, /signinKeyCloak did not return a usable API token/);
      assert.match(error.message, /Status: 200/);
      assert.match(error.message, /JSON keys: accessToken, data, data.user, data.user.name/);
      assert.equal(error.message.includes(keycloakToken), false);
      assert.equal(error.message.includes('keycloak-token'), false);
      assert.equal(error.message.includes('Cookie'), false);
      return true;
    }
  );
});

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html'
    }
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}

function redirectResponse(location) {
  return new Response('', {
    status: 302,
    headers: {
      Location: location
    }
  });
}

function makeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature'
  ].join('.');
}

function makeRoJwt(payload = {}) {
  return makeJwt({
    id: 115,
    email: 'user@example.com',
    db_url: 'rp_vinova_prod',
    ...payload
  });
}

function makeKeycloakJwt(payload = {}) {
  return makeJwt({
    iss: 'https://keycloak.vinova.sg/auth/realms/resource',
    azp: 'localhost',
    realm_access: {
      roles: ['offline_access']
    },
    ...payload
  });
}

function futureExp() {
  return Math.floor(Date.now() / 1000) + 60 * 60;
}
