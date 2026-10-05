# Contributing

A few things about this project are unusual, and knowing them first saves time.

## The two halves move together

The computer companion is at the root and the watch software is in
[firmware/](firmware/). They share one wire contract — the messages that cross
the wifi between them. Change both sides together when that contract changes.

## Run the checks

```sh
bun install
bun run check     # type check, then the tests
```

If you touched the part that talks to the device, say in the pull request what
you could and could not verify. A passing test says nothing about whether sound
came out of a speaker.

## Keep secrets out

- `.dev.vars` holds your shared secret and is gitignored. Never commit it.
- Do not put a device id, token, MAC address, chat transcript, or raw
  machine-specific log into a commit, an issue, or a screenshot. The `/health`
  report is built so that it never carries any of those.

## Release both parts together

A release is one tag containing both parts. The checks are in
[documentation/releasing.md](documentation/releasing.md).

## Writing

Docs here are for people who may not be programmers. Prefer plain words to
jargon, describe what you did rather than the mechanism, and say plainly what has
not been verified. This matters most about audio: captions and logs are not proof
that the speaker made a sound.

## Reporting a problem

Use the forms in `.github/ISSUE_TEMPLATE/`. They ask for the setup commands and
the receiver log lines, and they remind you what to redact. Never include your
shared secret.
