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
  // --- King presses the DM button to notify assignees (sent by tick.js in a DM) ---
  if (interaction.customId.startsWith('notify_assignees:')) {
    const [, guildId, date, hourStr] = interaction.customId.split(':');
    const hour = parseInt(hourStr, 10);

    try {
      const { rows } = await q(
        `SELECT user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND hour=$3`,
        [guildId, date, hour]
      );

      if (!rows.length) {
        // In DMs, ephemeral isn't supported; regular reply is fine
        await interaction.reply({
          content: `No assignees for ${date} ${String(hour).padStart(2, '0')}:00 UTC.`,
        });
        return;
      }

      // DM each assignee
      for (const r of rows) {
        try {
          const user = await interaction.client.users.fetch(r.user_id);
          await user.send(
            `👑 The King has assigned you for **${date} ${String(hour).padStart(
              2,
              '0'
            )}:00 UTC**. Please take position.`
          );
        } catch {
          // ignore DM failures
        }
      }

      await interaction.reply({ content: '✅ Notified the assignees by DM.' });
    } catch (e) {
      await interaction.reply({
        content:
          '⚠️ Could not notify assignees (I may not have permission to DM them).',
      });
    }
    return;
  }

  // --- Ephemeral add/remove/edit that include the date in the custom id ---
  if (
    interaction.customId.startsWith('add_hours_ep:') ||
    interaction.customId.startsWith('remove_hours_ep:') ||
    interaction.customId.startsWith('edit_hours_ep:')
  ) {
    const [action, date] = interaction.customId.split(':'); // e.g., add_hours_ep:2025-10-05

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

  // --- Fallback for legacy public buttons: ask them to pick a date first ---
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
  if (
    !['add_hours_submit', 'remove_hours_submit', 'edit_hours_submit'].includes(
      action
    )
  )
    return;

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
      const category = await interaction.client.channels
        .fetch(categoryId)
        .catch(() => null);
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