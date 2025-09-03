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

/** ตอบแบบ ephemeral โดยใช้ flags (ปิด warning) พร้อม fallback */
async function safeReply(interaction, options) {
  const payload = { ...options };
  try {
    if (payload.ephemeral) delete payload.ephemeral; // ใช้ flags แทน
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

/** helper: ตรวจว่าเป็นแอดมิน */
function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

module.exports = (client) => {
  const MAX_CREATE = 25;

  // 1) ลงทะเบียน /group
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("group")
          .setDescription("สร้างหมวดหมู่ (Category) หลายรายการด้วยการคั่นด้วย space/newline")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) // ✅ เฉพาะแอดมิน
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
      .setTitle("สร้างหมวดหมู่ (หลายชื่อ)");

    const namesInput = new TextInputBuilder()
      .setCustomId("category_names")
      .setLabel("ชื่อหมวดหมู่ (คั่นด้วย space/newline)")
      .setPlaceholder("ตัวอย่าง:\nหมู่1\nหมู่2\nหมู่3\nหรือ: หมู่1 หมู่2 หมู่3")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);

    modal.addComponents(new ActionRowBuilder().addComponents(namesInput));
    await interaction.showModal(modal);
  });

  // 3) รับผล Modal -> แยกชื่อ -> สร้าง Category
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

    await interaction.deferReply({ ephemeral: true }); // กัน timeout

    const raw = interaction.fields.getTextInputValue("category_names") || "";
    let names = raw
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (names.length === 0) {
      return interaction.editReply({ content: "⚠️ กรุณาระบุชื่ออย่างน้อย 1 ชื่อ" });
    }

    // unique + จำกัดจำนวน
    const seen = new Set();
    names = names
      .filter((n) => {
        const k = n.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, MAX_CREATE);

    // ตรวจซ้ำกับที่มีอยู่แล้ว
    const existingMap = new Map();
    for (const c of interaction.guild.channels.cache.values()) {
      if (c.type === ChannelType.GuildCategory) {
        existingMap.set(c.name.toLowerCase(), c.id);
      }
    }

    const results = [];
    for (const nameRaw of names) {
      const name = nameRaw.slice(0, 100); // Discord จำกัด 100 ตัว
      const existsId = existingMap.get(name.toLowerCase());
      if (existsId) {
        results.push(`• มีอยู่แล้ว: **${name}** \`(${existsId})\``);
        continue;
      }

      try {
        const created = await interaction.guild.channels.create({
          name,
          type: ChannelType.GuildCategory,
          reason: `Created by ${interaction.user.tag}`,
        });
        results.push(`• ✅ สร้างแล้ว: **${created.name}**`);
        existingMap.set(created.name.toLowerCase(), created.id);
      } catch (e) {
        console.error("create category error:", e);
        results.push(`• ❌ ล้มเหลว: **${name}** (สิทธิ์ไม่พอหรือชื่อไม่ถูกต้อง)`);
      }
    }

    const summary = [
      `สรุปการสร้างหมวดหมู่: **${results.filter((r) => r.includes("✅")).length}/${names.length}** สำเร็จ`,
      ...results,
    ]
      .join("\n")
      .slice(0, 1900);

    await interaction.editReply({ content: summary || "ไม่มีผลลัพธ์" });
  });
};
