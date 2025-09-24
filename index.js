const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
require("dotenv").config();

const LOG_GUILD_ID = "1336555551970164839";
const LOG_CHANNEL_ID = "1412517818867384482";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.GuildMember, Partials.User],
});

const { db, admin } = require("./firebase");
require("./music")(client);
require("./server");
require("./welcome")(client);
require("./goodbye")(client);
require("./ticket")(client);
require("./addticket")(client);
require("./group")(client);
require("./room")(client);
require("./delete")(client);
require("./em")(client);
require("./verify")(client);
require("./invite")(client);
require("./private")(client);
require("./help")(client);
require("./sound")(client);
require("./fix")(client);
require("./move")(client);

/* ---------- global safety ---------- */
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

/* ---------- helpers ---------- */
function buildReportEmbed() {
  const list = client.guilds.cache
    .map((g) => `**• ${g.name} | ${g.memberCount ?? "?"}**`)
    .join("\n")
    .slice(0, 3800);

  return new EmbedBuilder()
    .setTitle("Bot2x Tester")
    .setDescription(list || "ไม่มีเซิร์ฟเวอร์")
    .addFields({ name: "All Server", value: `**${client.guilds.cache.size}**`, inline: true })
    .setColor(0x7c3aed)
    .setTimestamp();
}

/** Embed แผงควบคุมของกิลด์ */
function buildGuildPanelEmbed(guild) {
  const me = guild.members.me;
  const joinedTs = me?.joinedTimestamp ? Math.floor(me.joinedTimestamp / 1000) : null;
  return new EmbedBuilder()
    .setTitle(`แผงควบคุม: ${guild.name}`)
    .setDescription("เลือกการทำงานจากปุ่มด้านล่าง หรือเลือกรับยศจากเมนู")
    .addFields(
      { name: "Guild", value: `${guild.name} \`(${guild.id})\``, inline: false },
      { name: "Members", value: `${guild.memberCount ?? "—"}`, inline: true },
      { name: "Bot Highest Role", value: `${me?.roles?.highest ?? "—"} (pos ${me?.roles?.highest?.position ?? "?"})`, inline: true },
      { name: "Bot joined at", value: joinedTs ? `<t:${joinedTs}:F> (<t:${joinedTs}:R>)` : "—", inline: false },
    )
    .setThumbnail(guild.iconURL({ size: 256 }) || client.user.displayAvatarURL({ size: 256 }))
    .setColor(0x7c3aed)
    .setTimestamp();
}

/** ปุ่มการทำงานของกิลด์ (ไม่มีปุ่มให้ยศแล้ว) */
function buildGuildActionRow(guildId) {
  const makeInvite = new ButtonBuilder()
    .setCustomId(`inv_make_invite:${guildId}`)
    .setLabel("สร้างลิงก์ถาวร")
    .setStyle(ButtonStyle.Success);

  const botInfo = new ButtonBuilder()
    .setCustomId(`inv_bot_info:${guildId}`)
    .setLabel("ข้อมูลบอท")
    .setStyle(ButtonStyle.Secondary);

  const leaveGuild = new ButtonBuilder()
    .setCustomId(`inv_leave_guild:${guildId}`)
    .setLabel("ให้ออกจากเซิร์ฟเวอร์นี้")
    .setStyle(ButtonStyle.Danger);

  return new ActionRowBuilder().addComponents(makeInvite, botInfo, leaveGuild);
}

/** เมนูเลือกยศที่บอทจัดการได้ (สูงสุด 25 รายการ) */
function buildRoleSelectRow(guild) {
  const me = guild.members.me;
  const rolesArr = [...guild.roles.cache.values()]
    .filter((r) => r.id !== guild.id && !r.managed && r.editable) // ไม่เอา @everyone/managed และต้อง editable
    .sort((a, b) => b.position - a.position)
    .slice(0, 25);

  if (rolesArr.length === 0) return null;

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`inv_pick_role:${guild.id}`)
    .setPlaceholder("เลือกยศเพื่อรับ")
    .addOptions(
      rolesArr.map((r) => ({
        label: r.name.slice(0, 100),
        value: r.id,
        description: `pos ${r.position}`.slice(0, 100),
      }))
    );

  return new ActionRowBuilder().addComponents(menu);
}

