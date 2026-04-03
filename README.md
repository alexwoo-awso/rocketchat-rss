# Rocket.Chat RSS

Universal and flexible RSS feed client for Rocket.Chat, built on the official Apps-Engine.

## Scope

This repository starts as a Rocket.Chat app scaffold focused on:

- workspace-level RSS polling configuration
- slash-command driven feed management
- a service layer that can evolve toward feed parsing, scheduling, persistence, and room delivery

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

## Current status

The scaffold already includes:

- app manifest and TypeScript config
- admin settings for polling defaults and delivery behavior
- `/rss help`
- `/rss subscribe <feed-url> [#channel]`

The actual feed retrieval, persistence, deduplication, and scheduled posting are intentionally left as the next implementation phase.
