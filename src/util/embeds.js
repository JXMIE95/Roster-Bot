// src/util/embeds.js
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder
} from 'discord.js';
import { hoursArray } from './time.js';

export function rosterPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('Buff Givers Roster Panel')
    .setDescription(
      'Please select a date to add/remove/edit your rostered hours. ' +
      'You can schedule yourself for up to 7 days in advance. All times are UTC.'
    )
    .setColor(0x2b2d31);
}

export function rosterPanelComponents(dates) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('date_select')
        .setPlaceholder('Select a date (next 7 days)')
        .setMinValues(1).setMaxValues(1)
        .addOptions(dates.map(d => ({ label: d, value: d })))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('add_hours').setLabel('Add Hours').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('remove_hours').setLabel('Remove Hours').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('edit_hours').setLabel('Edit My Hours').setStyle(ButtonStyle.Primary)
    )
  ];
}

/** Builds the embed text for a day's lineup */
export function buildDayEmbed(dateStr, slots) {
  const lines = slots.map(s => {
    const names = s.users.length ? s.users.map(u => `<@${u.id}>`).join(', ') : '—';
    const open = s.remaining ? ` *(+${s.remaining} open)*` : '';
    return `**${String(s.hour).padStart(2, '0')}:00**  ${names}${open}`;
  }).join('\n') || 'No assignments yet.';

  return new EmbedBuilder()
    .setTitle(`Hourly Roster — ${dateStr} (UTC)`)
    .setDescription(lines)
    .setColor(0x5865f2);
}

export function kingAssignmentEmbed() {
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('👑 King Assignment')
    .setDescription(
      `R5 can assign the **King role** using the selector below.\n` +
      `When you confirm, the bot will **remove the King role from everyone else** and grant it to the selected member(s).\n\n` +
    );
}

export function kingAssignmentComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('king_grant')
        .setPlaceholder('Select member(s) to be King now')
        .setMinValues(0)
        .setMaxValues(1)
    )
  ];
}

/** Convenience for first-time post (setup) */
export function dayRosterPayload(dateStr, slots) {
  return {
    content: `**Roster for ${dateStr} (UTC)**`,
    embeds: [buildDayEmbed(dateStr, slots)]
  };
}