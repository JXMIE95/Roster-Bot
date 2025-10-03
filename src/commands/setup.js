// src/commands/setup.js
import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder
} from 'discord.js';
import { q } from '../db/pool.js';
import { nowUtc } from '../util/time.js';
import { upsertDayMessage } from '../util/dayMessage.js';
import { rosterPanelComponents } from '../util/embeds.js'; // must export this from your util
import { hoursArray } from '../util/time.js';

// Helper: next 7 UTC dates as 'YYYY-MM-DD'
function next7DatesUtc() {
  const base = nowUtc().startOf('day');
  return Array.from({ length: 7 }, (_, i) => base.clone().add(i, 'day').format('YYYY-MM-DD'));
}

export default {
  data: {
    name: 'setup',
    description: 'Initial setup: create category, week channels, and post the roster panel'
  },

  execute: async (interaction) => {
    await interaction.deferReply({ ephemeral: true });

    const guild = interaction.guild;

    // 1) Create or reuse the "Buff Givers Roster" category
    let category;
    const wantedName = 'Buff Givers Roster';
    try {
      category = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name === wantedName
      );
      if (!category) {
        category = await guild.channels.create({
          name: wantedName,
          type: ChannelType.GuildCategory,
          permissionOverwrites: [
            // (Optional) everyone can read
            { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel] }
          ]
        });
      }
    } catch (e) {
      console.error('setup: category error', e);
      return interaction.editReply('⚠️ Could not create/find the category.');
    }

    // 2) Ensure 7 day channels exist (named YYYY-MM-DD), delete extras, and post/refresh the day embed
    const dates = next7DatesUtc();
    const keepNames = new Set(dates);

    // Remove any old date channels under the category that aren’t in the next 7
    try {
      const children = category.children ?? category; // discord.js v14: category.children is a ChannelManager-like
      for (const [, ch] of children.cache) {
        if (ch.type === ChannelType.GuildText && !keepNames.has(ch.name)) {
          await ch.delete().catch(() => {});
        }
      }
    } catch {}

    // For each date, ensure a text channel and upsert the roster message
    for (const date of dates) {
      let ch = category.children?.cache?.find(c => c.name === date);
      if (!ch) {
        ch = await guild.channels.create({
          name: date,
          type: ChannelType.GuildText,
          parent: category.id
        });
      }

      // Build empty slots structure (so message renders even before signups)
      const slots = hoursArray().map(h => ({
        hour: h,
        users: [],
        remaining: 2
      }));
      try {
        await upsertDayMessage(interaction.client, guild.id, ch, date, slots);
      } catch (e) {
        console.error('setup: upsertDayMessage error', e);
      }
    }

    // 3) Post the instructions embed + panel in the channel where /setup was used
    const panelChannel = interaction.channel;

    // Instructions embed (posted BEFORE the panel)
    const instructions = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('📖 Buff Giver Roster – How it Works')
      .setDescription(
        `This bot manages who is on duty as a **Buff Giver** in hourly slots (UTC).\n` +
        `• Each slot can have **up to 2 Buff Givers**\n` +
        `• The **King** is notified when assignees change\n` +
        `• Buff Givers get a **DM reminder** before their shift`
      )
      .addFields(
        {
          name: '📝 How to roster yourself',
          value:
            `1. Use the **📅 Date menu** below to pick a day\n` +
            `2. Choose:\n` +
            `   • ✅ **Add Hours** – sign up\n` +
            `   • ❌ **Remove Hours** – leave a shift\n` +
            `   • ✏️ **Edit My Hours** – adjust your hours`
        },
        {
          name: '🔔 Notifications',
          value:
            `• Buff Givers get a **DM reminder** before their shift\n` +
            `• The **King** gets a DM when assignees change\n` +
            `• When the King confirms, Buff Givers are DM’d to notify them they have been assigned`
        },
        {
          name: '⚔️ Roles',
          value:
            `The bot will **add the Buff Giver role** when your shift starts, and **remove it** when your shift ends.`
        }
      )
      .setFooter({ text: '👉 Roster your hours, check your DMs, be ready to give buffs!' });

    const panelDates = dates; // next 7 days for the dropdown
    const components = rosterPanelComponents(panelDates); // uses your util to build dropdown + buttons

    // Send instructions first, then the panel
    const instrMsg = await panelChannel.send({ embeds: [instructions] }).catch(() => null);
    if (!instrMsg) {
      return interaction.editReply('⚠️ Could not post the instructions embed.');
    }

    const panelMsg = await panelChannel.send({ components }).catch(() => null);
    if (!panelMsg) {
      return interaction.editReply('⚠️ Could not post the roster panel.');
    }

    // 4) Save ids to DB for later updates
    await q(
      `INSERT INTO guild_settings (guild_id, category_id, panel_channel_id, panel_message_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (guild_id)
       DO UPDATE SET category_id=EXCLUDED.category_id,
                     panel_channel_id=EXCLUDED.panel_channel_id,
                     panel_message_id=EXCLUDED.panel_message_id`,
      [guild.id, category.id, panelChannel.id, panelMsg.id]
    );

    await interaction.editReply('✅ Setup complete! Posted instructions and the roster panel.');
  }
};