# no-limit

A [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview) that picks your session back up once the usage limit that stopped it resets.

Hit the 5-hour limit in the middle of a task and walk away. no-limit reads when the limit resets, waits it out, and sends Claude a prompt to carry on where it left off. No tmux, no scripts, and it works the same on macOS, Linux and Windows.

## Install

You need Claude Code v2.1.287 or later (`claude --version`).

```bash
claude plugin marketplace add longmaba/no-limit
claude plugin install no-limit@longmaba-mods
```

Or from inside a session: `/plugin install no-limit --marketplace longmaba/no-limit`. Run `/reload-plugins` if a session was already open.

To try it once without installing, clone the repository and run `claude --plugin-dir ./no-limit`.

## What you see

- **The footer**, at the right under the prompt:
  - `∙∙●∙∙ no-limit · 5h 15%` while it's watching, with your 5-hour usage
  - `(-.-) zZ resets in 1h 12m` while it waits for a reset
  - `\(^o^)/ back to work` for a moment after it resumes
- **A band above the prompt** while it waits, with a progress bar, the countdown, and **Resume now**, **Cancel** and **Details** buttons
- **A dashboard** (`/no-limit`): usage bars for the 5-hour and weekly windows, the wait's progress, the resume prompt (editable), and the last few resumes

## Commands

| Command | What it does |
| --- | --- |
| `/no-limit` | Open the dashboard |
| `/no-limit status` | Print what's pending |
| `/no-limit now` | Resume right away |
| `/no-limit cancel` | Drop the pending resume |
| `/no-limit off` / `on` | Stop or start resuming automatically |
| `/no-limit anim off` / `on` | Keep the footer still, or animate it |
| `/no-limit message <text>` | Set the prompt sent on resume (no text puts the default back) |
| `/no-limit test [minutes]` | Pretend the limit was hit, to see it work (default 1 minute) |

Typing your own prompt while it waits cancels the pending resume: you're back, so your prompt wins.

## How it works

- When a turn stops with a `rate_limit` error, it reads the rate-limit windows Claude Code tracks for your account. It waits for the latest reset among the windows that are full, or the 5-hour window's when none reads full, plus one minute.
- It checks the clock every 30 seconds instead of setting one long timer, so a laptop that slept through the reset still resumes once it wakes.
- If no reset time is reported it waits 15 minutes, then 30, then 60. A limit hit right after a resume counts as a retry, and it stops after 5 resumes in a row that hit the limit again.
- Settings (on/off, animation, the resume prompt) and the resume history are kept across sessions.

## Limits

- **Claude Code has to stay open.** The mod runs inside Claude Code, so if you close the terminal, nothing resumes the session.
- The footer, band and dashboard show in the terminal and the Code tab of the desktop app only. A `claude -p` run ends before any reset, so there's nothing to resume there.

## Trust

A mod is code that runs with your permissions. To see what this one hooks and calls before installing, clone it and run `claude plugin validate ./no-limit`. It reads your rate-limit figures, keeps its settings in Claude Code's plugin store, and submits one prompt per resume. It makes no network requests and touches no files.

## Development

```bash
claude plugin validate --strict .
claude plugin test .
```

Tested with Claude Code 2.1.289. Mods are early access, and the API can change between releases.

## License

MIT
