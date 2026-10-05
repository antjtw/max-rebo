# Setting up the Discord bot

Step-by-step from SPEC §19.2. Takes about ten minutes. You need "Manage Server" on your Discord server.

## 1. Create the application

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) → **Applications** → **New Application**. Name it **Cantina**.
2. On **General Information**, copy the **Application ID** into `.env` as `DISCORD_CLIENT_ID`.

## 2. Create the bot user

1. Open the **Bot** tab and click **Reset Token**. Copy the token into `.env` as `DISCORD_TOKEN`.
   Never share it, paste it in chat, or commit it. If it leaks, reset it again.
2. Under **Privileged Gateway Intents**, switch on **Message Content Intent**. (Only needed for text-chat triggers and dice bot parsing.)
3. Optional: switch off **Public Bot** so only you can invite it.

## 3. Invite it to your server

1. Open **OAuth2 → URL Generator**.
2. Scopes: tick `bot` and `applications.commands`.
3. Bot permissions: tick **View Channels**, **Send Messages**, **Embed Links**, **Read Message History**, **Connect**, **Speak**, **Use Voice Activity**. Optionally **Change Nickname** (for the "· listening" suffix) and **Priority Speaker**.
4. Copy the generated URL, open it in your browser, choose your server and authorise.

## 4. Collect the IDs

1. In Discord: **User Settings → Advanced → Developer Mode** on.
2. Right-click your server → **Copy Server ID** → `.env` `DISCORD_GUILD_ID`.
3. Right-click yourself → **Copy User ID** → `config/settings.yaml` `discord.gmUserId`.
4. Copy `config/players.example.yaml` to `config/players.yaml` (gitignored) and fill in each player's user ID, character name and aliases.
5. Right-click the text channel for announcements → **Copy Channel ID** → `config/settings.yaml` `discord.announceChannelId`. Add the same ID to `discord.textTriggerChannelIds` if you want typed cues to fire SFX.

## 5. Run it

```sh
npm run doctor              # everything should be green or explain what's missing
npm run commands:register   # registers the slash commands in your server (instant)
npm run dev                 # starts core, ears and the dashboard on http://127.0.0.1:4242
```

Join a voice channel. The bot follows you in within a few seconds (or type `/join`).

## Troubleshooting

| Symptom                       | Fix                                                                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `Token invalid` at start-up   | Reset the token in the portal and paste the new one into `.env`.                                                                             |
| Slash commands missing        | Re-run `npm run commands:register`; check `DISCORD_GUILD_ID`.                                                                                |
| Voice closes with code `4017` | The DAVE (end-to-end encryption) library is missing or out of date. Run `npm run doctor`, then `npm update @discordjs/voice @snazzah/davey`. |
| Bot joins but is silent       | Check the bot has **Speak** in that channel and that the music layer isn't muted in the dashboard.                                           |
| Text triggers do nothing      | Message Content Intent must be on, and the channel must be in `textTriggerChannelIds`.                                                       |
