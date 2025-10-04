// src/util/embeds.js
import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder
} from 'discord.js';

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
      const names = s.users.length ? s.users.map(u => `<@${u.id}>`).join(', ') : '—';
      const open = s.remaining ? ` *(+${s.remaining} open)*` : '';
      return `**${String(s.hour).padStart(2, '0')}:00**  ${names}${open}`;
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
      'Use the selector below to **assign the King role**.\n\n' +
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
      'Kings, R5, or Admins can use this panel to **manually assign or remove** the **Buff Giver** role.\n\n' +
      '• **Assign Buff Giver:** choose member(s) to give the Buff role\n' +
      '• **Remove Buff Giver:** choose member(s) to remove the Buff role\n\n' +
      'The bot must have **Manage Roles** and its highest role **above the Buff Giver role** to function.'
    );
}

export function buffManagerComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('buff_grant')
        .setPlaceholder('Select member(s) to ASSIGN Buff Giver role')
        .setMinValues(1)
        .setMaxValues(10)
    ),
    new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder()
        .setCustomId('buff_revoke')
        .setPlaceholder('Select member(s) to REMOVE Buff Giver role')
        .setMinValues(1)
        .setMaxValues(10)
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