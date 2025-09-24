// group.js
const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  Events,
  ChannelType,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");
async function safeReply(interaction, options) {
  const payload = { ...options };
  try {
    if (payload.ephemeral) delete payload.ephemeral;
    payload.flags = MessageFlags.Ephemeral;
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp(payload);
    }
    return interaction.reply(payload);
  } catch (e) {
    try {
      const alt = { ...options, ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        return interaction.followUp(alt);
      }
      return interaction.reply(alt);
    } catch (_) {
      console.error("safeReply error:", e);
    }
  }
}

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

module.exports = (client) => {
  const MAX_CREATE = 25;
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("group")
          .setDescription("สร้างหมวดหมู่")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
          .toJSON()
      );
      console.log("✅ Registered /group");
    } catch (e) {
      console.error("❌ Register /group failed:", e);
    }
  });

  // 2) /group -> เปิด Modal
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "group") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const me = interaction.guild?.members?.me;
    if (!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
      return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ Manage Channels", ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId("create_category_modal_multi")
      .setTitle("สร้างหมวดหมู่");

    const namesInput = new TextInputBuilder()
      .setCustomId("category_names")
      .setLabel("ชื่อหมวดหมู่ (ขึ้นบรรทัดใหม่แยกแต่ละอัน)")
      .setPlaceholder("ตัวอย่าง :\nห้องกินข้าว\nห้องน้ำ\nปลาเค็ม\nเริ่มหิวละ")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(2000);

    modal.addComponents(new ActionRowBuilder().addComponents(namesInput));
    await interaction.showModal(modal);
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId !== "create_category_modal_multi") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const me = interaction.guild?.members?.me;
    if (!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
      return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ Manage Channels", ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const raw = interaction.fields.getTextInputValue("category_names") || "";
    const parts = raw.includes("\n")
      ? raw.split(/\r?\n/)
      : raw.split(/\s+/);

    let names = parts
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, MAX_CREATE);

    if (names.length === 0) {
      return interaction.editReply({ content: "**กรุณาระบุชื่ออย่างน้อย 1 ชื่อ**" });
    }

    const results = [];
    for (const nameRaw of names) {
      const name = nameRaw.slice(0, 100);
      try {
        const created = await interaction.guild.channels.create({
          name,
          type: ChannelType.GuildCategory,
          reason: `Created by ${interaction.user.tag}`,
        });
        results.push(`**✅ สร้างแล้ว: ${created.name}**`);
      } catch (e) {
        console.error("create category error:", e);
        results.push(`**❌ ล้มเหลว: ${name}**`);
      }
    }

    const summary = [
      `**สรุปการสร้างหมวดหมู่ : ${results.filter((r) => r.includes("✅")).length}/${names.length} สำเร็จ**`,
      ...results,
    ]
      .join("\n")
      .slice(0, 1900);

    await interaction.editReply({ content: summary || "ไม่มีผลลัพธ์" });
  });
};
