// src/interactions/buttons.js
import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';
import { q } from '../db/pool.js';
import { hoursArray, nowUtc } from '../util/time.js';
import { upsertDayMessage } from '../util/dayMessage.js';

// ----- helpers --------------------------------------------------------------

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
  const isAdmin = member.permissions.has('Administrator');

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

  const { rows } = await q(
    `SELECT hour, user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2 ORDER BY hour`,
    [guildId, date]
  );

  const by = new Map();
  rows.forEach((r) => {
    if (!by.has(r.hour)) by.set(r.hour, []);
    by.get(r.hour).push(r.user_id);
  });

  const slots = Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    users: (by.get(h) || []).map((uid) => ({ id: uid })),
    remaining: Math.max(0, 2 - (by.get(h)?.length || 0)),
  }));

  await upsertDayMessage(client, guildId, ch, date, slots);
}

/**
 * If the manager updated the CURRENT UTC hour, immediately sync the live Buff role:
 * - add role to new assignees
 * - remove role from users who just came off this hour
 */
async function syncBuffRoleIfNow(interaction, date, hour, beforeIds) {
  const now = nowUtc();
  const todayStr = now.clone().format('YYYY-MM-DD');
  const curHour = now.hour();
  if (date !== todayStr || hour !== curHour) return;

  // Load buff role
  const { rows: gset } = await q(
    `SELECT buff_role_id FROM guild_settings WHERE guild_id=$1`,
    [interaction.guildId]
  );
  const buffRoleId = gset[0]?.buff_role_id;
  if (!buffRoleId) return;

  const guild = interaction.guild;
  const me = await guild.members.fetchMe();
  const role = await guild.roles.fetch(buffRoleId).catch(() => null);
  if (!role) return;

  const canManage =
    me.permissions.has('ManageRoles') &&
    me.roles.highest.comparePositionTo(role) > 0 &&
    !role.managed;
  if (!canManage) return;

  // after-update assignees
  const { rows: afterRows } = await q(
    `SELECT user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2::date AND hour=$3::int`,
    [interaction.guildId, date, hour]
  );
  const afterIds = new Set(afterRows.map(r => r.user_id));
  const beforeSet = new Set(beforeIds || []);

  // add role to new assignees
  for (const uid of afterIds) {
    try {
      const m = await guild.members.fetch(uid);
      if (!m.roles.cache.has(role.id)) await m.roles.add(role).catch(() => {});
    } catch {}
  }

  // remove from those no longer in this slot
  for (const uid of beforeSet) {
    if (!afterIds.has(uid)) {
      try {
        const m = await guild.members.fetch(uid);
        if (m.roles.cache.has(role.id)) await m.roles.remove(role).catch(() => {});
      } catch {}
    }
  }
}

// ----- onButton -------------------------------------------------------------

export async function onButton(interaction) {
  // --- King presses the DM button to notify assignees (ONE-TIME) ---
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
      // one-time idempotency
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
          ephemeral: true
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
          ephemeral: true
        });
        return;
      }

      // DM each assignee
      for (const r of currRows) {
        try {
          const user = await interaction.client.users.fetch(r.user_id);
          await user.send(
            `👑 The King has assigned you for **${dateStr} ${String(hour).padStart(2, '0')}:00 UTC**. Please take position.`
          );
        } catch {}
      }

      // Record one-time usage & lock button
      await q(
        `INSERT INTO reminders_sent(guild_id,date_utc,hour,user_id,kind)
         VALUES ($1,$2,$3,'__king_notify__','king_notify')
         ON CONFLICT DO NOTHING`,
        [guildId, dateStr, hour]
      );
      await disableNotifyButton();

      await interaction.reply({
        content: `✅ Notified assignees for **${dateStr} ${String(hour).padStart(2, '0')}:00 UTC**. (Button locked)`,
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

  // --- King presses the DM button to copy assignee names (single-line) ---
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

  // --- Buff Manager: action buttons -> open user picker (single-hour path) ---
  if (interaction.customId.startsWith('bm_act:')) {
    // bm_act:<add|remove|replace>:YYYY-MM-DD:HH
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage this slot.', ephemeral: true });
      return;
    }

    const [, action, date, hourStr] = interaction.customId.split(':');
    const hour = parseInt(hourStr, 10);

    // Read current assignees to size the picker if needed
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
      ephemeral: true,
      content: `📌 **${date} ${String(hour).padStart(2,'0')}:00 UTC** — choose members to **${action.toUpperCase()}**:`,
      components: [row]
    });
    return;
  }

  // --- Buff Manager: action buttons -> open user picker (multi-hour path) ---
  if (interaction.customId.startsWith('bm_act_multi:')) {
    // bm_act_multi:<add|remove|replace>:YYYY-MM-DD:h1,h2,h3
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage these slots.', ephemeral: true });
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
      ephemeral: true,
      content: `📌 **${date}** — hours **${hours.map(h=>String(h).padStart(2,'0')).join(', ')}:00 UTC**. Choose members to **${action.toUpperCase()}** across all selected hours:`,
      components: [row]
    });
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
    const my = rows.map((r) => r.hour);

    if (action === 'edit_hours_ep') {
      await interaction.reply({
        ephemeral: true,
        content: `Edit your hours for **${date} UTC**`,
        components: [
          hourMultiSelect(
            `edit_hours_submit:${date}`,
            'Select all hours you will cover',
            my
          ),
        ],
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
      ephemeral: true,
      content: `Choose hours for **${date} UTC**`,
      components: [hourMultiSelect(cid, ph)],
    });
    return;
  }

  // --- Legacy public buttons: ask them to pick a date first ---
  if (
    interaction.customId === 'add_hours' ||
    interaction.customId === 'remove_hours' ||
    interaction.customId === 'edit_hours'
  ) {
    await interaction.reply({
      ephemeral: true,
      content:
        'Pick a date from the dropdown above first. (After you select a date, I’ll open a private picker.)',
    });
    return;
  }
}

