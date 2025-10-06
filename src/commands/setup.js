// src/commands/setup.js
import {
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags
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

// Purge all messages from a channel (best-effort)
// Uses bulkDelete in batches; silently ignores older messages where needed.
async function purgeChannelMessages(channel) {
  try {
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      if (!fetched || fetched.size === 0) break;

      // Try bulk delete (filterOld = true ignores >14d)
      const bulkable = fetched;
      if (bulkable.size > 0) {
        await channel.bulkDelete(bulkable, true).catch(() => {});
      }

      // Try to delete anything that may be left individually (older than 14d)
      const stillThere = await channel.messages.fetch({ limit: 10 }).catch(() => null);
      if (stillThere && stillThere.size) {
        for (const [, m] of stillThere) {
          await m.delete().catch(() => {});
        }
      }
    } while (fetched && fetched.size >= 2);
  } catch {
    // ignore purge errors
  }
}

export default {
  data: {
    name: 'setup',
    description: 'Create category, user guide, panels, and 7 day roster channels'
  },

  execute: async (interaction) => {
    // Use MessageFlags.Ephemeral instead of deprecated `ephemeral: true`
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guild = interaction.guild;
    const botId = interaction.client.user.id;

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

    // 2) Helper to create read-only text channels under the category
    async function ensureText(name) {
      let ch = category.children?.cache?.find(c => c.type === ChannelType.GuildText && c.name === name);
      if (!ch) {
        ch = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: [
            // Everyone can read, but cannot post/react
            {
              id: guild.roles.everyone.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
              deny: [
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.CreatePublicThreads,
                PermissionFlagsBits.CreatePrivateThreads,
                PermissionFlagsBits.SendMessagesInThreads
              ]
            },
            // Bot can post/manage
            {
              id: botId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.ManageMessages
              ]
            }
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

    // 3) Purge existing messages in control channels (fresh repost each /setup)
    await purgeChannelMessages(userGuideChannel);
    await purgeChannelMessages(rosterPanelChannel);
    await purgeChannelMessages(kingAssignmentChannel);
    await purgeChannelMessages(buffManagerChannel);

    // 4) Post the User Guide embed in #user-guide
    const guideEmbed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('💫 Buff Giver Roster – User Guide')
      .setDescription(
`Welcome to the **Buff Giver Roster System!**
This bot helps organise a rostered system for who’s on duty for **Tribune** and **Chief Elder** (aka **Buff Givers**), who’s **King**, and when reminders go out.

## 🧙‍♂️ Buff Givers – How to Sign Up
Go to **#〡✍🏻〡shift-sign-up-panel**.

**Step 1:** Use the dropdown to pick a date (up to 7 days ahead).  
**Step 2:** Choose an action:
- ✅ **Add Hours** – sign up for shifts  
- ❌ **Remove Hours** – leave a shift  
- ✏️ **Edit My Hours** – adjust your existing hours  

You must select **at least 2 consecutive hours**.  
The bot confirms your selection privately.

## 💬 Reminders & Roles
- You’ll get a **DM reminder** before your shift begins.  
- The bot automatically **adds the Buff Giver role** when the King confirms a slot (or when managers set the current hour).  
- It **removes the role** at the end of your shift.

Make sure your **DMs are open**.

## 👑 King – Managing the Roster
Only **R5** or **Admins** can assign or change the King role (see **#〡👑〡king-assignment**).
When Buff Givers change, the King receives a DM and can:
- Press **Notify Assignees** to DM Buff Givers and auto-assign/remove the Discord role (once per slot)  
- Press **List Assignees** to copy who’s on duty

You can also manually edit the roster and roles in **#〡👨🏻‍💻〡buff-givers-management-panel**.

## ⛔ King Unavailable (Blackout)
If the King won’t be available to change positions:
- Open **#〡👨🏻‍💻〡buff-givers-management-panel**.  
- Use the **King Unavailable** picker to choose a **date** and **one or more hours**.  
- Set those hours **Unavailable** (lock).  
While locked:
- Buff Giver sign-ups for those hours are **blocked**.  
- Other systems/bots should avoid pinging the King for swaps in those hours.  
You can **Clear Unavailable** later to re-open sign-ups.

## 🎖️ R5 – Role & Permissions
**R5s** can:
- Assign or remove the King in **#〡👑〡king-assignment**  
They do **not** need Manage Roles.

## 🔔 Reminders
- Buff Givers get DM reminders.  
- The King is notified when rosters change.  
- “Notify Assignees” is **one-time per slot**.

## 💡 Tips
- All times are **UTC**.  
- Always pick at least **2 consecutive hours**.  
- Keep DMs open for reminders.  

🫡 **Roster your hours, check your DMs, and be ready to give buffs!**`
      );

    try {
      await userGuideChannel.send({ embeds: [guideEmbed] });
    } catch (e) {
      console.error('setup: user guide embed error', e);
    }

    // 5) Ensure 7 date channels under the category (named YYYY-MM-DD).
    //    Delete old date channels outside the 7-day window.
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

    // 6) Post roster panel in #shift-sign-up-panel (fresh each time)
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
    const panelMsg = await rosterPanelChannel.send({ components: [ ...panelComponents ] });

    // 7) Post the King Assignment panel in #king-assignment
    try {
      await kingAssignmentChannel.send({ embeds: [kingAssignmentEmbed()] });
      await kingAssignmentChannel.send({ components: kingAssignmentComponents() });
    } catch (e) {
      console.error('setup: king assignment panel error', e);
    }

    // 8) Post the Buff Givers Manager panel in #buff-givers-management-panel
    //    (Includes King Unavailable/blackout controls via buffManagerComponents)
    try {
      await buffManagerChannel.send({ embeds: [buffManagerEmbed()] });
      await buffManagerChannel.send({ components: buffManagerComponents() });
    } catch (e) {
      console.error('setup: buff manager panel error', e);
    }

    // 9) For each of the next 7 days, ensure text channel and upsert the day message
for (const date of dates) {
  let ch = category.children?.cache?.find(c => c.name === date);
  if (!ch) {
    ch = await guild.channels.create({
      name: date,
      type: ChannelType.GuildText,
      parent: category.id,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
          deny: [
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AddReactions,
            PermissionFlagsBits.CreatePublicThreads,
            PermissionFlagsBits.CreatePrivateThreads,
            PermissionFlagsBits.SendMessagesInThreads
          ]
        },
        {
          id: botId,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ManageMessages
          ]
        }
      ]
    });
  }

  try {
    // pull current assignees
    const { rows } = await q(
      `SELECT hour, user_id
         FROM shifts
        WHERE guild_id=$1 AND date_utc=$2
        ORDER BY hour`,
      [guild.id, date]
    );

    // pull king-unavailable hours (rename to your actual table if different)
    const { rows: unavailRows } = await q(
      `SELECT hour
         FROM king_unavailable
        WHERE guild_id=$1 AND date_utc=$2`,
      [guild.id, date]
    ).catch(() => ({ rows: [] }));

    const lockedHours = new Set(unavailRows.map(r => r.hour));

    const by = new Map();
    rows.forEach((r) => {
      if (!by.has(r.hour)) by.set(r.hour, []);
      by.get(r.hour).push(r.user_id);
    });

    const slots = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      users: (by.get(h) || []).map((uid) => ({ id: uid })),
      remaining: Math.max(0, 2 - (by.get(h)?.length || 0)),
      locked: lockedHours.has(h)
    }));

    await upsertDayMessage(interaction.client, guild.id, ch, date, slots);
  } catch (e) {
    console.error('setup: upsertDayMessage error', e);
    const slotsFallback = hoursArray().map(h => ({ hour: h, users: [], remaining: 2, locked: false }));
    try {
      await upsertDayMessage(interaction.client, guild.id, ch, date, slotsFallback);
    } catch {}
  }
}

    // 10) Save roster panel ids (we store the roster-panel message ids)
    await q(
      `INSERT INTO guild_settings (guild_id, category_id, panel_channel_id, panel_message_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (guild_id)
       DO UPDATE SET category_id=EXCLUDED.category_id,
                     panel_channel_id=EXCLUDED.panel_channel_id,
                     panel_message_id=EXCLUDED.panel_message_id`,
      [guild.id, category.id, rosterPanelChannel.id, panelMsg.id]
    );

    await interaction.editReply('✅ Setup complete! Created **#user-guide**, **#shift-sign-up-panel**, **#king-assignment**, **#buff-givers-management-panel**, and daily roster channels. Existing rostered users were preserved. The guide now includes **King Unavailable** instructions.');
  }
};