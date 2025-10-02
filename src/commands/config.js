import { q } from '../db/pool.js';

export default {
  data: {
    name: 'config',
    description: 'Configure bot settings',
    options: [
      { name:'kingrole', description:'Set King role', type:1, options:[{ name:'role', type:8, description:'Role', required:true }]},
      { name:'userlead', description:'Set user reminder lead minutes', type:1, options:[{ name:'minutes', type:4, required:true }]},
      { name:'kinglead', description:'Set King change-lead minutes', type:1, options:[{ name:'minutes', type:4, required:true }]}
    ]
  },
  execute: async (interaction) => {
    const sub = interaction.options.getSubcommand();
    if (sub === 'kingrole') {
      const role = interaction.options.getRole('role');
      await q(`INSERT INTO guild_settings(guild_id, king_role_id) VALUES ($1,$2)
               ON CONFLICT(guild_id) DO UPDATE SET king_role_id=EXCLUDED.king_role_id`, [interaction.guildId, role.id]);
      return interaction.reply({ content:`King role set to ${role}.`, ephemeral:true });
    }
    if (sub === 'userlead') {
      const m = interaction.options.getInteger('minutes');
      await q(`UPDATE guild_settings SET notify_lead_minutes=$1 WHERE guild_id=$2`, [m, interaction.guildId]);
      return interaction.reply({ content:`User reminder lead set to ${m} minutes.`, ephemeral:true });
    }
    if (sub === 'kinglead') {
      const m = interaction.options.getInteger('minutes');
      await q(`UPDATE guild_settings SET king_change_lead_minutes=$1 WHERE guild_id=$2`, [m, interaction.guildId]);
      return interaction.reply({ content:`King change lead set to ${m} minutes.`, ephemeral:true });
    }
  }
};