/** แถวปุ่มยืนยันออกจากเซิร์ฟเวอร์ */
function buildConfirmLeaveRow(guildId) {
  const yes = new ButtonBuilder()
    .setCustomId(`inv_leave_yes:${guildId}`)
    .setLabel("ยืนยันออก")
    .setStyle(ButtonStyle.Danger);

  const no = new ButtonBuilder()
    .setCustomId(`inv_leave_no:${guildId}`)
    .setLabel("ยกเลิก")
    .setStyle(ButtonStyle.Secondary);

  return new ActionRowBuilder().addComponents(yes, no);
}

/** เลือกช่องที่เหมาะสมสำหรับสร้าง invite ในกิลด์นั้น */
function findInviteChannel(guild) {
  const me = guild.members.me;
  const canInvite = (ch) =>
    ch?.isTextBased?.() &&
    ch.viewable &&
    me?.permissionsIn(ch)?.has(PermissionsBitField.Flags.CreateInstantInvite);

  if (guild.systemChannel && canInvite(guild.systemChannel)) return guild.systemChannel;
  return guild.channels.cache.find((ch) => ch.type === ChannelType.GuildText && canInvite(ch)) || null;
}

/** อัปเดต/สร้าง log เดียว แล้วจำ messageId ไว้ใน Firestore พร้อมใส่ Select Menu */
async function upsertLogMessage() {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const ref = db.collection("botLog").doc("presenceReport");
    const snap = await ref.get();
    const embed = buildReportEmbed();
    const components = [buildGuildSelectRow()];

    if (snap.exists && snap.data()?.messageId) {
      const msg = await channel.messages.fetch(snap.data().messageId).catch(() => null);
      if (msg) { await msg.edit({ embeds: [embed], components }); return; }
    }

    const sent = await channel.send({ embeds: [embed], components });
    await ref.set(
      {
        guildId: LOG_GUILD_ID,
        channelId: LOG_CHANNEL_ID,
        messageId: sent.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  } catch (e) {
    console.error("upsertLogMessage error:", e);
  }
}

/** editReply แบบปลอดภัย */
async function safeEditReply(interaction, data) {
  try { return await interaction.editReply(data); }
  catch (e1) {
    try { return await interaction.followUp({ ...data, ephemeral: true }); }
    catch (e2) { console.error("safeEditReply error:", e1?.message || e1, e2?.message || e2); }
  }
}

/* ---------- events ---------- */
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await upsertLogMessage();
});

client.on(Events.GuildCreate, async () => { await upsertLogMessage(); });
client.on(Events.GuildDelete, async () => { await upsertLogMessage(); });

