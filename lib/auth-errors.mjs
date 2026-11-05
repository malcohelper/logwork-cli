export function createAuthRequiredError(message = authRequiredSummary()) {
  const error = new Error(message);
  error.code = 'AUTH_REQUIRED';
  return error;
}

export function isAuthRequiredError(error) {
  return error?.code === 'AUTH_REQUIRED';
}

export function authRequiredPayload(error) {
  return {
    status: 'auth_required',
    authRequired: true,
    command: 'logwork-helper auth login',
    summary: error?.message || authRequiredSummary()
  };
}

function authRequiredSummary() {
  return 'Resource Optimiser authentication required. Run `logwork-helper auth login` in a terminal, complete SSO/2FA there, then retry this MCP tool.';
}
