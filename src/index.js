import 'dotenv/config';
import { Client, GatewayIntentBits, Collection, Events, Partials } from 'discord.js';
import setup from './commands/setup.js';
import panel from './commands/panel.js';
import configCmd from './commands/config.js';
import roster from './commands/roster.js';
import kingnotify from './commands/kingnotify.js';
import { onButton, onSelectMenu } from './interactions/buttons.js';
import { startTick } from './scheduler/tick.js';
import { startDailyMaintenance } from './scheduler/dailyMaintenance.js';

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel]
});

const commands = new Collection();
[setup, panel, configCmd, roster, kingnotify].forEach(c => commands.set(c.data.name, c));

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  startTick(client);
  startDailyMaintenance(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const cmd = commands.get(interaction.commandName);
      if (cmd) return cmd.execute(interaction);
    }
    if (interaction.isButton()) return onButton(interaction);
    if (interaction.isStringSelectMenu()) return onSelectMenu(interaction);
  } catch (e) {
    console.error(e);
    if (interaction.isRepliable()) {
      return interaction.reply({ content: 'Something went wrong.', ephemeral: true }).catch(()=>{});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
