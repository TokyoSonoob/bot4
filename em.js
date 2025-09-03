// em.js
const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  Events,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");

module.exports = (client) => {
  const IDS = {
    MODAL: "em_modal",
    INPUT_TITLE: "em_title",
    INPUT_DESC: "em_desc",
    INPUT_URL: "em_url",
    INPUT_COLOR: "em_color",
  };

  const DEFAULT_COLOR_INT = 0x9b59b6; // #9b59b6

  // helper: parse hex color into int (supports #fff, #ffffff, 0xrrggbb)
  function parseHexColorToInt(input) {
    if (!input) return null;
    let s = String(input).trim().toLowerCase();

    if (s.startsWith("0x")) s = s.slice(2);
    if (s.startsWith("#")) s = s.slice(1);

    if (s.length === 3 && /^[0-9a-f]{3}$/i.test(s)) {
      s = s.split("").map((ch) => ch + ch).join("");
    }

    if (s.length !== 6 || !/^[0-9a-f]{6}$/i.test(s)) return null;
    return parseInt(s, 16);
  }

  /** helper: แอดมินไหม */
  function isAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
  }

  /** ตอบแบบ ephemeral ด้วย flags + fallback */
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

  // 1) ลงทะเบียน /em (เฉพาะแอดมินเท่านั้น)
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("em")
          .setDescription("เปิดฟอร์มส่ง Embed (title/description/URL รูปภาพ/สี)")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) // ✅ limit at registry
          .toJSON()
      );
      console.log("✅ Registered /em");
    } catch (e) {
      console.error("❌ Register /em failed:", e);
    }
  });

  // 2) /em → เปิด Modal (ตรวจแอดมินซ้ำ)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "em") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมินเท่านั้น", ephemeral: true });
    }

    const me = interaction.guild?.members?.me;
    if (!me?.permissions?.has(PermissionsBitField.Flags.SendMessages)) {
      return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ส่งข้อความในห้องนี้", ephemeral: true });
    }

    const modal = new ModalBuilder().setCustomId(IDS.MODAL).setTitle("สร้าง Embed (/em)");

    const iTitle = new TextInputBuilder()
      .setCustomId(IDS.INPUT_TITLE)
      .setLabel("Title (ไม่บังคับ)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(256);

    const iDesc = new TextInputBuilder()
      .setCustomId(IDS.INPUT_DESC)
      .setLabel("Description (ไม่บังคับ)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(4000);

    const iUrl = new TextInputBuilder()
      .setCustomId(IDS.INPUT_URL)
      .setLabel("URL รูปภาพ (ไม่บังคับ)")
      .setPlaceholder("เช่น https://example.com/image.png")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(400);

    const iColor = new TextInputBuilder()
      .setCustomId(IDS.INPUT_COLOR)
      .setLabel("สีของ Embed (ไม่บังคับ)")
      .setPlaceholder("เช่น #9b59b6, #fff, 0xffffff")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(16);

    modal.addComponents(
      new ActionRowBuilder().addComponents(iTitle),
      new ActionRowBuilder().addComponents(iDesc),
      new ActionRowBuilder().addComponents(iUrl),
      new ActionRowBuilder().addComponents(iColor)
    );

    await interaction.showModal(modal);
  });

  // 3) รับ Modal → ส่ง Embed (ตรวจแอดมินซ้ำ)
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId !== IDS.MODAL) return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ เฉพาะแอดมินเท่านั้น", ephemeral: true });
    }

    const title = (interaction.fields.getTextInputValue(IDS.INPUT_TITLE) || "").trim();
    const description = (interaction.fields.getTextInputValue(IDS.INPUT_DESC) || "").trim();
    const urlRaw = (interaction.fields.getTextInputValue(IDS.INPUT_URL) || "").trim();
    const colorRaw = (interaction.fields.getTextInputValue(IDS.INPUT_COLOR) || "").trim();

    if (!title && !description && !urlRaw && !colorRaw) {
      return safeReply(interaction, {
        content: "⚠️ โปรดกรอกอย่างน้อย 1 ช่อง (title / description / URL รูปภาพ / สี)",
        ephemeral: true,
      });
    }

    let colorInt = DEFAULT_COLOR_INT;
    let note = "";

    if (colorRaw) {
      const parsed = parseHexColorToInt(colorRaw);
      if (parsed !== null) colorInt = parsed;
      else note = "ค่าสีไม่ถูกต้อง จึงใช้สีเริ่มต้นแทน";
    }

    const embed = new EmbedBuilder().setColor(colorInt);
    if (title) embed.setTitle(title);
    if (description) embed.setDescription(description);

    if (urlRaw) {
      try {
        const u = new URL(urlRaw);
        if (u.protocol === "http:" || u.protocol === "https:") {
          embed.setImage(urlRaw);
        } else {
          note ||= "URL รูปภาพไม่ถูกต้อง จึงไม่ได้แสดงรูป";
        }
      } catch (_) {
        note ||= "URL รูปภาพไม่ถูกต้อง จึงไม่ได้แสดงรูป";
      }
    }

    if (note) embed.addFields({ name: "ℹ️ หมายเหตุ", value: note });

    await safeReply(interaction, { content: "✅ ส่ง Embed แล้ว", ephemeral: true });
    await interaction.channel.send({ embeds: [embed] });
  });
};
