import { q } from '../db/pool.js';
import { buildDayEmbed } from './embeds.js';

/**
 * Ensure exactly one roster message exists in the given channel for dateStr,
 * store it in day_channels, and return { channel, message }.
 * If message exists, it is edited in-place with the latest embed.
 */
export async function upsertDayMessage(client, guildId, channel, dateStr, slots) {
  const { rows } = await q(
    `INSERT INTO day_channels(guild_id, date_utc, channel_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (guild_id, date_utc) DO UPDATE SET channel_id=EXCLUDED.channel_id
     RETURNING message_id`,
    [guildId, dateStr, channel.id]
  );
  const currentId = rows[0]?.message_id || null;
  const embed = buildDayEmbed(dateStr, slots);

  let msg;
  try {
    if (currentId) {
      msg = await channel.messages.fetch(currentId);
      await msg.edit({ content: `**Roster for ${dateStr} (UTC)**`, embeds: [embed] });
    } else {
      msg = await channel.send({ content: `**Roster for ${dateStr} (UTC)**`, embeds: [embed] });
      await q(`UPDATE day_channels SET message_id=$1 WHERE guild_id=$2 AND date_utc=$3`, [msg.id, guildId, dateStr]);
    }
  } catch {
    msg = await channel.send({ content: `**Roster for ${dateStr} (UTC)**`, embeds: [embed] });
    await q(`UPDATE day_channels SET message_id=$1 WHERE guild_id=$2 AND date_utc=$3`, [msg.id, guildId, dateStr]);
  }
  return { channel, message: msg };
}
