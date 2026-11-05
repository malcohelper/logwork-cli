#!/usr/bin/env node

import { intro, outro } from '@clack/prompts';
import { CONFIG } from './config.mjs';
import {
  installSignalHandlers,
  parseArgs,
  removeLock,
  writeResult
} from './lib/protocol.mjs';
import { readCommitMessage } from './lib/git-message.mjs';
import { getFreshToken, getUserIdFromJwt } from './lib/auth.mjs';
import {
  addLogtime,
  ApiError,
  getTodayTimesheetProjects
} from './lib/api.mjs';
import {
  closeTerminalWindowByTitle,
  focusTerminalWindowByTitle,
  setTerminalTitle
} from './lib/macos.mjs';
import * as ui from './lib/ui.mjs';
import { todayLocalDateISO } from './lib/util.mjs';

const args = parseArgs(process.argv.slice(2));
const shouldManageTerminalWindow = args.closeTerminal !== 'false';

await setTerminalTitle(args.terminalTitle);
installSignalHandlers(args);

let finalStatus = CONFIG.resultValues.abort;
let reason = 'unknown';

try {
  intro('Logwork Helper');

  const localDateISO = todayLocalDateISO();
  const defaultMessage = await readCommitMessage(args.msgFile);

  let token = await getFreshToken({
    loginUrl: CONFIG.loginUrl,
    tokenKey: CONFIG.tokenKey,
    allowedHosts: CONFIG.allowedSafariHosts,
    terminalTitle: args.terminalTitle
  });

  let userId = getUserIdFromJwt(token);

  let projects;
  let daySummaries;

  try {
    ({ projects, daySummaries } = await loadProjectData(token, userId, localDateISO));
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401) {
      throw error;
    }

    token = await getFreshToken({
      loginUrl: CONFIG.loginUrl,
      tokenKey: CONFIG.tokenKey,
      allowedHosts: CONFIG.allowedSafariHosts,
      terminalTitle: args.terminalTitle,
      forceLogin: true
    });

    userId = getUserIdFromJwt(token);
    ({ projects, daySummaries } = await loadProjectData(token, userId, localDateISO));
  }

  const shouldLog = await ui.askShouldLog();

  if (!shouldLog) {
    ui.printTodaySummary(projects, daySummaries);
    finalStatus = CONFIG.resultValues.skip;
    reason = 'user skipped logwork';
    outro('Commit allowed without logging work.');
  } else {
    const project = await ui.chooseProject(projects, daySummaries);
    const taskName = await ui.chooseMessageSource(defaultMessage);
    const hours = await ui.askHours(CONFIG.defaultHours);

    await ui.confirmSubmit({
      projectName: project.projectName,
      hours,
      taskName,
      localDateISO
    });

    let result;
    try {
      result = await addLogtime(token, {
        projectMemberId: project.projectMemberId,
        logtimes: hours,
        taskName,
        localDateISO
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) {
        throw error;
      }

      token = await getFreshToken({
        loginUrl: CONFIG.loginUrl,
        tokenKey: CONFIG.tokenKey,
        allowedHosts: CONFIG.allowedSafariHosts,
        terminalTitle: args.terminalTitle,
        forceLogin: true
      });

      userId = getUserIdFromJwt(token);
      ({ projects, daySummaries } = await loadProjectData(token, userId, localDateISO));
      result = await addLogtime(token, {
        projectMemberId: project.projectMemberId,
        logtimes: hours,
        taskName,
        localDateISO
      });
    }

    if (result?.dryRun) {
      ui.showSuccess('DRY RUN: payload generated; no API write performed.');
    } else {
      ui.showSuccess('Logtime submitted successfully.');
    }

    finalStatus = CONFIG.resultValues.ok;
    reason = result?.dryRun ? 'dry-run' : 'submitted';
  }
} catch (error) {
  ui.showError(error);
  finalStatus = CONFIG.resultValues.abort;
  reason = error?.message || 'error';
  process.exitCode = 1;
} finally {
  await writeResult({
    resultPath: args.result,
    nonce: args.nonce,
    status: finalStatus,
    reason
  }).catch(() => {});

  await removeLock(args.lock).catch(() => {});

  if (!shouldManageTerminalWindow) {
    // Manual runs happen in the caller's terminal, so leave the window alone.
  } else if (finalStatus === CONFIG.resultValues.ok || finalStatus === CONFIG.resultValues.skip) {
    await closeTerminalWindowByTitle(args.terminalTitle).catch(() => {});
  } else {
    await focusTerminalWindowByTitle(args.terminalTitle).catch(() => {});
  }
}

async function loadProjectData(token, userId, localDateISO) {
  const projects = await getTodayTimesheetProjects(token, userId, localDateISO);
  if (!projects.length) {
    throw new Error('Chưa được book ngày hôm nay.');
  }

  const daySummaries = projects.map((project) => ({
    projectId: project.projectId,
    totalHours: project.loggedHours,
    logs: project.raw,
    ok: true
  }));

  return { projects, daySummaries };
}