/** เมนู/ปุ่ม/เมนูยศ */
client.on(Events.InteractionCreate, async (interaction) => {
  // ===== เลือกกิลด์จากเมนูหลัก =====
  if (interaction.isStringSelectMenu() && interaction.customId === "pick_guild_invite") {
    const guildId = interaction.values?.[0];
    const targetGuild = client.guilds.cache.get(guildId);
    if (!targetGuild) {
      return interaction.reply({ content: "❌ ไม่พบเซิร์ฟเวอร์เป้าหมาย", ephemeral: true });
    }
    const embed = buildGuildPanelEmbed(targetGuild);
    const buttons = buildGuildActionRow(guildId);
    const roleRow = buildRoleSelectRow(targetGuild);
    const components = roleRow ? [buttons, roleRow] : [buttons];
    return interaction.reply({ embeds: [embed], components, ephemeral: true });
  }

  // ===== เลือกยศ → ให้ยศทันที =====
  if (interaction.isStringSelectMenu() && interaction.customId.startsWith("inv_pick_role:")) {
    const guildId = interaction.customId.split(":")[1];
    const roleId = interaction.values?.[0];
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      return interaction.reply({ content: "❌ ไม่พบเซิร์ฟเวอร์เป้าหมาย", ephemeral: true });
    }

    const me = guild.members.me;
    if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return interaction.reply({ content: "❌ บอทไม่มีสิทธิ์ Manage Roles ในเซิร์ฟเวอร์นี้", ephemeral: true });
    }

    const role = await guild.roles.fetch(roleId).catch(() => null);
    if (!role || !role.editable || role.managed || role.id === guild.id) {
      return interaction.reply({ content: "❌ ยศนี้ไม่สามารถมอบได้", ephemeral: true });
    }

    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      return interaction.reply({ content: "❌ คุณไม่ได้เป็นสมาชิกของเซิร์ฟเวอร์นี้", ephemeral: true });
    }

    if (me.roles.highest.comparePositionTo(member.roles.highest) <= 0) {
      return interaction.reply({ content: "❌ ลำดับยศของคุณสูงกว่าหรือเท่ากับบอท", ephemeral: true });
    }

    if (member.roles.cache.has(role.id)) {
      const embed = new EmbedBuilder()
        .setTitle("คุณมียศนี้อยู่แล้ว")
        .setDescription(`${role} อยู่ในรายชื่อยศของคุณแล้ว`)
        .setColor(0xf59e0b)
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    try {
      await member.roles.add(role, `Self pick via panel: ${interaction.user.tag}`);
      const embed = new EmbedBuilder()
        .setTitle("มอบยศสำเร็จ")
        .setDescription(`ได้รับยศ ${role} ใน **${guild.name}** แล้ว`)
        .setColor(0x22c55e)
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (e) {
      console.error("grant role error:", e);
      return interaction.reply({ content: "❌ มอบยศไม่สำเร็จ (ตรวจสิทธิ์/ลำดับยศ)", ephemeral: true });
    }
  }

  if (!interaction.isButton()) return;

  // ========== ปุ่ม: สร้างลิงก์ถาวร ==========
  if (interaction.customId.startsWith("inv_make_invite:")) {
    await interaction.deferUpdate().catch(() => {});
    const guildId = interaction.customId.split(":")[1];
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return safeEditReply(interaction, { content: "❌ ไม่พบเซิร์ฟเวอร์เป้าหมาย", components: [] });

    const ch = findInviteChannel(guild);
    if (!ch) {
      const embed = new EmbedBuilder()
        .setTitle("สร้างลิงก์เชิญไม่สำเร็จ")
        .setDescription(`บอทต้องมีสิทธิ์ **Create Invite** ใน **${guild.name}**`)
        .setColor(0xef4444);
      const components = [buildGuildActionRow(guildId)];
      const roleRow = buildRoleSelectRow(guild);
      if (roleRow) components.push(roleRow);
      return safeEditReply(interaction, { embeds: [embed], components });
    }

    try {
      const invite = await ch.createInvite({ maxAge: 0, maxUses: 0, unique: true });
      const url = invite.url ?? `https://discord.gg/${invite.code}`;
      const embed = new EmbedBuilder()
        .setTitle("ลิงก์เชิญถาวร")
        .setDescription(`[กดดิวะ](${url})`)
        .setColor(0x10b981)
        .setTimestamp();
      const components = [buildGuildActionRow(guildId)];
      const roleRow = buildRoleSelectRow(guild);
      if (roleRow) components.push(roleRow);
      return safeEditReply(interaction, { embeds: [embed], components });
    } catch (e) {
      console.error("createInvite error:", e);
      const embed = new EmbedBuilder()
        .setTitle("สร้างลิงก์เชิญไม่สำเร็จ")
        .setDescription(`ตรวจสอบสิทธิ์ **Create Invite** ใน **${guild.name}**`)
        .setColor(0xef4444);
      const components = [buildGuildActionRow(guildId)];
      const roleRow = buildRoleSelectRow(guild);
      if (roleRow) components.push(roleRow);
      return safeEditReply(interaction, { embeds: [embed], components });
    }
  }

  // ========== ปุ่ม: ข้อมูลบอท ==========
  if (interaction.customId.startsWith("inv_bot_info:")) {
    await interaction.deferUpdate().catch(() => {});
    const guildId = interaction.customId.split(":")[1];
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return safeEditReply(interaction, { content: "❌ ไม่พบเซิร์ฟเวอร์เป้าหมาย", components: [] });

    let me = guild.members.me || (await guild.members.fetch(client.user.id).catch(() => null));
    if (!me) return safeEditReply(interaction, { content: "❌ ไม่พบข้อมูลบอทในเซิร์ฟเวอร์นี้", components: [] });

    const roles = me.roles.cache.filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
    const topRoles = roles.first(5).map((r) => `${r} (${r.position})`).join(", ") || "—";
    const joinedTs = me.joinedTimestamp ? Math.floor(me.joinedTimestamp / 1000) : null;
    const createdTs = client.user.createdTimestamp ? Math.floor(client.user.createdTimestamp / 1000) : null;
    const check = (flag) => (me.permissions.has(flag) ? "✅" : "❌");
    const permsSummary = [
      `${check(PermissionsBitField.Flags.Administrator)} Administrator`,
      `${check(PermissionsBitField.Flags.ManageGuild)} Manage Guild`,
      `${check(PermissionsBitField.Flags.ManageRoles)} Manage Roles`,
      `${check(PermissionsBitField.Flags.ManageChannels)} Manage Channels`,
      `${check(PermissionsBitField.Flags.ViewAuditLog)} View Audit Log`,
      `${check(PermissionsBitField.Flags.CreateInstantInvite)} Create Invite`,
    ].join(" • ");

    const embed = new EmbedBuilder()
      .setTitle(`ข้อมูลบอทใน ${guild.name}`)
      .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
      .setColor(me.roles.highest?.color || 0x7c3aed)
      .addFields(
        { name: "Display Name", value: me.displayName || "—", inline: true },
        { name: "เข้าร่วม", value: joinedTs ? `<t:${joinedTs}:F> (<t:${joinedTs}:R>)` : "—", inline: false },
        { name: "Highest Role", value: `${me.roles.highest ?? "—"} (pos ${me.roles.highest?.position ?? "?"})`, inline: false },
        { name: "จำนวนยศ", value: `${roles.size}`, inline: true },
        { name: "ยศบนสุด", value: topRoles, inline: false },
        { name: "สิทธิ์หลัก", value: permsSummary, inline: false },
      )
      .setFooter({ text: `Guild ID: ${guild.id}` })
      .setTimestamp();

    const components = [buildGuildActionRow(guildId)];
    const roleRow = buildRoleSelectRow(guild);
    if (roleRow) components.push(roleRow);

    return safeEditReply(interaction, { embeds: [embed], components });
  }

  // ========== ปุ่ม: ขอออกจากกิลด์ ==========
  if (interaction.customId.startsWith("inv_leave_guild:")) {
    await interaction.deferUpdate().catch(() => {});
    const guildId = interaction.customId.split(":")[1];
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return safeEditReply(interaction, { content: "❌ ไม่พบเซิร์ฟเวอร์เป้าหมาย", components: [] });

    const embed = new EmbedBuilder()
      .setTitle("ยืนยันการออกจากเซิร์ฟเวอร์")
      .setDescription(`**ต้องการให้บอทออกจาก ${guild.name} ป่าว**`)
      .setColor(0xf59e0b);

    const row = buildConfirmLeaveRow(guildId);
    return safeEditReply(interaction, { embeds: [embed], components: [row] });
  }

  // ========== ปุ่ม: ยกเลิกออกจากกิลด์ ==========
  if (interaction.customId.startsWith("inv_leave_no:")) {
    await interaction.deferUpdate().catch(() => {});
    const guildId = interaction.customId.split(":")[1];
    const guild = client.guilds.cache.get(guildId);
    const embed = guild ? buildGuildPanelEmbed(guild) : new EmbedBuilder().setTitle("เลือกเซิร์ฟเวอร์ใหม่").setColor(0x7c3aed);
    const buttons = buildGuildActionRow(guildId);
    const roleRow = guild ? buildRoleSelectRow(guild) : null;
    const components = roleRow ? [buttons, roleRow] : [buttons];
    return safeEditReply(interaction, { embeds: [embed], components });
  }

  // ========== ปุ่ม: ยืนยันออกจากกิลด์ ==========
  if (interaction.customId.startsWith("inv_leave_yes:")) {
    await interaction.deferUpdate().catch(() => {});
    const guildId = interaction.customId.split(":")[1];
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return safeEditReply(interaction, { content: "❌ ไม่พบเซิร์ฟเวอร์เป้าหมาย", components: [] });

    try {
      await guild.leave();
      await upsertLogMessage();
      const embed = new EmbedBuilder()
        .setTitle("ออกจากเซิร์ฟเวอร์แล้ว")
        .setDescription(`บอทได้ออกจาก **${guild.name}** เรียบร้อย`)
        .setColor(0x22c55e);
      return safeEditReply(interaction, { embeds: [embed], components: [] });
    } catch (e) {
      console.error("leave guild error:", e);
      const embed = new EmbedBuilder()
        .setTitle("ออกจากเซิร์ฟเวอร์ไม่สำเร็จ")
        .setDescription(`ไม่สามารถออกจาก **${guild.name}** ได้`)
        .setColor(0xef4444);
      return safeEditReply(interaction, { embeds: [embed], components: [] });
    }
  }
});

client.login(process.env.token);
