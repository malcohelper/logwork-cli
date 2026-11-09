---
name: logwork
description: Log work hours to Resource Optimiser (RO) and Jira from the user's own git commits with the logwork MCP tools. Use when the user asks to log work, fill in logwork or timesheets for a day or week, check missing hours, or fix existing RO entries.
---

# Logwork from commits

Goal: every logged line is backed by real work (the user's commits or what the user tells you), uses a valid RO worklog task, has a clear description, and fits the day's booked hours.

## Steps

1. **Find the gaps.** Call `get_logwork` for the period. A day/project still needs time when booked > logged. Skip days that are already full.
2. **Collect the evidence.** Call `draft_from_commits` with the same period and `repos` set to every repo the user worked in (the open workspace folders; ask the user for others). It groups the user's commits per day by repo, ticket and kind of work, suggests a worklog task per group, picks each group's RO project (a `map_project` mapping whose `repos` holds the repo, else ticket/keyword mappings and that day's bookings), and splits each project's remaining RO hours across its groups. It returns `draftText` and `projectOverrides` (preview entry id → `projectMemberId`). Treat its hours as a starting point, not a fact.
3. **Check the worklog tasks.** For each project involved, call `list_tasks(projectId)`. Keep the suggested task when it exists in that catalog; otherwise pick the catalog task whose description matches the work.
4. **Write the descriptions.** One line per piece of work: what was done and the outcome, with ticket keys, in English, under about 200 characters, no `|`. Rewrite vague commit subjects ("wip", "fix", "update"); use `get_jira_issue` to read the ticket when the subject alone is unclear.
5. **Set the hours.**
   - Stay within the remaining booked hours per day and project unless the user says otherwise. The draft already gives each project at most its own remaining hours; lines without a project share the room of booked projects no other line claimed. A project with no room left gets 0h, and the summary says so.
   - If `draft_from_commits` returns `authRequired`, call `login` first; do not guess hours without RO.
   - Use 0.5h steps.
   - Do not log weekends or days without a booking unless the user asks.
   - Work without commits (meetings, reviews, support) only comes from the user; ask, then log it as `Other Activities` or `Code Review & Refactoring`.
6. **Resolve projects.** The draft's `projectOverrides` already name the project of every resolved line. For each repo in `unmappedRepos` (lines with no project):
   - Take the top entry of `repoSuggestions[repo]` (ranked by ticket history, repo/remote name and single booked project; `reasons` say why).
   - Ask one short question per repo, by project name: "Is `<repo name>` part of **<projectName>**? (<first reason>)". With no suggestion, ask which project it belongs to and offer names from `projectCandidates`.
   - On a yes (or the user's own pick), call `map_project` with `projectName` (or that suggestion's `projectMemberId`), `repos: [repo]` and `confirm: true`. Never ask the user for ids.
   - Then run `draft_from_commits` again so those lines get their project and hours.
   A line `log_work` still cannot resolve: ask the user and add its id to `projectOverrides`.
7. **Get approval, then write.**
   - Show the final block to the user.
   - On approval, call `log_work(text, projectOverrides)` and show its preview summary. Pass `projectOverrides` from the draft unchanged when `draftText` is unchanged. Entry ids are `<date>-<NN>` with NN counting lines through the whole text, so if you add, remove or reorder lines, renumber the overrides to match.
   - If the preview flags `possibleDuplicate` entries, show the warnings. They match an existing RO entry (or an earlier line) on date, worklog task, hours and description. Usually drop those lines and preview again. Pass `allowDuplicates: true` on the confirm call only when the user says it is really new work.
   - Then call `log_work(batchId, confirm: true)`.
   - If the user also logs Jira, do the same with `log_jira_work`. Jira needs exactly one issue key per line.

## Line format

```text
Friday, 06 Nov 2026
+2 Feature Development | Implement SSO login with ADFS (STM-4)
+1 Bug Fix | Fix date picker timezone offset (SAP-42)
```

`+<hours> <worklog task> | <description>`. The task is an RO catalog name or `#<id>`.

## Rules

- Never invent work that is not in the commits or in what the user told you. When unsure, ask.
- Never set `confirm: true` without the user's explicit approval of that preview.
- Never ask for or pass passwords, OTPs or tokens. On `authRequired`, call `login` and let the user finish in the terminal.
- To fix an existing entry, use `edit_entry` (submitted or approved entries) or `resubmit_entry` (rejected entries). Do not log a duplicate.
