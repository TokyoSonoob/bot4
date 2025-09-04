// index.js
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  PermissionsBitField,
  ChannelType,
} = require("discord.js");
require("dotenv").config();

const LOG_GUILD_ID = "1336555551970164839";
const LOG_CHANNEL_ID = "1412517818867384482";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildInvites
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
require("./create")(client);
require("./room")(client);
require("./delete")(client);
require("./em")(client);
require("./verify")(client);
require("./invite")(client);
require("./private")(client);
require("./help")(client);
require("./sound")(client);
require("./fix")(client);
/* ---------- helpers ---------- */
function buildReportEmbed() {
  const list = client.guilds.cache
    .map(g => `**• ${g.name} | ${g.memberCount ?? "?"}**`)
    .join("\n")
    .slice(0, 3800);

  return new EmbedBuilder()
    .setTitle("Bot2x Tester")
    .setDescription(list || "ไม่มีเซิร์ฟเวอร์")
    .addFields({ name: "All Server", value: `**${client.guilds.cache.size}**`, inline: true })
    .setColor(0x7c3aed)
    .setTimestamp();
}

/** สร้าง Select Menu รายชื่อเซิร์ฟเวอร์ (สูงสุด 25 รายการตามข้อจำกัด Discord) */
function buildGuildSelectRow() {
  const options = client.guilds.cache
    .map(g => ({
      label: g.name.slice(0, 100),
      value: g.id, // ใช้ guildId เป็น value
      description: `ID: ${g.id}`.slice(0, 100),
    }))
    .slice(0, 25); // จำกัด 25

  const menu = new StringSelectMenuBuilder()
    .setCustomId("pick_guild_invite")
    .setPlaceholder("เลือกเซิร์ฟเวอร์")
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

/** เลือกช่องที่เหมาะสมสำหรับสร้าง invite ในกิลด์นั้น */
function findInviteChannel(guild) {
  // 1) systemChannel ถ้ามีและบอทมีสิทธิ์
  const me = guild.members.me;
  const canInvite = (ch) =>
    ch?.isTextBased?.() &&
    ch.viewable &&
    me?.permissionsIn(ch)?.has(PermissionsBitField.Flags.CreateInstantInvite);

  if (guild.systemChannel && canInvite(guild.systemChannel)) return guild.systemChannel;

  // 2) หาช่องข้อความใด ๆ ที่บอทมีสิทธิ์
  const candidate = guild.channels.cache.find(
    (ch) =>
      ch.type === ChannelType.GuildText &&
      canInvite(ch)
  );
  return candidate || null;
}

/** อัปเดต/สร้าง log เดียว แล้วจำ messageId ไว้ใน Firestore พร้อมใส่ Select Menu */
async function upsertLogMessage() {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const ref = db.collection("botLog").doc("presenceReport"); // เอกสารเดียว
    const snap = await ref.get();
    const embed = buildReportEmbed();
    const components = [buildGuildSelectRow()];

    // ถ้ามี messageId -> แก้ข้อความเดิม
    if (snap.exists && snap.data()?.messageId) {
      const messageId = snap.data().messageId;
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) {
        await msg.edit({ embeds: [embed], components });
        console.log("📝 Updated existing log message");
        return;
      }
    }

    // ไม่พบข้อความเดิม -> ส่งใหม่แล้วบันทึก messageId
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
    console.log("✅ Created new log message and stored messageId");
  } catch (e) {
    console.error("upsertLogMessage error:", e);
  }
}

/* ---------- events ---------- */
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  await upsertLogMessage();
});

// ถ้าบอทถูกเชิญเข้า/ลบออก -> อัปเดตรายงาน + เมนู
client.on(Events.GuildCreate, async () => { await upsertLogMessage(); });
client.on(Events.GuildDelete, async () => { await upsertLogMessage(); });

/** จัดการเลือกเซิร์ฟเวอร์จากเมนูเพื่อสร้าง invite */
/** จัดการเลือกเซิร์ฟเวอร์จากเมนูเพื่อสร้าง invite */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isStringSelectMenu()) return;
  if (interaction.customId !== "pick_guild_invite") return;

  const guildId = interaction.values?.[0];
  const targetGuild = client.guilds.cache.get(guildId);
  if (!targetGuild) {
    return interaction.reply({ content: "❌ ไม่พบเซิร์ฟเวอร์เป้าหมาย", ephemeral: true });
  }

  const ch = findInviteChannel(targetGuild);
  if (!ch) {
    return interaction.reply({
      content: `❌ ไม่พบช่องที่สร้างลิงก์เชิญได้ใน **${targetGuild.name}** (ต้องให้บอทมีสิทธิ์ Create Invite)`,
      ephemeral: true,
    });
  }

  try {
    // อายุ 1 วัน ใช้ได้ไม่จำกัดครั้ง
    const invite = await ch.createInvite({ maxAge: 86400, maxUses: 0, unique: true });
    const url = invite.url ?? `https://discord.gg/${invite.code}`;

    await interaction.reply({
      content: `**${targetGuild.name}**: ${url}`,
      ephemeral: true, // ✅ เห็นคนเดียว
    });
  } catch (e) {
    console.error("createInvite error:", e);
    await interaction.reply({
      content: `❌ สร้างลิงก์เชิญไม่สำเร็จใน **${targetGuild.name}** (ตรวจสิทธิ์ Create Invite)`,
      ephemeral: true,
    });
  }
});


client.login(process.env.token);
