// room.js
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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

/** helper: ตรวจว่าเป็นแอดมิน */
function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

module.exports = (client) => {
  const MAX_CREATE = 25;
  const IDS = {
    PICK: "room_pick_category",
    MODAL_PREFIX: "room_name_modal",
    INPUT_NAMES: "room_channel_names",
  };

  // 1) ลงทะเบียน /room (เฉพาะแอดมิน)
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("room")
          .setDescription("เลือกหมวดหมู่")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
          .toJSON()
      );
      console.log("✅ Registered /room");
    } catch (e) {
      console.error("❌ Register /room failed:", e);
    }
  });

  // 2) /room → โชว์เมนูเลือก Category
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "room") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน" });
    }
    const me = interaction.guild?.members?.me;
    if (!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
      return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ Manage Channels" });
    }

    const categories = [...interaction.guild.channels.cache.values()]
      .filter((c) => c.type === ChannelType.GuildCategory)
      .sort((a, b) => a.rawPosition - b.rawPosition);

    if (categories.length === 0) {
      return safeReply(interaction, { content: "**เซิร์ฟเวอร์นี้ยังไม่มีหมวดหมู่เลย ไปสร้างก่อนไป๊**" });
    }

    const limited = categories.slice(0, 25);
    const select = new StringSelectMenuBuilder()
      .setCustomId(IDS.PICK)
      .setPlaceholder("เลือกหมวดหมู่")
      .addOptions(limited.map((c) => ({ label: c.name.slice(0, 100), value: c.id })));

    const row = new ActionRowBuilder().addComponents(select);
    await safeReply(interaction, {
      content:
        categories.length > 25
          ? `กรุณาเลือกหมวดหมู่ (แสดงสูงสุด 25 จากทั้งหมด ${categories.length})`
          : "กรุณาเลือกหมวดหมู่",
      components: [row],
    });
  });

  // 3) เลือก Category → เปิด Modal กรอกชื่อห้อง
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== IDS.PICK) return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน" });
    }
    const me = interaction.guild?.members?.me;
    if (!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
      return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ Manage Channels" });
    }

    const categoryId = interaction.values?.[0];
    const category = interaction.guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      return safeReply(interaction, { content: "❌ หมวดหมู่ไม่ถูกต้องหรือไม่พบ" });
    }

    const modal = new ModalBuilder()
      .setCustomId(`${IDS.MODAL_PREFIX}:${category.id}`)
      .setTitle(`สร้างห้องใน: ${category.name.slice(0, 30)}`);

    const namesInput = new TextInputBuilder()
      .setCustomId(IDS.INPUT_NAMES)
      .setLabel("ชื่อห้อง (ขึ้นบรรทัดใหม่แยกแต่ละห้อง)")
      .setPlaceholder("ตัวอย่าง :\nห้องกินข้าว\nห้องน้ำ\nปลาเค็ม\nเริ่มหิวละ")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(2000);

    modal.addComponents(new ActionRowBuilder().addComponents(namesInput));
    await interaction.showModal(modal);
  });

  // 4) Modal Submit → สร้างห้อง (Text) ใต้ Category (อนุญาตชื่อซ้ำ)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (!interaction.customId.startsWith(IDS.MODAL_PREFIX + ":")) return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน" });
    }
    const me = interaction.guild?.members?.me;
    if (!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
      return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ Manage Channels" });
    }

    await interaction.deferReply({ ephemeral: true });

    const [, categoryId] = interaction.customId.split(":");
    const category = interaction.guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      return interaction.editReply({ content: "❌ หมวดหมู่ไม่ถูกต้องหรือไม่พบ" });
    }

    const raw = interaction.fields.getTextInputValue(IDS.INPUT_NAMES) || "";
    // ถ้ามีขึ้นบรรทัดใหม่ → ใช้บรรทัดเป็นตัวคั่น; ถ้าไม่มี → คั่นด้วยช่องว่าง
    const parts = raw.includes("\n") ? raw.split(/\r?\n/) : raw.split(/\s+/);

    let names = parts.map((s) => s.trim()).filter(Boolean).slice(0, MAX_CREATE);

    if (names.length === 0) {
      return interaction.editReply({ content: "**กรุณาระบุชื่ออย่างน้อย 1 ชื่อ**" });
    }

    const results = [];
    for (const nameRaw of names) {
      const name = nameRaw.slice(0, 100);
      try {
        const created = await interaction.guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: category.id,
          reason: `Created by ${interaction.user.tag} in ${category.name}`,
        });
        results.push(`• ✅ **${created.name}**`);
      } catch (e) {
        console.error("create text channel error:", e);
        results.push(`• ❌ ล้มเหลว: **${name}**`);
      }
    }

    const summary = [
      `**หมวดหมู่ : ${category.name}**`,
      `**สร้างห้อง : ${results.filter((r) => r.includes("")).length}/${names.length} สำเร็จ**`,
      ...results,
    ]
      .join("\n")
      .slice(0, 1900);

    await interaction.editReply({ content: summary || "ไม่มีผลลัพธ์" });
  });
};
