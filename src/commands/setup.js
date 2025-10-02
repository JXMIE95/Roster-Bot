import { PermissionsBitField, ChannelType } from 'discord.js';
import { q } from '../db/pool.js';
import { rosterPanelEmbed, rosterPanelComponents, dayRosterPayload } from '../util/embeds.js';
import { nowUtc } from '../util/time.js';
import { upsertDayMessage } from '../util/dayMessage.js';

function next7Dates() {
  const d0 = nowUtc().startOf('day');
  return Array.from({length:7}, (_,i)=>d0.add(i,'day').format('YYYY-MM-DD'));
}

export default {
  data: {
    name: 'setup',
    description: 'Initial setup: category, panel, day channels (7 days)'
  },
  execute: async (interaction) => {
    if (!interaction.memberPermissions.has(PermissionsBitField.Flags.Administrator))
      return interaction.reply({ content: 'Admin only.', ephemeral: true });

    await interaction.deferReply({ ephemeral: true });

    const categoryName = 'Buff Givers Roster';
    let category = interaction.guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === categoryName);
    if (!category) category = await interaction.guild.channels.create({ name: categoryName, type: ChannelType.GuildCategory });

    let panelChannel = interaction.guild.channels.cache.find(c => c.name === 'roster-panel');
    if (!panelChannel) panelChannel = await interaction.guild.channels.create({ name: 'roster-panel', parent: category.id, type: ChannelType.GuildText });

    await q(`INSERT INTO guild_settings(guild_id, category_id, panel_channel_id)
             VALUES ($1,$2,$3)
             ON CONFLICT (guild_id) DO UPDATE SET category_id=EXCLUDED.category_id, panel_channel_id=EXCLUDED.panel_channel_id`,
      [interaction.guildId, category.id, panelChannel.id]);

    const dates = next7Dates();
    const panelMsg = await panelChannel.send({ embeds: [rosterPanelEmbed()], components: rosterPanelComponents(dates) });
    await q(`UPDATE guild_settings SET panel_message_id=$1 WHERE guild_id=$2`, [panelMsg.id, interaction.guildId]);

    // Ensure channels and one known message per day
    for (const d of dates) {
      let ch = interaction.guild.channels.cache.find(c => c.parentId === category.id && c.name === d);
      if (!ch) ch = await interaction.guild.channels.create({ name: d, parent: category.id, type: ChannelType.GuildText });
      const slots = Array.from({length:24},(_,h)=>({ hour:h, users:[], remaining:2 }));
      await upsertDayMessage(interaction.client, interaction.guildId, ch, d, slots);
    }

    await interaction.followUp({ content: 'Setup complete. Day channels created and roster messages will update in-place.', ephemeral: true });
  }
};
