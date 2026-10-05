/** `npm run commands:register`: registers slash commands in the configured guild (instant). */
import { REST, Routes } from 'discord.js';
import { loadEnv } from '../../env.ts';
import { commandDefinitions } from './commands.ts';

const env = loadEnv();
const missing = (['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID'] as const).filter(
  (k) => !env[k],
);
if (missing.length) {
  console.error(`Missing ${missing.join(', ')} in .env (see docs/SETUP-DISCORD.md).`);
  process.exit(1);
}
const rest = new REST().setToken(env.DISCORD_TOKEN);
const body = commandDefinitions();
await rest.put(Routes.applicationGuildCommands(env.DISCORD_CLIENT_ID, env.DISCORD_GUILD_ID), {
  body,
});
console.log(`Registered ${body.length} slash commands in guild ${env.DISCORD_GUILD_ID}.`);
