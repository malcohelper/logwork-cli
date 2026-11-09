---
name: logwork
description: Log work hours to Resource Optimiser (RO) and Jira from the user's own git commits with the logwork MCP tools. Use when the user asks to log work, fill in logwork or timesheets for a day or week, check missing hours, or fix existing RO entries.
---

# Logwork from commits

Goal: every logged line is backed by real work (the user's commits or what the user tells you), uses a valid RO worklog task, has a clear description, and fits the day's booked hours.

## Steps

1. **Find the gaps.** Call `get_logwork` for the period. A day/project still needs time when booked > logged. Skip days that are already full.
2. **Collect the evidence.** Call `draft_from_commits` with the same period and `repos` set to every repo the user worked in (the open workspace folders; ask the user for others). It groups the user's commits per day by repo, ticket and kind of work, suggests a worklog task per group, and splits each day's remaining RO hours across the groups. Treat its hours as a starting point, not a fact.
3. **Check the worklog tasks.** For each project involved, call `list_tasks(projectId)`. Keep the suggested task when it exists in that catalog; otherwise pick the catalog task whose description matches the work.
4. **Write the descriptions.** One line per piece of work: what was done and the outcome, with ticket keys, in English, under about 200 characters, no `|`. Rewrite vague commit subjects ("wip", "fix", "update"); use `get_jira_issue` to read the ticket when the subject alone is unclear.
5. **Set the hours.**
   - Stay within the remaining booked hours per day and project unless the user says otherwise. The draft splits the day's total; use each day's `remainingByProject` to move hours to the project the work belongs to.
   - If `draft_from_commits` returns `authRequired`, call `login` first; do not guess hours without RO.
   - Use 0.5h steps.
   - Do not log weekends or days without a booking unless the user asks.
   - Work without commits (meetings, reviews, support) only comes from the user; ask, then log it as `Other Activities` or `Code Review & Refactoring`.
6. **Resolve projects.** Ticket prefixes and mappings pick the project. If a line stays unresolved, ask the user and offer `map_project` so it is automatic next time.
7. **Get approval, then write.**
   - Show the final block to the user.
   - On approval, call `log_work(text)` and show its preview summary.
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
