// src/registerCommands.js
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const cmds = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Initial setup: category, panel, day channels (7 days)'),

  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Roster panel controls')
    .addSubcommand(s =>
      s.setName('post').setDescription('Post or refresh the roster panel')
    ),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Configure bot settings')
    .addSubcommand(s =>
      s.setName('kingrole')
        .setDescription('Set King role')
        .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('userlead')
        .setDescription('Set user reminder lead minutes')
        .addIntegerOption(o => o.setName('minutes').setDescription('Minutes').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('kinglead')
        .setDescription('Set King change-lead minutes')
        .addIntegerOption(o => o.setName('minutes').setDescription('Minutes').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('buffrole')
        .setDescription('Set the Buff Giver role (active slot role)')
        .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))
    )
    // ✅ Added R5 subcommand here
    .addSubcommand(s =>
      s.setName('r5role')
        .setDescription('Set the R5 role (can assign King)')
        .addRoleOption(o => o.setName('role').setDescription('Role').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('show').setDescription('Show current configuration')
    ),

  new SlashCommandBuilder()
    .setName('roster')
    .setDescription('Roster queries')
    .addSubcommand(s =>
      s.setName('list')
        .setDescription('List a day')
        .addStringOption(o => o.setName('date').setDescription('YYYY-MM-DD').setRequired(true))
    )
    .addSubcommand(s =>
      s.setName('my').setDescription('Show my upcoming slots')
    ),

  new SlashCommandBuilder()
    .setName('kingnotify')
    .setDescription('King utilities')
    .addSubcommand(s => s.setName('now').setDescription('Notify current hour assignees (DMs)'))
    .addSubcommand(s =>
      s.setName('slot')
        .setDescription('Notify a specific slot (DMs)')
        .addStringOption(o => o.setName('date').setDescription('YYYY-MM-DD').setRequired(true))
        .addIntegerOption(o => o.setName('hour').setDescription('0-23').setRequired(true))
    )
].map(c => c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  const appId = process.env.DISCORD_APP_ID; // your Application (Client) ID
  const guildId = process.env.GUILD_ID;     // optional: register to a guild for instant updates
  if (!appId) throw new Error('Missing DISCORD_APP_ID');
  if (!process.env.DISCORD_TOKEN) throw new Error('Missing DISCORD_TOKEN');

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(appId, guildId), { body: cmds });
    console.log('Registered slash commands to guild:', guildId);
  } else {
    await rest.put(Routes.applicationCommands(appId), { body: cmds });
    console.log('Registered slash commands globally.');
  }
}

main().catch(console.error);