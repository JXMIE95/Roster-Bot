// src/interactions/buttons.js
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits
} from 'discord.js';
import { q } from '../db/pool.js';
import { hoursArray, nowUtc } from '../util/time.js';
import { upsertDayMessage } from '../util/dayMessage.js';

/* ========================== helpers ========================== */

function hourMultiSelect(customId, placeholder, preSelected = []) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder(placeholder)
      .setMinValues(1)
      .setMaxValues(24)
      .addOptions(
        hoursArray().map((h) => ({
          label: `${String(h).padStart(2, '0')}:00`,
          value: String(h),
          default: preSelected.includes(h),
        }))
      )
  );
}

function next7DatesUtc() {
  const base = nowUtc().startOf('day');
  return Array.from({ length: 7 }, (_, i) => base.clone().add(i, 'day').format('YYYY-MM-DD'));
}

async function requireManagerPermission(interaction) {
  const guildId = interaction.guildId;
  const member = await interaction.guild.members.fetch(interaction.user.id);

  const { rows } = await q(
    `SELECT r5_role_id, king_role_id FROM guild_settings WHERE guild_id=$1`,
    [guildId]
  );
  const r5RoleId = rows[0]?.r5_role_id;
  const kingRoleId = rows[0]?.king_role_id;

  const isR5 = r5RoleId ? member.roles.cache.has(r5RoleId) : false;
  const isKing = kingRoleId ? member.roles.cache.has(kingRoleId) : false;
  const isOwner = interaction.guild.ownerId === member.id;
  const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);

  return (isR5 || isKing || isOwner || isAdmin);
}

