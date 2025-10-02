import { q } from '../db/pool.js';

export default {
  data: {
    name: 'roster',
    description: 'Roster queries',
    options: [
      { name:'list', description:'List a day', type:1, options:[{ name:'date', description:'YYYY-MM-DD', type:3, required:true }]},
      { name:'my', description:'Show my upcoming slots', type:1 }
    ]
  },
  execute: async (interaction) => {
    const sub = interaction.options.getSubcommand();
    if (sub === 'list') {
      const date = interaction.options.getString('date');
      const { rows } = await q(`SELECT hour, user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2 ORDER BY hour`, [interaction.guildId, date]);
      const byHour = new Map();
      rows.forEach(r => {
        if (!byHour.has(r.hour)) byHour.set(r.hour, []);
        byHour.get(r.hour).push(r.user_id);
      });
      const lines = Array.from({length:24},(_,h)=>{
        const users = byHour.get(h) || [];
        return `**${String(h).padStart(2,'0')}:00** ${users.length?users.map(u=>`<@${u}>`).join(', '):'—'}`;
      }).join('\n');
      return interaction.reply({ embeds:[{ title:`Roster ${date} (UTC)`, description: lines, color:0x5865f2 }] });
    }
    if (sub === 'my') {
      const { rows } = await q(
        `SELECT date_utc, hour FROM shifts WHERE guild_id=$1 AND user_id=$2 AND date_utc >= CURRENT_DATE
         ORDER BY date_utc, hour LIMIT 50`, [interaction.guildId, interaction.user.id]);
      const desc = rows.length ? rows.map(r=>`• ${r.date_utc} ${String(r.hour).padStart(2,'0')}:00 UTC`).join('\n') : 'No upcoming slots.';
      return interaction.reply({ ephemeral:true, embeds:[{ title:'My upcoming slots', description: desc, color:0x2b2d31 }]});
    }
  }
};
