// src/commands/setup.js
import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder
} from 'discord.js';
import { q } from '../db/pool.js';
import { nowUtc } from '../util/time.js';
import { upsertDayMessage } from '../util/dayMessage.js';
import { rosterPanelComponents, kingAssignmentEmbed, kingAssignmentComponents } from '../util/embeds.js';
import { hoursArray } from '../util/time.js';

// Helper: next 7 UTC dates as 'YYYY-MM-DD'
function next7DatesUtc() {
  const base = nowUtc().startOf('day');
  return Array.from({ length: 7 }, (_, i) => base.clone().add(i, 'day').format('YYYY-MM-DD'));
}

export default {
  data: {
    name: 'setup',
    description: 'Create category, week channels, and post roster + king assignment panels'
  },

  execute: async (interaction) => {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;

    // 1) Create or reuse the "Buff Givers Roster" category
    let category;
    const categoryName = 'Buff Givers Roster';
    try {
      category = guild.channels.cache.find(
        c => c.type === ChannelType.GuildCategory && c.name === categoryName
      );
      if (!category) {
        category = await guild.channels.create({
          name: categoryName,
          type: ChannelType.GuildCategory,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel] }
          ]
        });
      }
    } catch (e) {
      console.error('setup: category error', e);
      return interaction.editReply('⚠️ Could not create/find the category.');
    }

    // 2) Create (or reuse) the two control channels under the category
    async function ensureText(name) {
      let ch = category.children?.cache?.find(c => c.type === ChannelType.GuildText && c.name === name);
      if (!ch) {
        ch = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: [
            { id: guild.roles.everyone.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
          ]
        });
      }
      return ch;
    }

    const rosterPanelChannel = await ensureText('roster-panel');
    const kingAssignmentChannel = await ensureText('king-assignment');

    // Put control channels at the very top of the category
    try {
      await rosterPanelChannel.setPosition(0).catch(() => {});
      await kingAssignmentChannel.setPosition(1).catch(() => {});
      // Fallback for some shards: force positions via edit
      await rosterPanelChannel.edit({ position: 0 }).catch(() => {});
      await kingAssignmentChannel.edit({ position: 1 }).catch(() => {});
    } catch (e) {
      console.warn('setup: could not pin control channels to top', e);
    }

    // 3) Ensure 7 day channels (named YYYY-MM-DD), delete extras, and upsert each day embed
    const dates = next7DatesUtc();
    const keepNames = new Set(dates);

    try {
      const children = category.children ?? category;
      for (const [, ch] of children.cache) {
        if (
          ch.type === ChannelType.GuildText &&
          /^\d{4}-\d{2}-\d{2}$/.test(ch.name) &&  // only consider date-named channels
          !keepNames.has(ch.name)
        ) {
          await ch.delete().catch(() => {});
        }
      }
    } catch {}

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
      const slots = hoursArray().map(h => ({ hour: h, users: [], remaining: 2 }));
      try {
        await upsertDayMessage(interaction.client, guild.id, ch, date, slots);
      } catch (e) {
        console.error('setup: upsertDayMessage error', e);
      }
    }

    // 4) Post the instructions embed + roster panel in #roster-panel
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
            `   \n✅ **Add Hours** – select your availability\n` +
            `   \n❌ **Remove Hours** – leave a shift\n` +
            `   \n✏️ **Edit My Hours** – adjust your hours`
        },
        {
          name: '🔔 Notifications',
          value:
            `- Buff Givers get a **DM reminder** before their shift\n` +
            `- The **King** gets a DM when assignees change\n` +
            `- When the King confirms, Buff Givers are DM’d to notify them they have been assigned`
        },
        {
          name: '⚔️ Roles',
          value:
            `The bot will **add the Buff Giver role** when your shift starts, and **remove it** when your shift ends.`
        }
      )
      .setFooter({ text: '👉 Roster your hours, check your DMs, be ready to give buffs!' });

    const panelComponents = rosterPanelComponents(dates);
    const instrMsg = await rosterPanelChannel.send({ embeds: [instructions] }).catch(() => null);
    if (!instrMsg) return interaction.editReply('⚠️ Could not post the instructions embed in #roster-panel.');

    const panelMsg = await rosterPanelChannel.send({ components: panelComponents }).catch(() => null);
    if (!panelMsg) return interaction.editReply('⚠️ Could not post the roster panel in #roster-panel.');

    // 5) Post the King Assignment panel in #king-assignment
    try {
      const kaEmbed = kingAssignmentEmbed();
      const kaComponents = kingAssignmentComponents(); // single "Grant King" selector (no revoke)
      await kingAssignmentChannel.send({ embeds: [kaEmbed] });
      await kingAssignmentChannel.send({ components: kaComponents });
    } catch (e) {
      console.error('setup: king assignment panel error', e);
      // Non-fatal
    }

    // 6) Save roster panel ids (schema only has one set of fields; store the roster-panel there)
    await q(
      `INSERT INTO guild_settings (guild_id, category_id, panel_channel_id, panel_message_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (guild_id)
       DO UPDATE SET category_id=EXCLUDED.category_id,
                     panel_channel_id=EXCLUDED.panel_channel_id,
                     panel_message_id=EXCLUDED.panel_message_id`,
      [guild.id, category.id, rosterPanelChannel.id, panelMsg.id]
    );

    await interaction.editReply('✅ Setup complete! Created category, pinned **#roster-panel** and **#king-assignment** above date channels, and posted both panels.');
  }
};