async function refreshDayEmbed(client, guildId, date) {
  const { rows: gset } = await q(
    `SELECT category_id FROM guild_settings WHERE guild_id=$1`,
    [guildId]
  );
  const categoryId = gset[0]?.category_id;
  if (!categoryId) return;

  const category = await client.channels.fetch(categoryId).catch(() => null);
  const ch = category?.children?.cache?.find((c) => c.name === date);
  if (!ch) return;

  // current assignees
  const { rows } = await q(
    `SELECT hour, user_id
       FROM shifts
      WHERE guild_id=$1 AND date_utc=$2
      ORDER BY hour`,
    [guildId, date]
  );

  // king-unavailable hours
  const { rows: unavailRows } = await q(
    `SELECT hour
       FROM king_unavailable
      WHERE guild_id=$1 AND date_utc=$2`,
    [guildId, date]
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

  await upsertDayMessage(client, guildId, ch, date, slots);
}

/**
 * Immediately sync the live Buff role if the manager updated the CURRENT UTC hour.
 * IMPORTANT: Do NOT remove Buff role from members who have the King role.
 */
async function syncBuffRoleIfNow(interaction, date, hour, beforeIds) {
  const now = nowUtc();
  const todayStr = now.clone().format('YYYY-MM-DD');
  const curHour = now.hour();
  if (date !== todayStr || hour !== curHour) return;

  const { rows: gset } = await q(
    `SELECT buff_role_id, king_role_id FROM guild_settings WHERE guild_id=$1`,
    [interaction.guildId]
  );
  const buffRoleId = gset[0]?.buff_role_id;
  const kingRoleId = gset[0]?.king_role_id;
  if (!buffRoleId) return;

  const guild = interaction.guild;
  const me = await guild.members.fetchMe();
  const buffRole = await guild.roles.fetch(buffRoleId).catch(() => null);
  const kingRole = kingRoleId ? await guild.roles.fetch(kingRoleId).catch(() => null) : null;
  if (!buffRole) return;

  const canManage =
    me.permissions.has(PermissionFlagsBits.ManageRoles) &&
    me.roles.highest.comparePositionTo(buffRole) > 0 &&
    !buffRole.managed;
  if (!canManage) return;

  const { rows: afterRows } = await q(
    `SELECT user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int`,
    [interaction.guildId, date, hour]
  );
  const afterIds = new Set(afterRows.map(r => r.user_id));
  const beforeSet = new Set(beforeIds || []);

  // Add Buff role to current assignees
  for (const uid of afterIds) {
    try {
      const m = await guild.members.fetch(uid);
      if (!m.roles.cache.has(buffRole.id)) await m.roles.add(buffRole).catch(() => {});
    } catch {}
  }

  // Remove Buff role from members who are no longer on duty — but skip Kings
  for (const uid of beforeSet) {
    if (!afterIds.has(uid)) {
      try {
        const m = await guild.members.fetch(uid);
        const isKing = kingRole ? m.roles.cache.has(kingRole.id) : false;
        if (!isKing && m.roles.cache.has(buffRole.id)) {
          await m.roles.remove(buffRole).catch(() => {});
        }
      } catch {}
    }
  }
}

/* ---------- King Unavailable (Blackout) helpers ---------- */

async function isKingUnavailable(guildId, date, hour) {
  const { rows } = await q(
    `SELECT 1 FROM king_unavailable WHERE guild_id=$1 AND date_utc=$2 AND hour=$3 LIMIT 1`,
    [guildId, date, hour]
  );
  return rows.length > 0;
}

async function setKingUnavailable(guildId, date, hours) {
  for (const h of hours) {
    await q(
      `INSERT INTO king_unavailable(guild_id,date_utc,hour)
       VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [guildId, date, h]
    );
  }
}

async function clearKingUnavailable(guildId, date, hours) {
  await q(
    `DELETE FROM king_unavailable WHERE guild_id=$1 AND date_utc=$2 AND hour = ANY($3::int[])`,
    [guildId, date, hours]
  );
}

/* ---------- Role helpers for King<->Buff coupling ---------- */

async function getConfiguredRoles(guildId, guild) {
  const { rows } = await q(
    `SELECT king_role_id, buff_role_id FROM guild_settings WHERE guild_id=$1`,
    [guildId]
  );
  const kingRoleId = rows[0]?.king_role_id || null;
  const buffRoleId = rows[0]?.buff_role_id || null;
  const kingRole = kingRoleId ? await guild.roles.fetch(kingRoleId).catch(() => null) : null;
  const buffRole = buffRoleId ? await guild.roles.fetch(buffRoleId).catch(() => null) : null;
  return { kingRole, buffRole };
}

function canBotManageRole(me, role) {
  return (
    !!role &&
    me.permissions.has(PermissionFlagsBits.ManageRoles) &&
    me.roles.highest.comparePositionTo(role) > 0 &&
    !role.managed
  );
}

/* =================== onButton (BUTTON interactions) =================== */

export async function onButton(interaction) {
  // Notify assignees (one-time)
  if (interaction.customId.startsWith('notify_assignees:')) {
    const [, guildId, dateStr, hourStr] = interaction.customId.split(':');
    const hour = Number.parseInt(hourStr, 10);

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
      } catch {}
    }

    try {
      const used = await q(
        `SELECT 1 FROM reminders_sent
         WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int AND kind='king_notify'
         LIMIT 1`,
        [guildId, dateStr, hour]
      );
      if (used.rowCount) {
        await disableNotifyButton();
        await interaction.reply({
          content: `⚠️ This slot **${dateStr} ${String(hour).padStart(2, '0')}:00 UTC** has already been notified.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const { rows: currRows } = await q(
        `SELECT user_id FROM shifts
         WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int`,
        [guildId, dateStr, hour]
      );

      if (!currRows.length) {
        await q(
          `INSERT INTO reminders_sent(guild_id,date_utc,hour,user_id,kind)
           VALUES ($1,$2,$3,'__king_notify__','king_notify')
           ON CONFLICT DO NOTHING`,
          [guildId, dateStr, hour]
        );
        await disableNotifyButton();
        await interaction.reply({
          content: `No assignees found for **${dateStr} ${String(hour).padStart(2, '0')}:00 UTC**.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      for (const r of currRows) {
        try {
          const user = await interaction.client.users.fetch(r.user_id);
          await user.send(
            `👑 The King has assigned you for **${dateStr} ${String(hour).padStart(2, '0')}:00 UTC**. Please take position.`
          );
        } catch {}
      }

      await q(
        `INSERT INTO reminders_sent(guild_id,date_utc,hour,user_id,kind)
         VALUES ($1,$2,$3,'__king_notify__','king_notify')
         ON CONFLICT DO NOTHING`,
        [guildId, dateStr, hour]
      );
      await disableNotifyButton();

      await interaction.reply({
        content: `✅ Notified assignees for **${dateStr} ${String(hour).padStart(2, '0')}:00 UTC**. (Button locked)`,
        flags: MessageFlags.Ephemeral
      });
    } catch (e) {
      await interaction.reply({
        content: `⚠️ Could not notify assignees. (${e.message || 'unknown error'})`,
        flags: MessageFlags.Ephemeral
      });
    }
    return;
  }

  // Copy assignee names (one-line)
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
          content: `No assignees found for **${dateStr} ${String(hour).padStart(2, '0')}:00 UTC**.`,
          flags: MessageFlags.Ephemeral
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

      await interaction.reply({ content: names.join(', '), flags: MessageFlags.Ephemeral });
    } catch (e) {
      await interaction.reply({
        content: `⚠️ Could not fetch assignee names. (${e.message || 'unknown error'})`,
        flags: MessageFlags.Ephemeral
      });
    }
    return;
  }

  // Buff Manager: action buttons -> open user picker (single-hour)
  if (interaction.customId.startsWith('bm_act:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage this slot.', flags: MessageFlags.Ephemeral });
      return;
    }

    const [, action, date, hourStr] = interaction.customId.split(':');
    const hour = parseInt(hourStr, 10);

    const { rows } = await q(
      `SELECT user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int`,
      [interaction.guildId, date, hour]
    );
    const current = rows.map(r => r.user_id);
    const remaining = Math.max(0, 2 - current.length);

    const row = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`bm_pick:${action}:${date}:${hour}`)
        .setPlaceholder(
          action === 'add'    ? `Pick up to ${Math.max(1, remaining)} user(s) to ADD` :
          action === 'remove' ? 'Pick user(s) to REMOVE from this slot' :
                                'Pick up to 2 user(s) to REPLACE this slot'
        )
        .setMinValues(1)
        .setMaxValues(
          action === 'add'    ? Math.max(1, remaining) :
          action === 'remove' ? Math.max(1, current.length || 1) :
                                2
        )
    );

    await interaction.reply({
      content: `📌 **${date} ${String(hour).padStart(2,'0')}:00 UTC** — choose members to **${action.toUpperCase()}**:`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Buff Manager: action buttons -> open user picker (multi-hour)
  if (interaction.customId.startsWith('bm_act_multi:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage these slots.', flags: MessageFlags.Ephemeral });
      return;
    }

    const [, action, date, hoursCsv] = interaction.customId.split(':');
    const hours = hoursCsv.split(',').map(h => parseInt(h, 10)).filter(Number.isInteger);

    const row = new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId(`bm_pick_multi:${action}:${date}:${hoursCsv}`)
        .setPlaceholder(
          action === 'add'    ? 'Pick up to 2 user(s) to ADD to each selected hour' :
          action === 'remove' ? 'Pick user(s) to REMOVE from each selected hour' :
                                'Pick up to 2 user(s) to REPLACE each selected hour'
        )
        .setMinValues(1)
        .setMaxValues(action === 'remove' ? 10 : 2)
    );

    await interaction.reply({
      content: `📌 **${date}** — hours **${hours.map(h=>String(h).padStart(2,'0')).join(', ')}:00 UTC**. Choose an action:`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  /* ---------- King Unavailable BUTTON actions ---------- */

  if (interaction.customId.startsWith('kb_set_unavailable:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to modify King availability.', flags: MessageFlags.Ephemeral });
      return;
    }
    const [, date, hoursCsv] = interaction.customId.split(':');
    const hours = hoursCsv.split(',').map(h => parseInt(h, 10)).filter(Number.isInteger);

    await setKingUnavailable(interaction.guildId, date, hours);
    await refreshDayEmbed(interaction.client, interaction.guildId, date);
    await interaction.reply({
      content: `⛔ Marked **${date}** hours **${hours.map(h=>String(h).padStart(2,'0')).join(', ')}:00 UTC** as **King Unavailable**.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.customId.startsWith('kb_clear_unavailable:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to modify King availability.', flags: MessageFlags.Ephemeral });
      return;
    }
    const [, date, hoursCsv] = interaction.customId.split(':');
    const hours = hoursCsv.split(',').map(h => parseInt(h, 10)).filter(Number.isInteger);

    await clearKingUnavailable(interaction.guildId, date, hours);
    await refreshDayEmbed(interaction.client, interaction.guildId, date);
    await interaction.reply({
      content: `✅ Cleared **King Unavailable** for **${date}** hours **${hours.map(h=>String(h).padStart(2,'0')).join(', ')}:00 UTC**.`,
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // User self-service (BUTTONS that open selects)
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
    const my = rows.map((r) => r.hour);

    if (action === 'edit_hours_ep') {
      await interaction.reply({
        content: `Edit your hours for **${date} UTC**`,
        components: [
          hourMultiSelect(
            `edit_hours_submit:${date}`,
            'Select all hours you will cover',
            my
          ),
        ],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    const cid = action === 'add_hours_ep'
      ? `add_hours_submit:${date}`
      : `remove_hours_submit:${date}`;
    const ph = action === 'add_hours_ep'
      ? 'Select hours to add'
      : 'Select hours to remove';

    await interaction.reply({
      content: `Choose hours for **${date} UTC**`,
      components: [hourMultiSelect(cid, ph)],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Legacy prompts
  if (
    interaction.customId === 'add_hours' ||
    interaction.customId === 'remove_hours' ||
    interaction.customId === 'edit_hours'
  ) {
    await interaction.reply({
      content:
        'Pick a date from the dropdown above first. (After you select a date, I’ll open a private picker.)',
      flags: MessageFlags.Ephemeral
    });
    return;
  }
}

/* ========== onSelectMenu (ALL StringSelect & UserSelect interactions) ========== */

export async function onSelectMenu(interaction) {
  // Roster panel date -> private mini panel
  if (interaction.customId === 'date_select') {
    const date = interaction.values[0];

    const { rows: lockRows } = await q(
      `SELECT hour FROM king_unavailable WHERE guild_id=$1 AND date_utc=$2`,
      [interaction.guildId, date]
    ).catch(() => ({ rows: [] }));

    const lockedList = lockRows?.length
      ? `\n\n🔒 King-unavailable hours: **${lockRows
          .map(r => String(r.hour).padStart(2,'0'))
          .sort((a,b)=>a.localeCompare(b))
          .join(', ')}:00 UTC**`
      : '';

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
      content: `📅 Date selected: **${date} (UTC)**. What would you like to do?${lockedList}`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // User self-service submit (2+ consecutive + blackout checks)
  if (['add_hours_submit', 'remove_hours_submit', 'edit_hours_submit'].some(p => interaction.customId.startsWith(p))) {
    const [action, date] = interaction.customId.split(':');
    const hours = interaction.values.map(v => parseInt(v, 10)).sort((a, b) => a - b);
    const userId = interaction.user.id;
    const guildId = interaction.guildId;

    if ((action === 'add_hours_submit' || action === 'edit_hours_submit')) {
      if (hours.length < 2) {
        await interaction.reply({
          content: '⚠️ You must select **at least 2 hours**.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }
      let consecutive = true;
      for (let i = 1; i < hours.length; i++) {
        if (hours[i] - hours[i - 1] !== 1) {
          consecutive = false;
          break;
        }
      }
      if (!consecutive) {
        await interaction.reply({
          content: '⚠️ Please select **consecutive hours** (e.g., 13:00–15:00).',
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    // block signups if any hour is king-unavailable
    if (action !== 'remove_hours_submit') {
      const { rows: lockRows } = await q(
        `SELECT hour FROM king_unavailable WHERE guild_id=$1 AND date_utc=$2`,
        [guildId, date]
      ).catch(() => ({ rows: [] }));
      const locked = new Set((lockRows || []).map(r => r.hour));
      const blocked = hours.filter(h => locked.has(h));
      if (blocked.length) {
        await interaction.reply({
          content: `⛔ You cannot sign up for **${date} ${blocked.map(h=>String(h).padStart(2,'0')).join(', ')}:00 UTC** because the King is marked **Unavailable**.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }
    }

    if (action === 'remove_hours_submit' || action === 'edit_hours_submit') {
      await q(
        `DELETE FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND user_id=$3`,
        [guildId, date, userId]
      );
    }

    if (action !== 'remove_hours_submit') {
      for (const h of hours) {
        const { rows } = await q(
          `SELECT COUNT(*)::int AS c FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND hour=$3`,
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

    await refreshDayEmbed(interaction.client, guildId, date);

    await interaction.update({
      content: '✅ Saved! Your roster has been updated.',
      components: [],
    });
    return;
  }

  // Buff Manager: initial date -> multi-hour select
  if (interaction.customId === 'bm_date') {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', flags: MessageFlags.Ephemeral });
      return;
    }
    const date = interaction.values[0];

    const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`bm2_hours:${date}`)
        .setPlaceholder(`🕑 Select one or more hours for ${date} (UTC)`)
        .setMinValues(1)
        .setMaxValues(24)
        .addOptions(hours.map(h => ({ label: `${h}:00`, value: String(parseInt(h,10)) })))
    );
    await interaction.reply({
      content: `📅 Date selected: **${date}**. Now pick **one or more hours**:`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Buff Manager: hour -> date (single-hour path)
  if (interaction.customId === 'bm_hour') {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', flags: MessageFlags.Ephemeral });
      return;
    }
    const hour = parseInt(interaction.values[0], 10);
    const dates = next7DatesUtc();
    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`bm2_date:${hour}`)
        .setPlaceholder(`📅 Select date for ${String(hour).padStart(2,'0')}:00 (UTC)`)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(dates.map(d => ({ label: d, value: d })))
    );
    await interaction.reply({
      content: `🕑 Hour selected: **${String(hour).padStart(2,'0')}:00**. Now pick a **date**:`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Buff Manager: date -> single-hour action buttons
  if (interaction.customId.startsWith('bm2_hour:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', flags: MessageFlags.Ephemeral });
      return;
    }
    const date = interaction.customId.split(':')[1];
    const hour = parseInt(interaction.values[0], 10);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bm_act:add:${date}:${hour}`).setLabel('Add').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`bm_act:remove:${date}:${hour}`).setLabel('Remove').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`bm_act:replace:${date}:${hour}`).setLabel('Replace').setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      content: `📌 Managing **${date} ${String(hour).padStart(2,'0')}:00 UTC**. Choose an action:`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Buff Manager: hour -> date action buttons
  if (interaction.customId.startsWith('bm2_date:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', flags: MessageFlags.Ephemeral });
      return;
    }
    const hour = parseInt(interaction.customId.split(':')[1], 10);
    const date = interaction.values[0];

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bm_act:add:${date}:${hour}`).setLabel('Add').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`bm_act:remove:${date}:${hour}`).setLabel('Remove').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`bm_act:replace:${date}:${hour}`).setLabel('Replace').setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      content: `📌 Managing **${date} ${String(hour).padStart(2,'0')}:00 UTC**. Choose an action:`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // Buff Manager: date -> MULTI-HOURS action buttons
  if (interaction.customId.startsWith('bm2_hours:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', flags: MessageFlags.Ephemeral });
      return;
    }
    const date = interaction.customId.split(':')[1];
    const hours = interaction.values.map(v => parseInt(v, 10)).sort((a,b)=>a-b);
    const hoursCsv = hours.join(',');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`bm_act_multi:add:${date}:${hoursCsv}`).setLabel('Add').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`bm_act_multi:remove:${date}:${hoursCsv}`).setLabel('Remove').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`bm_act_multi:replace:${date}:${hoursCsv}`).setLabel('Replace').setStyle(ButtonStyle.Primary)
    );

    await interaction.reply({
      content: `📌 Managing **${date}** hours **${hours.map(h=>String(h).padStart(2,'0')).join(', ')}:00 UTC**. Choose an action:`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  /* ---------- King Unavailable SELECT flows ---------- */

  if (interaction.customId === 'kb_date') {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to mark King availability.', flags: MessageFlags.Ephemeral });
      return;
    }
    const date = interaction.values[0];
    const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`kb_hours:${date}`)
        .setPlaceholder(`🕑 Select one or more hours for ${date} (UTC)`)
        .setMinValues(1)
        .setMaxValues(24)
        .addOptions(hours.map(h => ({ label: `${h}:00`, value: String(parseInt(h,10)) })))
    );

    await interaction.reply({
      content: `📅 Select the hours to **mark unavailable** for **${date} (UTC)**:`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.customId.startsWith('kb_hours:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to modify King availability.', flags: MessageFlags.Ephemeral });
      return;
    }
    const date = interaction.customId.split(':')[1];
    const hours = interaction.values.map(v => parseInt(v, 10)).sort((a,b)=>a-b);
    const hoursCsv = hours.join(',');

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`kb_set_unavailable:${date}:${hoursCsv}`).setLabel('Mark Unavailable').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`kb_clear_unavailable:${date}:${hoursCsv}`).setLabel('Clear Unavailable').setStyle(ButtonStyle.Success)
    );

    await interaction.reply({
      content: `📌 **${date}** — hours **${hours.map(h=>String(h).padStart(2,'0')).join(', ')}:00 UTC**. Choose an action:`,
      components: [row],
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  /* ---------- Buff Manager results SELECTs ---------- */

  if (interaction.customId.startsWith('bm_pick:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', flags: MessageFlags.Ephemeral });
      return;
    }
    const [, action, date, hourStr] = interaction.customId.split(':');
    const hour = parseInt(hourStr, 10);
    const guildId = interaction.guildId;
    const userIds = interaction.values;

    try {
      const { rows } = await q(
        `SELECT user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int`,
        [guildId, date, hour]
      );
      const current = rows.map(r => r.user_id);

      if (action === 'replace') {
        await q(`DELETE FROM shifts WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int`,
          [guildId, date, hour]);
        let added = 0;
        for (const uid of userIds) {
          if (added >= 2) break;
          await q(
            `INSERT INTO shifts(guild_id,date_utc,hour,user_id,created_by)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [guildId, date, hour, uid, interaction.user.id]
          );
          added++;
        }
      } else if (action === 'add') {
        const remaining = Math.max(0, 2 - current.length);
        let added = 0;
        for (const uid of userIds) {
          if (added >= remaining) break;
          if (current.includes(uid)) continue;
          await q(
            `INSERT INTO shifts(guild_id,date_utc,hour,user_id,created_by)
             VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
            [guildId, date, hour, uid, interaction.user.id]
          );
          added++;
        }
      } else if (action === 'remove') {
        for (const uid of userIds) {
          await q(
            `DELETE FROM shifts WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int AND user_id=$4`,
            [guildId, date, hour, uid]
          );
        }
      }

      await refreshDayEmbed(interaction.client, guildId, date);
      await syncBuffRoleIfNow(interaction, date, hour, current);

      await interaction.reply({
        content: `✅ Updated **${date} ${String(hour).padStart(2,'0')}:00 UTC** (${action}).`,
        flags: MessageFlags.Ephemeral
      });
    } catch (e) {
      await interaction.reply({
        content: `⚠️ Failed to update slot: ${e.message || e}`,
        flags: MessageFlags.Ephemeral
      });
    }
    return;
  }

  if (interaction.customId.startsWith('bm_pick_multi:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', flags: MessageFlags.Ephemeral });
      return;
    }
    const [, action, date, hoursCsv] = interaction.customId.split(':');
    const hours = hoursCsv.split(',').map(h => parseInt(h, 10)).filter(Number.isInteger);
    const guildId = interaction.guildId;
    const userIds = interaction.values;

    try {
      for (const hour of hours) {
        const { rows } = await q(
          `SELECT user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int`,
          [guildId, date, hour]
        );
        const current = rows.map(r => r.user_id);

        if (action === 'replace') {
          await q(`DELETE FROM shifts WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int`,
            [guildId, date, hour]);
          let added = 0;
          for (const uid of userIds) {
            if (added >= 2) break;
            await q(
              `INSERT INTO shifts(guild_id,date_utc,hour,user_id,created_by)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
              [guildId, date, hour, uid, interaction.user.id]
            );
            added++;
          }
        } else if (action === 'add') {
          const remaining = Math.max(0, 2 - current.length);
          let added = 0;
          for (const uid of userIds) {
            if (added >= remaining) break;
            if (current.includes(uid)) continue;
            await q(
              `INSERT INTO shifts(guild_id,date_utc,hour,user_id,created_by)
               VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
              [guildId, date, hour, uid, interaction.user.id]
            );
            added++;
          }
        } else if (action === 'remove') {
          for (const uid of userIds) {
            await q(
              `DELETE FROM shifts WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int AND user_id=$4`,
              [guildId, date, hour, uid]
            );
          }
        }

        await syncBuffRoleIfNow(interaction, date, hour, current);
      }

      await refreshDayEmbed(interaction.client, guildId, date);

      await interaction.reply({
        content: `✅ Updated **${date}** hours **${hours.map(h=>String(h).padStart(2,'0')).join(', ')}:00 UTC** (${action}).`,
        flags: MessageFlags.Ephemeral
      });
    } catch (e) {
      await interaction.reply({
        content: `⚠️ Failed to update selected hours: ${e.message || e}`,
        flags: MessageFlags.Ephemeral
      });
    }
    return;
  }

  /* ---------- King Assignment (UserSelect) ---------- */
  if (interaction.customId === 'king_grant' || interaction.customId === 'king_revoke')) return; // handled in onSelectMenu
}

/* ========== EXTRA: handle King grant/revoke in onSelectMenu (UserSelect) ========== */

export async function onUserSelectKing(interaction) {
  // This helper handles the user-select menus with customId king_grant / king_revoke
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const guildId = interaction.guildId;
    const guild = interaction.guild;

    const { rows: gset } = await q(
      `SELECT r5_role_id, king_role_id FROM guild_settings WHERE guild_id=$1`,
      [guildId]
    );
    const r5RoleId   = gset[0]?.r5_role_id || null;
    const kingRoleId = gset[0]?.king_role_id || null;

    if (!kingRoleId) {
      await interaction.editReply('⚠️ No King role configured. Set it with `/config kingrole` first.');
      return;
    }

    const member = await guild.members.fetch(interaction.user.id);
    const isR5    = r5RoleId ? member.roles.cache.has(r5RoleId) : false;
    const isOwner = guild.ownerId === member.id;
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);

    if (!(isR5 || isOwner || isAdmin)) {
      await interaction.editReply('❌ You are not allowed to manage the King role. (Requires R5, Owner, or Admin.)');
      return;
    }

    const me = await guild.members.fetchMe().catch(() => null);
    if (!me) {
      await interaction.editReply('⚠️ Could not fetch my member object. Do I have permission to view members?');
      return;
    }

    const { kingRole, buffRole } = await getConfiguredRoles(guildId, guild);
    if (!kingRole) {
      await interaction.editReply('⚠️ King role no longer exists. Re-set it with `/config kingrole`.');
      return;
    }

    const canManageKing = canBotManageRole(me, kingRole);
    const canManageBuff = canBotManageRole(me, buffRole);

    if (!canManageKing) {
      await interaction.editReply(
        [
          '❌ I cannot edit the **King** role.',
          '• Make sure I have **Manage Roles**',
          '• My highest role is **above** the King role',
          '• The King role is **not managed** (integration/linked)'
        ].join('\n')
      );
      return;
    }

    const selectedIds = interaction.values; // users chosen
    const grant = (interaction.customId === 'king_grant');
    const results = [];

    if (grant) {
      // Remove King from everyone not selected
      for (const [, m] of kingRole.members) {
        if (!selectedIds.includes(m.id)) {
          try {
            await m.roles.remove(kingRole);
            results.push(`🗑️ Removed King from ${m.displayName || m.user.username}`);

            // also remove Buff role when King removed
            if (buffRole && canManageBuff && m.roles.cache.has(buffRole.id)) {
              await m.roles.remove(buffRole).catch(() => {});
            }
          } catch (e) {
            results.push(`⚠️ Failed removing King from <@${m.id}> (${e?.message || 'error'})`);
          }
        }
      }

      // Grant to selected + also give Buff role
      for (const uid of selectedIds) {
        try {
          const m = await guild.members.fetch(uid);
          if (!m.roles.cache.has(kingRole.id)) {
            await m.roles.add(kingRole);
            results.push(`✅ Granted King to ${m.displayName || m.user.username}`);
          } else {
            results.push(`ℹ️ ${m.displayName || m.user.username} already has King`);
          }

          // Also assign Buff role to the King (independent of shift logic)
          if (buffRole && canManageBuff && !m.roles.cache.has(buffRole.id)) {
            await m.roles.add(buffRole).catch(() => {});
          }
        } catch (e) {
          results.push(`⚠️ Failed granting King to <@${uid}> (${e?.message || 'error'})`);
        }
      }

      if (selectedIds.length === 0 && kingRole.members.size === 0) {
        results.push('ℹ️ No user selected. All current Kings have been cleared.');
      }

      await interaction.editReply(results.join('\n') || '✅ King assignment updated.');
      return;
    }

    // REVOKE branch: remove King (and Buff role too)
    for (const uid of selectedIds) {
      try {
        const m = await guild.members.fetch(uid);
        if (m.roles.cache.has(kingRole.id)) {
          await m.roles.remove(kingRole);
          results.push(`✅ Revoked King from ${m.displayName || m.user.username}`);

          if (buffRole && canManageBuff && m.roles.cache.has(buffRole.id)) {
            await m.roles.remove(buffRole).catch(() => {});
          }
        } else {
          results.push(`ℹ️ ${m.displayName || m.user.username} did not have King`);
        }
      } catch (e) {
        results.push(`⚠️ Failed revoking King from <@${uid}> (${e?.message || 'error'})`);
      }
    }

    await interaction.editReply(results.join('\n') || '✅ King role updated.');
  } catch (err) {
    console.error('king_grant/revoke error:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: '⚠️ An error occurred handling King assignment.', flags: MessageFlags.Ephemeral }).catch(()=>{});
    } else {
      await interaction.editReply('⚠️ An error occurred handling King assignment. Check my role permissions & hierarchy.');
    }
  }
}

/* ========= Route UserSelect interactions to onUserSelectKing ========= */

export async function onSelectMenuRouter(interaction) {
  // If this is a UserSelect (type 3) for king assignment, handle here.
  if (interaction.customId === 'king_grant' || interaction.customId === 'king_revoke') {
    return onUserSelectKing(interaction);
  }
  // Otherwise, it’s a StringSelect and should go to onSelectMenu
  return onSelectMenu(interaction);
}