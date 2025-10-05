// src/commands/setup.js
import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder
} from 'discord.js';
import { q } from '../db/pool.js';
import { nowUtc } from '../util/time.js';
import { upsertDayMessage } from '../util/dayMessage.js';
import {
  rosterPanelComponents,
  kingAssignmentEmbed,
  kingAssignmentComponents,
  buffManagerEmbed,
  buffManagerComponents
} from '../util/embeds.js';
import { hoursArray } from '../util/time.js';

// Helper: next 7 UTC dates as 'YYYY-MM-DD'
function next7DatesUtc() {
  const base = nowUtc().startOf('day');
  return Array.from({ length: 7 }, (_, i) => base.clone().add(i, 'day').format('YYYY-MM-DD'));
}

export default {
  data: {
    name: 'setup',
    description: 'Create category, user guide, panels, and 7 day roster channels'
  },

  execute: async (interaction) => {
    await interaction.deferReply({ ephemeral: true });
    const guild = interaction.guild;

    // 1) Create or reuse the "Buff Givers Roster" category
    let category;
    const categoryName = '〡🗓️〡Buff Givers Roster';
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

    // 2) Helper to create channels under the category
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

    // Create top-level control channels
    const userGuideChannel       = await ensureText('〡👨🏻‍🦯〡user-guide');
    const rosterPanelChannel     = await ensureText('〡✍🏻〡shift-sign-up-panel');
    const kingAssignmentChannel  = await ensureText('〡👑〡king-assignment');
    const buffManagerChannel     = await ensureText('〡👨🏻‍💻〡buff-givers-management-panel');

    // Put control channels at the top in correct order
    try {
      await userGuideChannel.setPosition(0).catch(() => {});
      await rosterPanelChannel.setPosition(1).catch(() => {});
      await kingAssignmentChannel.setPosition(2).catch(() => {});
      await buffManagerChannel.setPosition(3).catch(() => {});
      // Fallback edits for some shards
      await userGuideChannel.edit({ position: 0 }).catch(() => {});
      await rosterPanelChannel.edit({ position: 1 }).catch(() => {});
      await kingAssignmentChannel.edit({ position: 2 }).catch(() => {});
      await buffManagerChannel.edit({ position: 3 }).catch(() => {});
    } catch (e) {
      console.warn('setup: could not pin control channels to top', e);
    }

    // 3) Post the User Guide embed in #user-guide
    const guideEmbed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('💫 Buff Giver Roster – User Guide')
      .setDescription(
`Welcome to the **Buff Giver Roster System!**
This bot helps organize who’s on duty for buffs each hour, who’s King, and when reminders go out.

## 🧙‍♂️ Buff Givers – How to Sign Up
Go to the **#〡✍🏻〡shift-sign-up-panel** channel.

**Step 1:** Use the dropdown menu to select a date (up to 7 days ahead).  
**Step 2:** Choose an action:
- ✅ **Add Hours** – sign up for shifts  
- ❌ **Remove Hours** – leave a shift  
- ✏️ **Edit My Hours** – adjust your existing hours  

You must select **at least 2 consecutive hours**.  
The bot will confirm your selection privately.

## 💬 Reminders & Roles
- You’ll get a **DM reminder** before your shift begins.  
- The bot automatically **adds the Buff Giver role** at shift start.  
- It **removes the role** when your shift ends.  

Make sure your **DMs are open** so you don’t miss reminders.

## 👑 King – Managing the Roster

Only **R5** or **Admins** can assign or change the King role.  
When Buff Givers change, the King receives a DM.

In that DM, the King can:
- Press **Notify Assignees** to DM Buff Givers (once per slot)  
- Press **List Assignees** to copy who’s on duty

The King can also manually edit the buff givers roster and assign buff givers roles using **〡👨🏻‍💻〡buff-givers-management-panel**

## 🎖️ R5 – Role & Permissions

**R5's** can:
- Assign or remove the King in **〡👑〡king-assignment**.  

They do **not** need Manage Roles permission.

## 🔔 Reminders
- Buff Givers get DM reminders.  
- The King is notified when rosters change.  
- “Notify Assignees” can only be pressed **once per time slot**.

## 💡 Tips
- All times are **UTC**.  
- Always pick at least **2 consecutive hours**.  
- Keep DMs open for reminders.  
- If setup breaks, ask an R5 or Admin to run **/setup** again.

🫡 **Roster your hours, check your DMs, and be ready to give buffs!**`
      );

    try {
      await userGuideChannel.send({ embeds: [guideEmbed] });
    } catch (e) {
      console.error('setup: user guide embed error', e);
    }

    // 4) Ensure 7 date channels under the category (named YYYY-MM-DD)
    const dates = next7DatesUtc();
    const keepNames = new Set(dates);
    try {
      const children = category.children ?? category;
      for (const [, ch] of children.cache) {
        if (ch.type === ChannelType.GuildText && /^\d{4}-\d{2}-\d{2}$/.test(ch.name) && !keepNames.has(ch.name)) {
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

      const slots = hoursArray().map(h => ({ hour: h, users: [], remaining: 2 }));
      try {
        await upsertDayMessage(interaction.client, guild.id, ch, date, slots);
      } catch (e) {
        console.error('setup: upsertDayMessage error', e);
      }
    }

    // 5) Post roster panel in #roster-panel
    const instructions = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('📖 Buff Giver Roster – How It Works')
      .setDescription(
        `Each hourly slot can have **up to 2 Buff Givers**.\n` +
        `The **King** is notified when assignees change.\n` +
        `Buff Givers get a **DM reminder** before their shift.\n\n` +
        `Use the buttons below to add, remove, or edit your roster hours.`
      );

    const panelComponents = rosterPanelComponents(dates);
    await rosterPanelChannel.send({ embeds: [instructions] });
    const panelMsg = await rosterPanelChannel.send({ components: panelComponents });

    // 6) Post the King Assignment panel in #king-assignment
    try {
      await kingAssignmentChannel.send({ embeds: [kingAssignmentEmbed()] });
      await kingAssignmentChannel.send({ components: kingAssignmentComponents() });
    } catch (e) {
      console.error('setup: king assignment panel error', e);
    }

    // 7) Post the Buff Givers Manager panel in #buff-givers-manager
    try {
      await buffManagerChannel.send({ embeds: [buffManagerEmbed()] });
      await buffManagerChannel.send({ components: buffManagerComponents() });
    } catch (e) {
      console.error('setup: buff manager panel error', e);
    }

    // 8) Save roster panel ids (we store the roster-panel message ids)
    await q(
      `INSERT INTO guild_settings (guild_id, category_id, panel_channel_id, panel_message_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (guild_id)
       DO UPDATE SET category_id=EXCLUDED.category_id,
                     panel_channel_id=EXCLUDED.panel_channel_id,
                     panel_message_id=EXCLUDED.panel_message_id`,
      [guild.id, category.id, rosterPanelChannel.id, panelMsg.id]
    );

    await interaction.editReply('✅ Setup complete! Created **#user-guide**, **#roster-panel**, **#king-assignment**, **#buff-givers-manager**, and daily roster channels.');
  }
};