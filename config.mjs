export const CONFIG = {
  apiBase: 'https://api.resourceoptimiser.com/api/v1',
  loginUrl: 'https://app.resourceoptimiser.com/vinova',
  tokenKey: 'vinova_access_token',

  allowedSafariHosts: [
    'app.resourceoptimiser.com'
  ],

  projectMembersPath: '/project-members/by-user',
  timesheetPath: '/member-logtime/timesheet',
  logworkEntriesPath: '/logwork/entries',
  logworkTaskDefaultsPath: '/logwork/tasks/defaults',

  pollMs: 500,
  hookTimeoutMs: 5 * 60 * 1000,
  loginPollMs: 2000,
  loginTimeoutMs: 5 * 60 * 1000,

  defaultHours: 1,
  standardDayHours: 8,
  hourStep: 0.5,
  dayLogConcurrency: 5,

  resultValues: {
    ok: 'ok',
    skip: 'skip',
    abort: 'abort'
  }
};
