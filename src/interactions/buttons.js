import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
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
      .addOptions(hoursArray().map(h => ({
        label: `${String(h).padStart(2,'0')}:00`,
        value: String(h),
        default: preSelected.includes(h)
      })))
  );
}

export async function onButton(interaction) {
  if (interaction.customId === 'king_confirm') {
    await interaction.deferReply({ ephemeral: true });
    await interaction.followUp({ content: 'Use `/kingnotify now` for the current hour, or `/kingnotify slot date:YYYY-MM-DD hour:HH` for a specific slot.', ephemeral: true });
    return;
  }

  if (interaction.customId === 'add_hours' || interaction.customId === 'remove_hours' || interaction.customId === 'edit_hours') {
    const selected = interaction.message?.components?.[0]?.components?.[0]?.data?.values 
      ?? interaction.message?.components?.[0]?.components?.[0]?.values;
    const date = (selected && selected[0]) || null;
    if (!date) return interaction.reply({ content: 'Please select a date from the dropdown first.', ephemeral: true });

    const { rows } = await q(`SELECT hour FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND user_id=$3 ORDER BY hour`,
      [interaction.guildId, date, interaction.user.id]);
    const my = rows.map(r=>r.hour);

    if (interaction.customId === 'edit_hours') {
      return interaction.reply({
        ephemeral: true,
        content: `Edit your hours for **${date} UTC**`,
        components: [ hourMultiSelect(`edit_hours_submit:${date}`, 'Select all hours you will cover', my) ]
      });
    }

    const cid = interaction.customId === 'add_hours' ? `add_hours_submit:${date}` : `remove_hours_submit:${date}`;
    const ph = interaction.customId === 'add_hours' ? 'Select hours to add' : 'Select hours to remove';
    return interaction.reply({ ephemeral: true, content: `Choose hours for **${date} UTC**`, components: [ hourMultiSelect(cid, ph) ] });
  }
}

export async function onSelectMenu(interaction) {
  const [action, date] = interaction.customId.split(':');
  if (!['add_hours_submit','remove_hours_submit','edit_hours_submit'].includes(action)) return;

  const hours = interaction.values.map(v=>parseInt(v,10));
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  if (action === 'remove_hours_submit' || action === 'edit_hours_submit') {
    await q(`DELETE FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND user_id=$3`, [guildId, date, userId]);
  }

  if (action !== 'remove_hours_submit') {
    for (const h of hours) {
      const { rows } = await q(`SELECT COUNT(*)::int AS c FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND hour=$3`, [guildId, date, h]);
      if (rows[0].c < 2) {
        await q(`INSERT INTO shifts(guild_id,date_utc,hour,user_id,created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [guildId, date, h, userId, userId]);
      }
    }
  }

  // Live-refresh the day channel embed if it exists
  try {
    const { rows: gset } = await q(`SELECT category_id FROM guild_settings WHERE guild_id=$1`, [guildId]);
    const categoryId = gset[0]?.category_id;
    if (categoryId) {
      const category = await interaction.client.channels.fetch(categoryId).catch(()=>null);
      const ch = category?.children?.cache?.find(c => c.name === date);
      if (ch) {
        const { rows } = await q(`SELECT hour, user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2 ORDER BY hour`, [guildId, date]);
        const by = new Map();
        rows.forEach(r => { if (!by.has(r.hour)) by.set(r.hour, []); by.get(r.hour).push(r.user_id); });
        const slots = Array.from({length:24},(_,h)=>({
          hour:h,
          users:(by.get(h)||[]).map(uid=>({id:uid})),
          remaining: Math.max(0, 2 - (by.get(h)?.length||0))
        }));
        await upsertDayMessage(interaction.client, guildId, ch, date, slots);
      }
    }
  } catch {}

  await interaction.update({ content: 'Saved! Your roster has been updated.', components: [] });
}
