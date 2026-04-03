# Rocket.Chat RSS

Universal and flexible RSS feed client for Rocket.Chat, built on the official Apps-Engine.

## Features

- recurring feed polling through the Rocket.Chat Apps scheduler
- RSS 2.0 and Atom feed parsing
- persistent feed subscriptions stored in app persistence
- per-subscription target room and polling interval
- global, per-channel, and per-subscription delivery identity overrides
- deduplication of previously seen entries
- safe bootstrap behavior that stores current items without flooding rooms on subscribe
- optional dry-run mode for validation before enabling delivery
- slash-command driven operations for subscribe, config, list, pause, resume, test, run, and remove

## Stack

- Rocket.Chat Apps-Engine
- Rocket.Chat Apps CLI (`rc-apps`)
- TypeScript

## References

- Rocket.Chat Apps-Engine overview: <https://developer.rocket.chat/docs/rocketchat-apps-engine>
- Getting started: <https://developer.rocket.chat/v1/docs/getting-started-with-apps-engine>
- Slash commands: <https://developer.rocket.chat/docs/slash-commands>
- App settings: <https://developer.rocket.chat/docs/app-settings>

## Project layout

- `app.json`: Rocket.Chat app manifest
- `RssFeedApp.ts`: main app entrypoint
- `commands/`: slash commands
- `config/`: app settings
- `lib/`: RSS domain/service helpers

## Local setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Install the Rocket.Chat CLI if needed:

   ```bash
   npm install -g @rocket.chat/apps-cli
   ```

3. Package the app:

   ```bash
   npm run package
   ```

4. Deploy to a workspace:

   ```bash
   rc-apps deploy --url <server_url> -u <user> -p <password>
   ```

## Commands

- `/rss help`
- `/rss subscribe <feed-url> [#channel] [interval-minutes]`
- `/rss config global [show|set|clear] [logo|display-name|username] [value]`
- `/rss config <#channel> [show|set|clear] [logo|display-name|username] [value]`
- `/rss config <subscription-id|feed-url> [show|set|clear] [logo|display-name|username] [value]`
- `/rss list`
- `/rss remove <subscription-id|feed-url>`
- `/rss pause <subscription-id|feed-url>`
- `/rss resume <subscription-id|feed-url>`
- `/rss run [subscription-id|feed-url]`
- `/rss test <feed-url>`

## Settings

- `Default poll interval minutes`
- `Default target channel`
- `Default user pinning`
- `Request timeout ms`
- `User agent`
- `Dry run mode`
- `Logging level`

`Dry run mode` is enabled by default. While it is enabled, feeds are fetched, parsed, deduplicated, and tracked, but scheduled or manual runs will not post messages into channels.

## Branding and Sender Overrides

- `logo` expects a publicly reachable `https://` image URL. The app uses it as the per-message avatar override.
- `display-name` sets the visible alias shown for messages sent by the app user.
- `username` accepts `app` or an existing Rocket.Chat username such as `@newsbot`. When you point to an existing user or bot, the app sends as that account instead of the built-in app user.

Examples:

```text
/rss config global set logo https://example.com/rocketchat-rss-logo.png
/rss config global set display-name RocketChat RSS
/rss config global set username @newsbot
/rss config #security set display-name Security Feeds
/rss config rss-abc123 set username app
```
