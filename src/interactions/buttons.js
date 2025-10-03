// src/interactions/buttons.js
import { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
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
        hoursArray().map((h) => ({
          label: `${String(h).padStart(2, '0')}:00`,
          value: String(h),
          default: preSelected.includes(h),
        }))
      )
  );
}

export async function onButton(interaction) {
  // --- King presses the DM button to notify assignees (sent via DM by tick.js) ---
  if (interaction.customId.startsWith('notify_assignees:')) {
    const [, guildId, dateStr, hourStr] = interaction.customId.split(':');
    const hour = Number.parseInt(hourStr, 10);

    // Build a UTC Date for the requested slot
    const cur = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:00:00Z`);

    try {
      // 1) Strict lookup for the requested slot
      let lookup = { date: dateStr, hour };
      let { rows: currRows } = await q(
        `SELECT user_id
           FROM shifts
          WHERE guild_id = $1
            AND date_utc = $2::date
            AND hour = $3::int`,
        [guildId, lookup.date, lookup.hour]
      );

      // 2) Fallback to adjacent hours if nothing found (handles last-minute edits or midnight wrap)
      let fallbackNote = '';
      if (!currRows.length) {
        const candidates = [
          // previous hour (wrap to previous day if needed)
          (() => {
            const d = new Date(cur); d.setUTCHours(d.getUTCHours() - 1);
            return { date: d.toISOString().slice(0,10), hour: d.getUTCHours() };
          })(),
          // next hour (wrap to next day if needed)
          (() => {
            const d = new Date(cur); d.setUTCHours(d.getUTCHours() + 1);
            return { date: d.toISOString().slice(0,10), hour: d.getUTCHours() };
          })()
        ];

        for (const c of candidates) {
          const r = await q(
            `SELECT user_id
               FROM shifts
              WHERE guild_id = $1
                AND date_utc = $2::date
                AND hour = $3::int`,
            [guildId, c.date, c.hour]
          );
          if (r.rows.length) {
            lookup = { date: c.date, hour: c.hour };
            currRows = r.rows;
            fallbackNote = ` (used **${lookup.date} ${String(lookup.hour).padStart(2,'0')}:00 UTC** after fallback)`;
            break;
          }
        }
      }

      if (!currRows.length) {
        await interaction.reply({
          content: `No assignees found for **${dateStr} ${String(hour).padStart(2,'0')}:00 UTC**.\n` +
                   `Tip: run \`/roster list date:${dateStr}\` to confirm hours.`,
        });
        return;
      }

      // Compute previous slot based on the (possibly fallback) lookup
      const cur2 = new Date(`${lookup.date}T${String(lookup.hour).padStart(2,'0')}:00:00Z`);
      const prev = new Date(cur2); prev.setUTCHours(prev.getUTCHours() - 1);
      const prevDate = prev.toISOString().slice(0,10);
      const prevHour = prev.getUTCHours();

      const { rows: prevRows } = await q(
        `SELECT user_id
           FROM shifts
          WHERE guild_id = $1
            AND date_utc = $2::date
            AND hour = $3::int`,
        [guildId, prevDate, prevHour]
      );

      const currSet = new Set(currRows.map(r => r.user_id));
      const prevSet = new Set(prevRows.map(r => r.user_id));

      const comingOff = [...prevSet].filter(uid => !currSet.has(uid)); // remove role from
      const goingOn   = [...currSet];                                   // add role to

      // 3) Swap the Buff role (with diagnostics)
      const { rows: gset } = await q(
        `SELECT buff_role_id FROM guild_settings WHERE guild_id=$1`,
        [guildId]
      );
      const buffRoleId = gset[0]?.buff_role_id;

      let roleOpsMsg = 'ℹ️ No Buff role configured; skipped role changes.';
      let roleOpsOK = false;

      if (buffRoleId) {
        const guild = await interaction.client.guilds.fetch(guildId);
        const me    = await guild.members.fetchMe();
        const role  = await guild.roles.fetch(buffRoleId).catch(() => null);

        if (!role) {
          roleOpsMsg = `⚠️ Buff role <@&${buffRoleId}> not found. Re-set with \`/config buffrole\`.`;
        } else {
          const canManageRoles = me.permissions.has('ManageRoles');
          const above          = me.roles.highest.comparePositionTo(role) > 0;
          const notManaged     = !role.managed;

          if (!canManageRoles) roleOpsMsg = '❌ Missing **Manage Roles** permission.';
          else if (!above)      roleOpsMsg = '❌ My top role is **not above** the Buff role. Move my role higher.';
          else if (!notManaged) roleOpsMsg = '❌ Buff role is **managed** by an integration; cannot assign.';
          else {
            roleOpsOK = true;
            try {
              // Remove from users coming OFF
              for (const uid of comingOff) {
                try { const m = await guild.members.fetch(uid); await m.roles.remove(role).catch(()=>{}); } catch {}
              }
              // Add to users going ON
              for (const uid of goingOn) {
                try { const m = await guild.members.fetch(uid); await m.roles.add(role).catch(()=>{}); } catch {}
              }
              roleOpsMsg = '✅ Roles updated for this slot.';
            } catch (e) {
              roleOpsMsg = `⚠️ Role update error: ${e.message || e}`;
            }
          }
        }
      }

      // 4) DM each current assignee
      for (const r of currRows) {
        try {
          const user = await interaction.client.users.fetch(r.user_id);
          await user.send(
            `👑 The King has assigned you for **${lookup.date} ${String(lookup.hour).padStart(2,'0')}:00 UTC**. Please take position.`
          );
        } catch {}
      }

      await interaction.reply({
        content: `${roleOpsMsg}\n✅ Notified assignees for **${lookup.date} ${String(lookup.hour).padStart(2,'0')}:00 UTC**.${fallbackNote}`,
      });

      // Useful server log
      console.log('[notify_assignees]', {
        guildId, lookup,
        comingOff, goingOn,
        roleConfigured: !!buffRoleId,
        roleOpsOK, roleOpsMsg
      });

    } catch (e) {
      await interaction.reply({
        content: `⚠️ Could not update roles or notify assignees. (${e.message || 'unknown error'})`,
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

    const cid =
      action === 'add_hours_ep'
        ? `add_hours_submit:${date}`
        : `remove_hours_submit:${date}`;
    const ph =
      action === 'add_hours_ep'
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

export async function onSelectMenu(interaction) {
  // Handle the public date dropdown to avoid "interaction failed"
  if (interaction.customId === 'date_select') {
    const date = interaction.values[0];

    // Private mini-panel for this user with the date baked into button IDs
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

  // Multi-select submit handlers
  const [action, date] = interaction.customId.split(':');
  if (!['add_hours_submit', 'remove_hours_submit', 'edit_hours_submit'].includes(action)) return;

  const hours = interaction.values.map((v) => parseInt(v, 10));
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

  // Live-refresh the day channel embed if it exists
  try {
    const { rows: gset } = await q(
      `SELECT category_id FROM guild_settings WHERE guild_id=$1`,
      [guildId]
    );
    const categoryId = gset[0]?.category_id;
    if (categoryId) {
      const category = await interaction.client.channels.fetch(categoryId).catch(() => null);
      const ch = category?.children?.cache?.find((c) => c.name === date);
      if (ch) {
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
        await upsertDayMessage(interaction.client, guildId, ch, date, slots);
      }
    }
  } catch {
    // ignore
  }

  // Replace the ephemeral multi-select with a confirmation
  await interaction.update({
    content: '✅ Saved! Your roster has been updated.',
    components: [],
  });
}