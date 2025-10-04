// src/interactions/buttons.js
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { q } from '../db/pool.js';
import { hoursArray } from '../util/time.js';
import { upsertDayMessage } from '../util/dayMessage.js';

function hourMultiSelect(customId, placeholder, preSelected = []) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(24)
      .addOptions(
        hoursArray().map(h => ({
          label: `${String(h).padStart(2, '0')}:00`,
          value: String(h),
          default: preSelected.includes(h),
        }))
      )
  );
}

export async function onButton(interaction) {
  // --- King presses the DM button to notify assignees (ONE-TIME) ---
  if (interaction.customId.startsWith('notify_assignees:')) {
    const [, guildId, dateStr, hourStr] = interaction.customId.split(':');
    const hour = Number.parseInt(hourStr, 10);

    // Disable only the notify button in the existing message
    async function disableNotifyButton() {
      try {
        const msg = interaction.message ?? (await interaction.fetchReply().catch(() => null));
        if (!msg?.components?.length) return;

        const newRows = msg.components.map((row) => {
          const r = new ActionRowBuilder();
          row.components.forEach((comp) => {
            if (comp.type === 2) {
              const btn = ButtonBuilder.from(comp);
              if (comp.customId?.startsWith('notify_assignees:')) btn.setDisabled(true);
              r.addComponents(btn);
            }
          });
          return r;
        });

        await msg.edit({ components: newRows }).catch(() => {});
      } catch { /* ignore */ }
    }

    try {
      // 0) Idempotency guard
      const used = await q(
        `SELECT 1 FROM reminders_sent
         WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int AND kind='king_notify'
         LIMIT 1`,
        [guildId, dateStr, hour]
      );
      if (used.rowCount) {
        await disableNotifyButton();
        await interaction.reply({
          content: `⚠️ That button was already used for **${dateStr} ${String(hour).padStart(2,'0')}:00 UTC**.`,
          ephemeral: true
        });
        return;
      }

      // 1) Find assignees for the slot
      const { rows: currRows } = await q(
        `SELECT user_id FROM shifts
         WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int`,
        [guildId, dateStr, hour]
      );

      if (!currRows.length) {
        // Mark as used to avoid spam
        await q(
          `INSERT INTO reminders_sent(guild_id,date_utc,hour,user_id,kind)
           VALUES ($1,$2,$3,'__king_notify__','king_notify')
           ON CONFLICT DO NOTHING`,
          [guildId, dateStr, hour]
        );
        await disableNotifyButton();
        await interaction.reply({
          content: `No assignees found for **${dateStr} ${String(hour).padStart(2,'0')}:00 UTC**.`,
          ephemeral: true
        });
        return;
      }

      // 2) DM assignees
      for (const r of currRows) {
        try {
          const user = await interaction.client.users.fetch(r.user_id);
          await user.send(
            `👑 The King has assigned you for **${dateStr} ${String(hour).padStart(2, '0')}:00 UTC**. Please take position.`
          );
        } catch { /* ignore DM failure */ }
      }

      // 3) Record usage
      await q(
        `INSERT INTO reminders_sent(guild_id,date_utc,hour,user_id,kind)
         VALUES ($1,$2,$3,'__king_notify__','king_notify')
         ON CONFLICT DO NOTHING`,
        [guildId, dateStr, hour]
      );

      // 4) Lock button
      await disableNotifyButton();

      await interaction.reply({
        content: `✅ Notified assignees for **${dateStr} ${String(hour).padStart(2,'0')}:00 UTC**. (Button locked)`,
        ephemeral: true
      });
    } catch (e) {
      await interaction.reply({
        content: `⚠️ Could not notify assignees. (${e.message || 'unknown error'})`,
        ephemeral: true
      });
    }
    return;
  }

  // --- King presses the button to copy assignee names (single line) ---
  if (interaction.customId.startsWith('list_assignees:')) {
    const [, guildId, dateStr, hourStr] = interaction.customId.split(':');
    const hour = Number.parseInt(hourStr, 10);

    try {
      const { rows } = await q(
        `SELECT user_id FROM shifts
         WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int`,
        [guildId, dateStr, hour]
      );

      if (!rows.length) {
        await interaction.reply({
          content: `No assignees found for **${dateStr} ${String(hour).padStart(2,'0')}:00 UTC**.`,
          ephemeral: true
        });
        return;
      }

      const guild = await interaction.client.guilds.fetch(guildId);
      const names = [];
      for (const r of rows) {
        try {
          const m = await guild.members.fetch(r.user_id);
          names.push(m.displayName || m.user.username);
        } catch {
          names.push(`<@${r.user_id}>`);
        }
      }

      await interaction.reply({ content: names.join(', '), ephemeral: true });
    } catch (e) {
      await interaction.reply({
        content: `⚠️ Could not fetch assignee names. (${e.message || 'unknown error'})`,
        ephemeral: true
      });
    }
    return;
  }

  // --- Ephemeral add/remove/edit flows (date baked into custom id) ---
  if (
    interaction.customId.startsWith('add_hours_ep:') ||
    interaction.customId.startsWith('remove_hours_ep:') ||
    interaction.customId.startsWith('edit_hours_ep:')
  ) {
    const [action, date] = interaction.customId.split(':');

    const { rows } = await q(
      `SELECT hour FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND user_id=$3 ORDER BY hour`,
      [interaction.guildId, date, interaction.user.id]
    );
    const my = rows.map(r => r.hour);

    if (action === 'edit_hours_ep') {
      await interaction.reply({
        ephemeral: true,
        content: `Edit your hours for **${date} UTC**`,
        components: [hourMultiSelect(`edit_hours_submit:${date}`, 'Select all hours you will cover', my)]
      });
      return;
    }

    const cid = action === 'add_hours_ep' ? `add_hours_submit:${date}` : `remove_hours_submit:${date}`;
    const ph  = action === 'add_hours_ep' ? 'Select hours to add' : 'Select hours to remove';

    await interaction.reply({
      ephemeral: true,
      content: `Choose hours for **${date} UTC**`,
      components: [hourMultiSelect(cid, ph)]
    });
    return;
  }

  // --- Legacy public buttons: ask to pick a date first ---
  if (
    interaction.customId === 'add_hours' ||
    interaction.customId === 'remove_hours' ||
    interaction.customId === 'edit_hours'
  ) {
    await interaction.reply({
      ephemeral: true,
      content: 'Pick a date from the dropdown above first. (After you select a date, I’ll open a private picker.)'
    });
    return;
  }
}

