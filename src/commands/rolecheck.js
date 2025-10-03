// src/commands/rolecheck.js
export default {
  data: {
    name: 'rolecheck',
    description: 'Check if the bot can manage the configured Buff role and report blockers',
    options: []
  },
  execute: async (interaction) => {
    const guild = interaction.guild;
    const me = await guild.members.fetchMe();

    // Load settings
    const { q } = await import('../db/pool.js');
    const { rows } = await q(
      `SELECT buff_role_id, king_role_id, notify_lead_minutes, king_change_lead_minutes
       FROM guild_settings WHERE guild_id=$1`, [guild.id]
    );
    const g = rows[0] || {};
    const buffRoleId = g?.buff_role_id;

    if (!buffRoleId) {
      return interaction.reply({ content: '⚠️ No Buff role set. Use `/config buffrole role:@YourBuffRole` first.', ephemeral: true });
    }

    const role = await guild.roles.fetch(buffRoleId).catch(() => null);
    if (!role) {
      return interaction.reply({ content: `⚠️ Buff role <@&${buffRoleId}> not found. Re-set it with \`/config buffrole\`.`, ephemeral: true });
    }

    const canManageRoles = me.permissions.has('ManageRoles');
    // In v14: a role is editable if my highest role is above it and I have ManageRoles
    const aboveInHierarchy = me.roles.highest.comparePositionTo(role) > 0;
    const editable = canManageRoles && aboveInHierarchy && !role.managed;

    const lines = [
      `**Buff role:** ${role} (ID: ${role.id})`,
      `• Bot has **Manage Roles**: ${canManageRoles ? '✅' : '❌'}`,
      `• Bot role is **above** Buff role: ${aboveInHierarchy ? '✅' : '❌'}`,
      `• Role is **managed** by integration: ${role.managed ? '❌ (managed)**' : '✅ (normal role)'}`,
      `• Effective **editable** = ${editable ? '✅ OK' : '❌ BLOCKED'}`,
      '',
      `**Current config:**`,
      `• User lead minutes: ${g?.notify_lead_minutes ?? 15}`,
      `• King lead minutes: ${g?.king_change_lead_minutes ?? 10}`,
      `• King role: ${g?.king_role_id ? `<@&${g.king_role_id}>` : '—'}`
    ];

    return interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }
};