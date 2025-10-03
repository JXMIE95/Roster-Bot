import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { hoursArray } from './time.js';

export function rosterPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('Buff Givers Roster Panel')
    .setDescription('Use the controls below to add/remove/edit your rostered hours for any date in the next 7 days. All times are UTC.')
    .setColor(0x2b2d31);
}

export function rosterPanelComponents(dates) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('date_select')
        .setPlaceholder('Select a date (next 7 days)')
        .setMinValues(1).setMaxValues(1)
        .addOptions(dates.map(d=>({ label: d, value: d })))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('add_hours').setLabel('Add Hours').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('remove_hours').setLabel('Remove Hours').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('edit_hours').setLabel('Edit My Hours').setStyle(ButtonStyle.Primary),
    )
  ];
}

/** Builds the embed text for a day's lineup */
export function buildDayEmbed(dateStr, slots) {
  const lines = slots.map(s => {
    const names = s.users.length ? s.users.map(u=>`<@${u.id}>`).join(', ') : '—';
    const open = s.remaining ? ` *(+${s.remaining} open)*` : '';
    return `**${String(s.hour).padStart(2,'0')}:00**  ${names}${open}`;
  }).join('\n') || 'No assignments yet.';
  return new EmbedBuilder()
    .setTitle(`Hourly Roster — ${dateStr} (UTC)`)
    .setDescription(lines)
    .setColor(0x5865f2);
}

/** Convenience for first-time post (setup) */
export function dayRosterPayload(dateStr, slots) {
  return { content: `**Roster for ${dateStr} (UTC)**`, embeds: [buildDayEmbed(dateStr, slots)] };
}