// ----- onSelectMenu (single export) --------------------------------

export async function onSelectMenu(interaction) {
  // === Buff Manager: initial date pick -> multi-hour select ===
  if (interaction.customId === 'bm_date') {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', ephemeral: true });
      return;
    }
    const date = interaction.values[0];

    // Multi-hour select for this date
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
      ephemeral: true,
      content: `📅 Date selected: **${date}**. Now pick **one or more hours**:`,
      components: [row]
    });
    return;
  }

  // === Buff Manager: initial hour pick (single-hour path) -> date select ===
  if (interaction.customId === 'bm_hour') {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', ephemeral: true });
      return;
    }
    const hour = parseInt(interaction.values[0], 10);
    // Ask for date (with hour baked into customId)
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
      ephemeral: true,
      content: `🕑 Hour selected: **${String(hour).padStart(2,'0')}:00**. Now pick a **date**:`,
      components: [row]
    });
    return;
  }

  // === Buff Manager: date -> single-hour (old path) ===
  if (interaction.customId.startsWith('bm2_hour:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', ephemeral: true });
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
      ephemeral: true,
      content: `📌 Managing **${date} ${String(hour).padStart(2,'0')}:00 UTC**. Choose an action:`,
      components: [row]
    });
    return;
  }

  // === Buff Manager: hour -> date (old path) ===
  if (interaction.customId.startsWith('bm2_date:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', ephemeral: true });
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
      ephemeral: true,
      content: `📌 Managing **${date} ${String(hour).padStart(2,'0')}:00 UTC**. Choose an action:`,
      components: [row]
    });
    return;
  }

  // === Buff Manager: date -> MULTI-HOURS (new path) -> action buttons ===
  if (interaction.customId.startsWith('bm2_hours:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', ephemeral: true });
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
      ephemeral: true,
      content: `📌 Managing **${date}** hours **${hours.map(h=>String(h).padStart(2,'0')).join(', ')}:00 UTC**. Choose an action:`,
      components: [row]
    });
    return;
  }

  // === Buff Manager: user picker results (single-hour path) ===
  if (interaction.customId.startsWith('bm_pick:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', ephemeral: true });
      return;
    }
    // bm_pick:<add|remove|replace>:YYYY-MM-DD:HH
    const [, action, date, hourStr] = interaction.customId.split(':');
    const hour = parseInt(hourStr, 10);
    const guildId = interaction.guildId;
    const userIds = interaction.values; // selected users

    try {
      // BEFORE: current assignees
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

      // NEW: if this is the current UTC hour, sync the live Buff role
      await syncBuffRoleIfNow(interaction, date, hour, current);

      await interaction.reply({
        ephemeral: true,
        content: `✅ Updated **${date} ${String(hour).padStart(2,'0')}:00 UTC** (${action}).`
      });
    } catch (e) {
      await interaction.reply({
        ephemeral: true,
        content: `⚠️ Failed to update slot: ${e.message || e}`
      });
    }
    return;
  }

  // === Buff Manager: user picker results (MULTI-HOUR path) ===
  if (interaction.customId.startsWith('bm_pick_multi:')) {
    if (!(await requireManagerPermission(interaction))) {
      await interaction.reply({ content: '❌ You are not allowed to manage roster slots.', ephemeral: true });
      return;
    }
    // bm_pick_multi:<add|remove|replace>:YYYY-MM-DD:h1,h2,h3
    const [, action, date, hoursCsv] = interaction.customId.split(':');
    const hours = hoursCsv.split(',').map(h => parseInt(h, 10)).filter(Number.isInteger);
    const guildId = interaction.guildId;
    const userIds = interaction.values;

    try {
      for (const hour of hours) {
        // BEFORE: per-hour assignees
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

        // If this is the current hour, sync live role for this hour right away
        await syncBuffRoleIfNow(interaction, date, hour, current);
      }

      await refreshDayEmbed(interaction.client, guildId, date);

      await interaction.reply({
        ephemeral: true,
        content: `✅ Updated **${date}** hours **${hours.map(h=>String(h).padStart(2,'0')).join(', ')}:00 UTC** (${action}).`
      });
    } catch (e) {
      await interaction.reply({
        ephemeral: true,
        content: `⚠️ Failed to update selected hours: ${e.message || e}`
      });
    }
    return;
  }

  // --- R5/King/Admin King Assignment user select (grant OR revoke) ---
  if (interaction.customId === 'king_grant' || interaction.customId === 'king_revoke')) {
    // (unchanged — your existing King role handler can stay here if you prefer it in onButton;
    // if you moved it to the other onSelectMenu below, remove this block to avoid duplicates)
  }

  // --- Roster panel: public date dropdown -> private mini-panel
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
      components: [row],
    });
    return;
  }

  // --- User self-service add/remove/edit submit (with 2+ consecutive rule) ---
  const [action, date] = interaction.customId.split(':');
  if (!['add_hours_submit', 'remove_hours_submit', 'edit_hours_submit'].includes(action)) return;

  const hours = interaction.values.map(v => parseInt(v, 10)).sort((a, b) => a - b);
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  if ((action === 'add_hours_submit' || action === 'edit_hours_submit')) {
    if (hours.length < 2) {
      await interaction.reply({
        content: '⚠️ You must select **at least 2 hours**.',
        ephemeral: true
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
        ephemeral: true
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
}