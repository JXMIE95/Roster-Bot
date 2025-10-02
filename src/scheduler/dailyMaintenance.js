import cron from 'node-cron';
import { q } from '../db/pool.js';
import { nowUtc } from '../util/time.js';
import { upsertDayMessage } from '../util/dayMessage.js';

export function startDailyMaintenance(client) {
  // 00:05 UTC daily: keep a 7-day rolling window; refresh in-place embeds
  cron.schedule('5 0 * * *', async () => {
    const today = nowUtc().startOf('day');
    const dates = Array.from({length:7}, (_,i)=>today.add(i,'day').format('YYYY-MM-DD'));
    const yesterday = today.subtract(1,'day').format('YYYY-MM-DD');

    const { rows: guilds } = await q(`SELECT * FROM guild_settings`);
    for (const g of guilds) {
      if (!g.category_id) continue;

      let category;
      try { category = await client.channels.fetch(g.category_id); } catch { continue; }

      // Delete yesterday channel and DB entry
      const ych = category.children.cache.find(c => c.name === yesterday);
      if (ych) { try { await ych.delete('Roster rolling window'); } catch {} }
      await q(`DELETE FROM day_channels WHERE guild_id=$1 AND date_utc=$2`, [g.guild_id, yesterday]);

      // Ensure channels & update the single message in-place
      for (const d of dates) {
        let ch = category.children.cache.find(c => c.name === d);
        if (!ch) {
          try { ch = await category.guild.channels.create({ name: d, parent: category.id, type: 0 }); } catch { continue; }
        }

        const { rows } = await q(
          `SELECT hour, user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2 ORDER BY hour`, [g.guild_id, d]
        );
        const map = new Map();
        rows.forEach(r => {
          if (!map.has(r.hour)) map.set(r.hour, []);
          map.get(r.hour).push(r.user_id);
        });
        const slots = Array.from({length:24},(_,h)=>({
          hour: h,
          users: (map.get(h)||[]).map(uid=>({ id: uid })),
          remaining: Math.max(0, 2 - (map.get(h)?.length||0))
        }));

        await upsertDayMessage(client, g.guild_id, ch, d, slots);
      }
    }
  });

  // Refresh current day every 5 minutes for live roster edits
  cron.schedule('*/5 * * * *', async () => {
    const currentDate = nowUtc().format('YYYY-MM-DD');
    const { rows: guilds } = await q(`SELECT * FROM guild_settings WHERE category_id IS NOT NULL`);
    for (const g of guilds) {
      let category;
      try { category = await client.channels.fetch(g.category_id); } catch { continue; }
      const ch = category.children.cache.find(c => c.name === currentDate);
      if (!ch) continue;

      const { rows } = await q(
        `SELECT hour, user_id FROM shifts WHERE guild_id=$1 AND date_utc=$2 ORDER BY hour`, [g.guild_id, currentDate]
      );
      const map = new Map();
      rows.forEach(r => {
        if (!map.has(r.hour)) map.set(r.hour, []);
        map.get(r.hour).push(r.user_id);
      });
      const slots = Array.from({length:24},(_,h)=>({
        hour: h,
        users: (map.get(h)||[]).map(uid=>({ id: uid })),
        remaining: Math.max(0, 2 - (map.get(h)?.length||0))
      }));

      await upsertDayMessage(client, g.guild_id, ch, currentDate, slots);
    }
  });
}
