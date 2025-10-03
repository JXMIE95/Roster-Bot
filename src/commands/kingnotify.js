// src/commands/kingnotify.js
import { q } from '../db/pool.js';
import { nowUtc } from '../util/time.js';

export default {
  data: {
    name: 'kingnotify',
    description: 'King utilities',
    options: [
      { name: 'now', description: 'Notify current hour assignees (DMs)', type: 1 },
      {
        name: 'slot',
        description: 'Notify a specific slot (DMs)',
        type: 1,
        options: [
          { name: 'date', type: 3, description: 'YYYY-MM-DD', required: true },
          { name: 'hour', type: 4, description: '0-23', required: true }
        ]
      }
    ]
  },

  execute: async (interaction) => {
    const sub = interaction.options.getSubcommand();
    let date, hour;

    if (sub === 'now') {
      const d = nowUtc();
      date = d.format('YYYY-MM-DD');
      hour = d.hour();
    } else {
      date = interaction.options.getString('date');
      hour = interaction.options.getInteger('hour');
    }

    const { rows } = await q(
      `SELECT user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND hour=$3`,
      [interaction.guildId, date, hour]
    );

    if (!rows.length) {
      return interaction.reply({
        content: `No assignees for ${date} ${String(hour).padStart(2, '0')}:00 UTC.`,
        ephemeral: true
      });
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

    return interaction.reply({ content: '✅ Notified assignees by DM.', ephemeral: true });
  }
};