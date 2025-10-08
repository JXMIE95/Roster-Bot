// src/util/embeds.js
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder
} from 'discord.js';
import { nowUtc } from './time.js';

// ========== helpers ==========
function next7DatesUtc() {
  const base = nowUtc().startOf('day');
  return Array.from({ length: 7 }, (_, i) => base.clone().add(i, 'day').format('YYYY-MM-DD'));
}

// ========== 📅 ROSTER PANEL ==========
export function rosterPanelEmbed() {
  return new EmbedBuilder()
    .setTitle('🗓️ Buff Givers Roster Panel')
    .setDescription(
      'Use the panel below to **add, remove, or edit** your scheduled Buff Giver hours.\n\n' +
      'You can roster yourself for up to **7 days in advance**, and all times are shown in **UTC**.\n\n' +
      'When your shift starts, you’ll automatically receive the **Buff Giver role**, and it will be removed at the end of your shift.'
    )
    .setColor(0x2b2d31);
}

export function rosterPanelComponents(dates) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('date_select')
        .setPlaceholder('📅 Select a date (next 7 days)')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(dates.map(d => ({ label: d, value: d })))
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('add_hours')
        .setLabel('Add Hours')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('remove_hours')
        .setLabel('Remove Hours')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('edit_hours')
        .setLabel('Edit My Hours')
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

// ========== 🕑 DAY ROSTER EMBED ==========
export function buildDayEmbed(dateStr, slots) {
  const lines =
    slots.map(s => {
      const hh = String(s.hour).padStart(2, '0');
      const names = s.users.length ? s.users.map(u => `<@${u.id}>`).join(', ') : '—';
      if (s.locked) {
        // When the King marked this hour unavailable, show a lock and skip the "(+open)" suffix
        return `**${hh}:00** 🔒 *(King unavailable)*  ${names}`;
      }
      const open = s.remaining ? ` *(+${s.remaining} open)*` : '';
      return `**${hh}:00**  ${names}${open}`;
    }).join('\n') || 'No assignments yet.';

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🕑 Hourly Roster — ${dateStr} (UTC)`)
    .setDescription(lines);
}

// ========== 👑 KING ASSIGNMENT ==========
export function kingAssignmentEmbed() {
  return new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('👑 King Assignment')
    .setDescription(
      'Use the selector below to **assign the King role**' +
      'If the person you want to assign is not listed, start typing their name into the search bar and it should appear.\n\n' +
      'When you confirm, the bot will automatically **remove the King role** from all other members ' +
      'and grant it to your selected member.\n\n' +
      'Only **R5**, **Admins**, or the **Server Owner** can use this panel.'
    );
}

export function kingAssignmentComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('king_grant')
        .setPlaceholder('Select the new King')
        .setMinValues(0) // allows clearing all Kings
        .setMaxValues(1)
    )
  ];
}

// ========== 🛡️ BUFF GIVERS MANAGER ==========
export function buffManagerEmbed() {
  return new EmbedBuilder()
    .setColor(0x00b894)
    .setTitle('🛡️ Buff Givers Manager')
    .setDescription(
      'Pick a **date** and an **hour** to manage that slot.\n' +
      'Then **Add**, **Remove**, or **Replace** the assignees for that hour (max 2 per slot).\n\n' +
      'You can also set **King Unavailable** (blackout) for specific **date + hours**. While unavailable:\n' +
      '• Buff Giver signup for those hours is **locked**\n' +
      '• Your other bot can use this to avoid pinging for swaps during those hours\n\n' +
      'Only **King**, **R5**, or **Admins** can use this panel.'
    );
}

export function buffManagerComponents() {
  const dates = next7DatesUtc();
  const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));

  return [
    // Slot management (date + hour)
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('bm_date')
        .setPlaceholder('📅 Select date (next 7 days)')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(dates.map(d => ({ label: d, value: d })))
    ),
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('bm_hour')
        .setPlaceholder('🕑 Select hour (UTC)')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(hours.map(h => ({ label: `${h}:00`, value: String(Number(h)) })))
    ),
    // King Unavailable (blackout) – start by picking a date; handlers will prompt for hours
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('kb_date')
        .setPlaceholder('📵 King Unavailable — pick date')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(dates.map(d => ({ label: d, value: d })))
    )
  ];
}

// ========== 📜 DAY ROSTER PAYLOAD ==========
export function dayRosterPayload(dateStr, slots) {
  return {
    content: `**Roster for ${dateStr} (UTC)**`,
    embeds: [buildDayEmbed(dateStr, slots)]
  };
}