export async function onSelectMenu(interaction) {
  // --- KING ASSIGNMENT: grant/clear King role (NO revoke button) ---
  if (interaction.customId === 'king_grant') {
    const guildId = interaction.guildId;

    // Load settings
    const { rows: gset } = await q(
      `SELECT r5_role_id, king_role_id FROM guild_settings WHERE guild_id=$1`,
      [guildId]
    );
    const r5RoleId   = gset[0]?.r5_role_id;
    const kingRoleId = gset[0]?.king_role_id;

    if (!kingRoleId) {
      await interaction.reply({
        content: '⚠️ No King role configured. Set it with `/config kingrole` first.',
        ephemeral: true
      });
      return;
    }

    // Allow: R5 OR Owner OR Admin (no need for Manage Roles personally)
    const member  = await interaction.guild.members.fetch(interaction.user.id);
    const isR5    = r5RoleId ? member.roles.cache.has(r5RoleId) : false;
    const isOwner = interaction.guild.ownerId === member.id;
    const isAdmin = member.permissions.has('Administrator');

    if (!(isR5 || isOwner || isAdmin)) {
      await interaction.reply({
        content: '❌ You are not allowed to manage the King role. (Requires R5, Owner, or Admin.)',
        ephemeral: true
      });
      return;
    }

    // Bot capability
    const me = await interaction.guild.members.fetchMe();
    const kingRole = await interaction.guild.roles.fetch(kingRoleId).catch(() => null);
    if (!kingRole) {
      await interaction.reply({
        content: '⚠️ King role not found. Re-set it with `/config kingrole`.',
        ephemeral: true
      });
      return;
    }
    const canManage =
      me.permissions.has('ManageRoles') &&
      me.roles.highest.comparePositionTo(kingRole) > 0 &&
      !kingRole.managed;

    if (!canManage) {
      await interaction.reply({
        content: '❌ I cannot edit the King role. Ensure I have **Manage Roles**, my top role is **above** the King role, and the role is not **managed**.',
        ephemeral: true
      });
      return;
    }

    // Selected users (0 = clear all Kings)
    const selectedIds = interaction.values;
    const results = [];

    // Remove King from all not-selected current holders
    const toRemove = [];
    for (const [, m] of kingRole.members) {
      if (!selectedIds.includes(m.id)) toRemove.push(m);
    }
    for (const m of toRemove) {
      try {
        await m.roles.remove(kingRole).catch(() => {});
        results.push(`🗑️ Removed King from ${m.displayName || m.user.username}`);
      } catch {
        results.push(`⚠️ Failed removing King from <@${m.id}>`);
      }
    }

    // Grant King to selected (if any)
    for (const uid of selectedIds) {
      try {
        const m = await interaction.guild.members.fetch(uid);
        if (!m.roles.cache.has(kingRole.id)) {
          await m.roles.add(kingRole).catch(() => {});
          results.push(`✅ Granted King to ${m.displayName || m.user.username}`);
        } else {
          results.push(`ℹ️ ${m.displayName || m.user.username} already has King`);
        }
      } catch {
        results.push(`⚠️ Failed granting King to <@${uid}>`);
      }
    }

    await interaction.reply({ content: results.join('\n'), ephemeral: true });
    return;
  }

  // --- BUFF GIVERS MANAGER: assign/remove Buff role ---
  if (interaction.customId === 'buff_grant' || interaction.customId === 'buff_revoke') {
    const guildId = interaction.guildId;

    const { rows: gset } = await q(
      `SELECT king_role_id, r5_role_id, buff_role_id FROM guild_settings WHERE guild_id=$1`,
      [guildId]
    );
    const kingRoleId = gset[0]?.king_role_id;
    const r5RoleId   = gset[0]?.r5_role_id;
    const buffRoleId = gset[0]?.buff_role_id;

    if (!buffRoleId) {
      await interaction.reply({
        content: '⚠️ No Buff Giver role configured. Set it with `/config buffrole` first.',
        ephemeral: true
      });
      return;
    }

    // Allow: King OR R5 OR Owner OR Admin (no need for Manage Roles personally)
    const member  = await interaction.guild.members.fetch(interaction.user.id);
    const isKing  = kingRoleId ? member.roles.cache.has(kingRoleId) : false;
    const isR5    = r5RoleId ? member.roles.cache.has(r5RoleId) : false;
    const isOwner = interaction.guild.ownerId === member.id;
    const isAdmin = member.permissions.has('Administrator');

    if (!(isKing || isR5 || isOwner || isAdmin)) {
      await interaction.reply({
        content: '❌ You are not allowed to manage Buff Giver roles here. (Requires King, R5, Owner, or Admin.)',
        ephemeral: true
      });
      return;
    }

    // Bot capability
    const me = await interaction.guild.members.fetchMe();
    const role = await interaction.guild.roles.fetch(buffRoleId).catch(() => null);
    if (!role) {
      await interaction.reply({
        content: '⚠️ Buff Giver role not found. Re-set it with `/config buffrole`.',
        ephemeral: true
      });
      return;
    }
    const canManage =
      me.permissions.has('ManageRoles') &&
      me.roles.highest.comparePositionTo(role) > 0 &&
      !role.managed;

    if (!canManage) {
      await interaction.reply({
        content: '❌ I cannot edit the Buff Giver role. Ensure I have **Manage Roles**, my top role is **above** the Buff role, and the role is not **managed**.',
        ephemeral: true
      });
      return;
    }

    // Apply assignment/removal
    const selectedIds = interaction.values;
    const grant = (interaction.customId === 'buff_grant');
    const results = [];

    for (const uid of selectedIds) {
      try {
        const m = await interaction.guild.members.fetch(uid);
        if (grant) {
          if (!m.roles.cache.has(role.id)) {
            await m.roles.add(role).catch(() => {});
            results.push(`✅ Assigned Buff Giver to ${m.displayName || m.user.username}`);
          } else {
            results.push(`ℹ️ ${m.displayName || m.user.username} already has Buff Giver`);
          }
        } else {
          if (m.roles.cache.has(role.id)) {
            await m.roles.remove(role).catch(() => {});
            results.push(`✅ Removed Buff Giver from ${m.displayName || m.user.username}`);
          } else {
            results.push(`ℹ️ ${m.displayName || m.user.username} did not have Buff Giver`);
          }
        }
      } catch {
        results.push(`⚠️ Failed for <@${uid}>`);
      }
    }

    await interaction.reply({ content: results.join('\n'), ephemeral: true });
    return;
  }

  // --- Public date dropdown -> mini private panel for that date ---
  if (interaction.customId === 'date_select') {
    const date = interaction.values[0];

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`add_hours_ep:${date}`)
        .setLabel('Add Hours')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`remove_hours_ep:${date}`)
        .setLabel('Remove Hours')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`edit_hours_ep:${date}`)
        .setLabel('Edit My Hours')
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      ephemeral: true,
      content: `📅 Date selected: **${date} (UTC)**. What would you like to do?`,
      components: [row]
    });
    return;
  }

  // --- Multi-select submit handlers ---
  const [action, date] = interaction.customId.split(':');
  if (!['add_hours_submit', 'remove_hours_submit', 'edit_hours_submit'].includes(action)) return;

  const hours = interaction.values.map(v => parseInt(v, 10));
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  // Remove existing entries when removing or editing
  if (action === 'remove_hours_submit' || action === 'edit_hours_submit') {
    await q(
      `DELETE FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND user_id=$3`,
      [guildId, date, userId]
    );
  }

  // Add new hours for add/edit (respect max 2 per slot)
  if (action !== 'remove_hours_submit') {
    for (const h of hours) {
      const { rows } = await q(
        `SELECT COUNT(*)::int AS c
           FROM shifts
          WHERE guild_id=$1 AND date_utc=$2 AND hour=$3`,
        [guildId, date, h]
      );
      if (rows[0].c < 2) {
        await q(
          `INSERT INTO shifts(guild_id,date_utc,hour,user_id,created_by)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [guildId, date, h, userId, userId]
        );
      }
    }
  }

  // Live-refresh the day channel embed if it exists
  try {
    const { rows: gset } = await q(
      `SELECT category_id FROM guild_settings WHERE guild_id=$1`,
      [guildId]
    );
    const categoryId = gset[0]?.category_id;
    if (categoryId) {
      const category = await interaction.client.channels.fetch(categoryId).catch(() => null);
      const ch = category?.children?.cache?.find(c => c.name === date);
      if (ch) {
        const { rows } = await q(
          `SELECT hour, user_id
             FROM shifts
            WHERE guild_id=$1 AND date_utc=$2
            ORDER BY hour`,
          [guildId, date]
        );
        const by = new Map();
        rows.forEach(r => {
          if (!by.has(r.hour)) by.set(r.hour, []);
          by.get(r.hour).push(r.user_id);
        });
        const slots = Array.from({ length: 24 }, (_, h) => ({
          hour: h,
          users: (by.get(h) || []).map(uid => ({ id: uid })),
          remaining: Math.max(0, 2 - ((by.get(h)?.length) || 0)),
        }));
        await upsertDayMessage(interaction.client, guildId, ch, date, slots);
      }
    }
  } catch { /* ignore */ }

  await interaction.update({
    content: '✅ Saved! Your roster has been updated.',
    components: [],
  });
}