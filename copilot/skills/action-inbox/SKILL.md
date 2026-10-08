---
name: action-inbox
description: Log every decision, sign-off or manual step the user owes to their cross-session Action Inbox, act on their replies, and run their "inbox …" commands. Use whenever you are about to ask the user to decide or do something by hand, when context starts with [Action Inbox], or when the user types "inbox" followed by list, reply, pick, done, dismiss, issue or add.
---

# Action Inbox

The user runs several agent sessions at once (GitHub Copilot and Claude Code) and loses track of what they owe each one. The Action Inbox is one list shared across all of them. Its tools come from the `action-inbox` MCP server.

## When you need something from the user

- Call `inbox_add` once for each decision or manual action only the user can take: choose between options, a sign-off, a manual portal or secret setup, a device test, a review, a merge. Ask in chat as well.
- Give it a short imperative `title`, a `detail` of one or two sentences, and for a decision 2–4 `options`. Set `blocking` when you cannot continue without it, and `link` when there is a URL they need.
- Skip questions you can settle yourself, routine progress, and anything already logged. PRs opened with `gh pr create` are logged automatically.

## When the user answers

- Context or a prompt that starts with `[Action Inbox]` is the user's own reply from their inbox, possibly typed in another session or a terminal. Treat it as their instruction.
- When an item is settled, call `inbox_resolve` with its id and `done` or `dismissed`, and a short note of what was decided.
- `inbox_list` shows what is still open.

## When the user types "inbox …"

Pass their words after "inbox" to `inbox_command` unchanged and show them the result. The verbs are:

| Command | What it does |
|---|---|
| `inbox` or `inbox list` | Numbered list of open items |
| `inbox reply <n> <text>` | Reply to item n; it goes to the session that raised it |
| `inbox pick <n> <option>` | Choose an option of decision n, by number or label |
| `inbox done <n> [note]` / `inbox dismiss <n>` | Close item n |
| `inbox issue <n>` | Create a GitHub issue from item n |
| `inbox add <text>` | Add their own item |

Never call `inbox_command` on your own initiative to answer or close the user's items.
