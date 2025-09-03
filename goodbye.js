// goodbye.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  PermissionsBitField,
} = require("discord.js");
const { db, admin } = require("./firebase");

module.exports = (client) => {
  const DEFAULT_COLOR_INT = 0xef4444; // #ef4444

  // ===== Utils =====
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

  function isAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
  }

  // ===== 1) ลงทะเบียน /goodbye (เฉพาะแอดมินเท่านั้น) =====
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("goodbye")
          .setDescription("ตั้งค่าข้อความลา (สั่งในห้องที่จะให้แสดง)")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) // ✅ limit at registry
          .toJSON()
      );
      console.log("✅ Registered /goodbye command");
    } catch (e) {
      console.error("❌ Register /goodbye failed:", e);
    }
  });

  // ===== 2) /goodbye → เปิด Modal (ตรวจแอดมินซ้ำ) =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "goodbye") return;

    if (!isAdmin(interaction)) {
      return interaction.reply({ content: "❌ คำสั่งนี้สำหรับแอดมินเท่านั้น", ephemeral: true });
    }

    const modal = new ModalBuilder().setCustomId("goodbye_modal").setTitle("ตั้งค่า Goodbye Embed");

    const titleInput = new TextInputBuilder()
      .setCustomId("goodbye_title")
      .setLabel("Title (หัวข้อ)")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(256);

    const descInput = new TextInputBuilder()
      .setCustomId("goodbye_desc")
      .setLabel("Description (รองรับ @user และ @server)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);

    const imageInput = new TextInputBuilder()
      .setCustomId("goodbye_image")
      .setLabel("Image URL (ใส่หรือเว้นว่างได้)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(400);

    const colorInput = new TextInputBuilder()
      .setCustomId("goodbye_color")
      .setLabel("สีของ Embed (ไม่บังคับ)") // ≤ 45 chars
      .setPlaceholder("เช่น #ef4444, #fff, 0xffffff")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(16);

    modal.addComponents(
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(descInput),
      new ActionRowBuilder().addComponents(imageInput),
      new ActionRowBuilder().addComponents(colorInput)
    );

    await interaction.showModal(modal);
  });

  // ===== 3) บันทึกค่าจาก Modal (ตรวจแอดมินซ้ำ) =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId !== "goodbye_modal") return;

    if (!isAdmin(interaction)) {
      return interaction.reply({ content: "❌ คำสั่งนี้สำหรับแอดมินเท่านั้น", ephemeral: true });
    }

    const guild = interaction.guild;
    const channel = interaction.channel;

    const title = interaction.fields.getTextInputValue("goodbye_title").trim();
    const desc = interaction.fields.getTextInputValue("goodbye_desc").trim();
    const imageUrl = (interaction.fields.getTextInputValue("goodbye_image") || "").trim();
    const colorRaw = (interaction.fields.getTextInputValue("goodbye_color") || "").trim();

    const parsedColor = parseHexColorToInt(colorRaw);
    const colorInt = parsedColor ?? DEFAULT_COLOR_INT;
    const colorNote = colorRaw && parsedColor === null ? " (ค่าสีไม่ถูกต้อง ใช้สีเริ่มต้นแทน)" : "";

    await db.collection("goodbyeChannels").doc(guild.id).set({
      channelId: channel.id,
      title,
      description: desc,
      imageUrl: imageUrl || null,
      colorInt, // เก็บเป็น int
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    await interaction.reply({
      content:
        `✅ ตั้งค่า Goodbye เรียบร้อย${colorNote}\n` +
        `• Channel: <#${channel.id}>\n` +
        `• Title: \`${title}\`\n` +
        `• Image: ${imageUrl ? imageUrl : "—"}\n` +
        `• Color: ${colorRaw ? `\`${colorRaw}\`` : "`#ef4444` (default)"}`,
      ephemeral: true,
    });
  });

  // ===== 4) ส่งข้อความลาเมื่อมีคนออก =====
  client.on(Events.GuildMemberRemove, async (member) => {
    try {
      const doc = await db.collection("goodbyeChannels").doc(member.guild.id).get();
      if (!doc.exists) return;

      const data = doc.data();
      const channel = member.guild.channels.cache.get(data.channelId);
      if (!channel || !channel.isTextBased()) return;

      let desc = data.description || "";
      desc = desc.replaceAll("@user", `<@${member.id}>`);
      desc = desc.replaceAll("@server", `**${member.guild.name}**`);

      const colorInt =
        typeof data.colorInt === "number" ? data.colorInt : DEFAULT_COLOR_INT;

      const embed = new EmbedBuilder()
        .setTitle(data.title || "Goodbye")
        .setDescription(desc)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setColor(colorInt)
        .setFooter({ text: "Make by Purple Shop" })
        .setTimestamp();

      if (data.imageUrl && /^https?:\/\//i.test(data.imageUrl)) {
        embed.setImage(data.imageUrl);
      }

      await channel.send({ embeds: [embed] });
    } catch (e) {
      console.error("❌ error sending goodbye:", e);
    }
  });
};
