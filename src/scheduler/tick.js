import cron from 'node-cron';
import { q } from '../db/pool.js';
import { nowUtc } from '../util/time.js';

export function startTick(client) {
  // Every minute: user reminders + king change notifications
  cron.schedule('* * * * *', async () => {
    const now = nowUtc();

    const { rows: guilds } = await q(`SELECT * FROM guild_settings`);
    for (const g of guilds) {
      const leadUser = g.notify_lead_minutes ?? 15;
      const leadKing = g.king_change_lead_minutes ?? 10;

      // USER reminders
      const target = now.add(leadUser, 'minute');
      const date = target.format('YYYY-MM-DD');
      const hour = target.hour();
      const { rows: urows } = await q(
        `SELECT user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND hour=$3`,
        [g.guild_id, date, hour]
      );

      for (const r of urows) {
        const check = await q(
          `INSERT INTO reminders_sent(guild_id,date_utc,hour,user_id,kind)
           VALUES ($1,$2,$3,$4,'user')
           ON CONFLICT DO NOTHING RETURNING id`,
          [g.guild_id, date, hour, r.user_id]
        );
        if (check.rowCount) {
          try {
            const user = await client.users.fetch(r.user_id);
            await user.send(
              `⏰ Reminder: your **buff giver** slot starts at **${date} ${String(hour).padStart(2,'0')}:00 UTC** in ${leadUser} minutes.`
            );
          } catch {}
        }
      }

      // KING change notifications (only when assignees differ hour-over-hour)
      const kingTarget = now.add(leadKing, 'minute');
      const d2 = kingTarget.format('YYYY-MM-DD');
      const h2 = kingTarget.hour();
      const prev = kingTarget.subtract(1, 'hour');
      const d1 = prev.format('YYYY-MM-DD');
      const h1 = prev.hour();

      const { rows: a2 } = await q(
        `SELECT user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND hour=$3`,
        [g.guild_id, d2, h2]
      );
      const { rows: a1 } = await q(
        `SELECT user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2 AND hour=$3`,
        [g.guild_id, d1, h1]
      );

      const set2 = new Set(a2.map(x => x.user_id));
      const set1 = new Set(a1.map(x => x.user_id));
      const changed =
        set2.size !== set1.size || [...set2].some(x => !set1.has(x));

      if (changed) {
        const ins = await q(
          `INSERT INTO reminders_sent(guild_id,date_utc,hour,user_id,kind)
           VALUES ($1,$2,$3,'__king__','king')
           ON CONFLICT DO NOTHING RETURNING id`,
          [g.guild_id, d2, h2]
        );

        if (ins.rowCount && g.king_role_id) {
          try {
            const guild = await client.guilds.fetch(g.guild_id);
            const role = await guild.roles.fetch(g.king_role_id);

            if (role) {
              for (const [_, member] of role.members) {
                const dm = await member.createDM().catch(() => null);
                if (!dm) continue;

                await dm.send({
                  content: `👑 Heads up: upcoming slot **${d2} ${String(h2).padStart(
                    2,
                    '0'
                  )}:00 UTC** has **changed assignees**.  
When you’ve put them in position, tap below to notify them by DM.`,
                  components: [
                    {
                      type: 1,
                      components: [
                        {
                          type: 2,
                          style: 1, // Primary
                          custom_id: `notify_assignees:${g.guild_id}:${d2}:${h2}`,
                          label: 'Notify Assignees Now'
                        }
                      ]
                    }
                  ]
                });
              }
            }
          } catch {}
        }
      }
    }
  });
}