import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const cmds = [
  new SlashCommandBuilder().setName('setup').setDescription('Initial setup: category, panel, day channels (7 days)'),
  new SlashCommandBuilder().setName('panel').setDescription('Roster panel controls')
    .addSubcommand(s=>s.setName('post').setDescription('Post or refresh the roster panel')),
  new SlashCommandBuilder().setName('config').setDescription('Configure bot settings')
    .addSubcommand(s=>s.setName('kingrole').setDescription('Set King role')
      .addRoleOption(o=>o.setName('role').setDescription('Role').setRequired(true)))
    .addSubcommand(s=>s.setName('userlead').setDescription('Set user reminder lead minutes')
      .addIntegerOption(o=>o.setName('minutes').setDescription('Minutes').setRequired(true)))
    .addSubcommand(s=>s.setName('kinglead').setDescription('Set King change-lead minutes')
      .addIntegerOption(o=>o.setName('minutes').setDescription('Minutes').setRequired(true))),
  new SlashCommandBuilder().setName('roster').setDescription('Roster queries')
    .addSubcommand(s=>s.setName('list').setDescription('List a day')
      .addStringOption(o=>o.setName('date').setDescription('YYYY-MM-DD').setRequired(true)))
    .addSubcommand(s=>s.setName('my').setDescription('Show my upcoming slots')),
  new SlashCommandBuilder().setName('kingnotify').setDescription('King utilities')
    .addSubcommand(s=>s.setName('now').setDescription('Notify current hour assignment(s)'))
    .addSubcommand(s=>s.setName('slot').setDescription('Notify specific slot')
      .addStringOption(o=>o.setName('date').setDescription('YYYY-MM-DD').setRequired(true))
      .addIntegerOption(o=>o.setName('hour').setDescription('0-23').setRequired(true)))
].map(c=>c.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

async function main() {
  await rest.put(Routes.applicationCommands(process.env.DISCORD_APP_ID), { body: cmds });
  console.log('Registered slash commands globally.');
}
main().catch(console.error);
