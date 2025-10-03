// src/commands/config.js
import { q } from '../db/pool.js';

export default {
  data: {
    name: 'config',
    description: 'Configure bot settings',
    options: [
      {
        name: 'kingrole',
        description: 'Set King role',
        type: 1,
        options: [{ name: 'role', type: 8, description: 'Role', required: true }]
      },
      {
        name: 'userlead',
        description: 'Set user reminder lead minutes',
        type: 1,
        options: [{ name: 'minutes', type: 4, description: 'Minutes', required: true }]
      },
      {
        name: 'kinglead',
        description: 'Set King change-lead minutes',
        type: 1,
        options: [{ name: 'minutes', type: 4, description: 'Minutes', required: true }]
      },
      {
        name: 'buffrole',
        description: 'Set the Buff Giver role (active slot role)',
        type: 1,
        options: [{ name: 'role', type: 8, description: 'Role', required: true }]
      },
      {
        name: 'r5role',
        description: 'Set the R5 role (can assign King)',
        type: 1,
        options: [{ name: 'role', type: 8, description: 'Role', required: true }]
      },
      {
        name: 'show',
        description: 'Show current configuration',
        type: 1
      }
    ]
  },

  execute: async (interaction) => {
    const sub = interaction.options.getSubcommand();

    if (sub === 'kingrole') {
      const role = interaction.options.getRole('role');
      await q(
        `INSERT INTO guild_settings(guild_id, king_role_id)
         VALUES ($1,$2)
         ON CONFLICT(guild_id) DO UPDATE SET king_role_id=EXCLUDED.king_role_id`,
        [interaction.guildId, role.id]
      );
      return interaction.reply({ content: `👑 King role set to ${role}.`, ephemeral: true });
    }

    if (sub === 'userlead') {
      const m = interaction.options.getInteger('minutes');
      await q(
        `INSERT INTO guild_settings(guild_id, notify_lead_minutes)
         VALUES ($1,$2)
         ON CONFLICT(guild_id) DO UPDATE SET notify_lead_minutes=EXCLUDED.notify_lead_minutes`,
        [interaction.guildId, m]
      );
      return interaction.reply({ content: `⏰ User reminder lead set to ${m} minutes.`, ephemeral: true });
    }

    if (sub === 'kinglead') {
      const m = interaction.options.getInteger('minutes');
      await q(
        `INSERT INTO guild_settings(guild_id, king_change_lead_minutes)
         VALUES ($1,$2)
         ON CONFLICT(guild_id) DO UPDATE SET king_change_lead_minutes=EXCLUDED.king_change_lead_minutes`,
        [interaction.guildId, m]
      );
      return interaction.reply({ content: `🕑 King change lead set to ${m} minutes.`, ephemeral: true });
    }

    if (sub === 'buffrole') {
      const role = interaction.options.getRole('role');
      await q(
        `INSERT INTO guild_settings(guild_id, buff_role_id)
         VALUES ($1,$2)
         ON CONFLICT(guild_id) DO UPDATE SET buff_role_id=EXCLUDED.buff_role_id`,
        [interaction.guildId, role.id]
      );
      return interaction.reply({
        content: `🛡️ Buff Giver role set to ${role}.\nMake sure my role is **above** this role and I have **Manage Roles**.`,
        ephemeral: true
      });
    }

    if (sub === 'r5role') {
      const role = interaction.options.getRole('role');
      await q(
        `INSERT INTO guild_settings(guild_id, r5_role_id)
         VALUES ($1,$2)
         ON CONFLICT(guild_id) DO UPDATE SET r5_role_id=EXCLUDED.r5_role_id`,
        [interaction.guildId, role.id]
      );
      return interaction.reply({
        content: `🎖️ R5 role set to ${role}. Members with this role will be able to assign the King role.`,
        ephemeral: true
      });
    }

    if (sub === 'show') {
      const { rows } = await q(
        `SELECT king_role_id, buff_role_id, r5_role_id, notify_lead_minutes, king_change_lead_minutes
         FROM guild_settings WHERE guild_id=$1`,
        [interaction.guildId]
      );
      const g = rows[0] || {};
      return interaction.reply({
        content:
          [
            `**Current config:**`,
            `• King role: ${g.king_role_id ? `<@&${g.king_role_id}>` : '—'}`,
            `• Buff role: ${g.buff_role_id ? `<@&${g.buff_role_id}>` : '—'}`,
            `• R5 role: ${g.r5_role_id ? `<@&${g.r5_role_id}>` : '—'}`,
            `• User lead minutes: ${g.notify_lead_minutes ?? 15}`,
            `• King lead minutes: ${g.king_change_lead_minutes ?? 10}`
          ].join('\n'),
        ephemeral: true
      });
    }
  }
};