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

    // 1️⃣ Create or reuse the "Buff Givers Roster" category
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

    // 2️⃣ Helper to create channels under the category
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
    const userGuideChannel = await ensureText('user-guide');
    const rosterPanelChannel = await ensureText('roster-panel');
    const kingAssignmentChannel = await ensureText('king-assignment');

    // Put control channels at the top in correct order
    try {
      await userGuideChannel.setPosition(0).catch(() => {});
      await rosterPanelChannel.setPosition(1).catch(() => {});
      await kingAssignmentChannel.setPosition(2).catch(() => {});
      await userGuideChannel.edit({ position: 0 }).catch(() => {});
      await rosterPanelChannel.edit({ position: 1 }).catch(() => {});
      await kingAssignmentChannel.edit({ position: 2 }).catch(() => {});
    } catch (e) {
      console.warn('setup: could not pin control channels to top', e);
    }

    // 3️⃣ Post the User Guide embed in #user-guide
    const guideEmbed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('💫 Buff Giver Roster – User Guide')
      .setDescription(
`Welcome to the **Buff Giver Roster System!**
This bot helps organize who’s on duty for buffs each hour, who’s King, and when reminders go out.

---

## 🧙‍♂️ Buff Givers – How to Sign Up
Go to the **#roster-panel** channel.

**Step 1:** Use the dropdown menu to select a date (up to 7 days ahead).  
**Step 2:** Choose an action:
- ✅ **Add Hours** – sign up for shifts  
- ❌ **Remove Hours** – leave a shift  
- ✏️ **Edit My Hours** – adjust your existing hours  

You must select **at least 2 consecutive hours**.  
The bot will confirm your selection privately.

---

## 💬 Reminders & Roles
- You’ll get a **DM reminder** before your shift begins.  
- The bot automatically **adds the Buff Giver role** at shift start.  
- It **removes the role** when your shift ends.  

Make sure your **DMs are open** so you don’t miss reminders.

---

## 👑 King – Managing the Roster
Go to **#king-assignment**.

Only the **King**, **R5**, or **Admin** can assign or change the King role.  
When Buff Givers change, the King receives a DM.

In that DM, the King can:
- Press **Notify Assignees** to DM Buff Givers (once per slot)  
- Press **List Assignees** to copy who’s on duty

---

## 🎖️ R5 – Role & Permissions
Members with the **R5 role** can:
- Assign or remove the King in #king-assignment  
- Manage roster schedules

They do **not** need Manage Roles permission.

---

## ⚔️ Role Overview
**King:** Main buff coordinator  
**Buff Giver:** Automatically assigned at shift start  
**R5:** Trusted leaders who manage assignments

---

## 🔔 Reminders
- Buff Givers get DM reminders.  
- The King is notified when rosters change.  
- “Notify Assignees” can only be pressed **once per time slot**.

---

## 💡 Tips
- All times are **UTC**.  
- Always pick at least **2 consecutive hours**.  
- Keep DMs open for reminders.  
- If setup breaks, ask an R5 or Admin to run **/setup** again.

---

🫡 **Roster your hours, check your DMs, and be ready to give buffs!**
`
      );

    try {
      await userGuideChannel.send({ embeds: [guideEmbed] });
    } catch (e) {
      console.error('setup: user guide embed error', e);
    }

    // 4️⃣ Create 7 date channels under the category
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

    // 5️⃣ Post roster panel in #roster-panel
    const instructions = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('📖 Buff Giver Roster – How It Works')
      .setDescription(
        `Each hourly slot can have **up to 2 Buff Givers**.  
The King is notified when assignees change.  
Buff Givers get a DM reminder before their shift.\n\n` +
        `Use the buttons below to add, remove, or edit your roster hours.`
      );

    const panelComponents = rosterPanelComponents(dates);
    await rosterPanelChannel.send({ embeds: [instructions] });
    const panelMsg = await rosterPanelChannel.send({ components: panelComponents });

    // 6️⃣ Post King Assignment panel
    try {
      const kaEmbed = kingAssignmentEmbed();
      const kaComponents = kingAssignmentComponents();
      await kingAssignmentChannel.send({ embeds: [kaEmbed] });
      await kingAssignmentChannel.send({ components: kaComponents });
    } catch (e) {
      console.error('setup: king assignment panel error', e);
    }

    // 7️⃣ Save guild settings
    await q(
      `INSERT INTO guild_settings (guild_id, category_id, panel_channel_id, panel_message_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (guild_id)
       DO UPDATE SET category_id=EXCLUDED.category_id,
                     panel_channel_id=EXCLUDED.panel_channel_id,
                     panel_message_id=EXCLUDED.panel_message_id`,
      [guild.id, category.id, rosterPanelChannel.id, panelMsg.id]
    );

    await interaction.editReply('✅ Setup complete! Created **#user-guide**, **#roster-panel**, **#king-assignment**, and daily roster channels.');
  }
};