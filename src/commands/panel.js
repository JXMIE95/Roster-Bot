import { q } from '../db/pool.js';
import { rosterPanelEmbed, rosterPanelComponents } from '../util/embeds.js';
import { nowUtc } from '../util/time.js';

function next7Dates() {
  const d0 = nowUtc().startOf('day');
  return Array.from({length:7}, (_,i)=>d0.add(i,'day').format('YYYY-MM-DD'));
}

export default {
  data: {
    name: 'panel',
    description: 'Roster panel controls',
    options: [{ name:'post', description:'Post or refresh the roster panel', type:1 }]
  },
  execute: async (interaction) => {
    if (interaction.options.getSubcommand() !== 'post') return;
    await interaction.deferReply({ ephemeral: true });
    const { rows } = await q(`SELECT panel_channel_id FROM guild_settings WHERE guild_id=$1`, [interaction.guildId]);
    if (!rows.length) return interaction.followUp({ content:'Run /setup first.', ephemeral: true });
    const ch = await interaction.guild.channels.fetch(rows[0].panel_channel_id);
    const dates = next7Dates();
    const msg = await ch.send({ embeds:[rosterPanelEmbed()], components: rosterPanelComponents(dates) });
    await q(`UPDATE guild_settings SET panel_message_id=$1 WHERE guild_id=$2`, [msg.id, interaction.guildId]);
    await interaction.followUp({ content: 'Panel posted.', ephemeral: true });
  }
};
