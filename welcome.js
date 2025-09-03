// welcome.js
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
const admin = require("firebase-admin");
const db = admin.firestore();

module.exports = (client) => {
  const DEFAULT_COLOR_INT = 0x9b59b6; // #9b59b6

  // แปลงรหัสสีเป็น int (รองรับ #fff, #ffffff, 0xrrggbb)
  function parseHexColorToInt(input) {
    if (!input) return null;
    let s = String(input).trim().toLowerCase();
    if (s.startsWith("0x")) s = s.slice(2);
    if (s.startsWith("#")) s = s.slice(1);
    if (s.length === 3 && /^[0-9a-f]{3}$/i.test(s)) {
      s = s.split("").map((ch) => ch + ch).join(""); // fff -> ffffff
    }
    if (s.length !== 6 || !/^[0-9a-f]{6}$/i.test(s)) return null;
    return parseInt(s, 16);
  }

  const isAdmin = (interaction) =>
    interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);

  // ---------- 1) ลงทะเบียน Slash Command /welcome (เฉพาะแอดมิน) ----------
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("welcome")
          .setDescription("ตั้งค่าข้อความต้อนรับ (ตั้งในห้องที่จะให้แสดง)")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) // ✅ แอดมินเท่านั้น
          .toJSON()
      );
      console.log("✅ Registered /welcome command");
    } catch (err) {
      console.error("❌ Register /welcome failed:", err);
    }
  });

  // ---------- 2) เปิดโมดัลเมื่อใช้ /welcome ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName !== "welcome") return;

      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน",
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId("welcome_modal")
        .setTitle("ตั้งค่า Welcome Embed");

      const titleInput = new TextInputBuilder()
        .setCustomId("welcome_title")
        .setLabel("Title (หัวข้อ)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(256);

      const descInput = new TextInputBuilder()
        .setCustomId("welcome_desc")
        .setLabel("Description (รองรับ @user และ @server)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000);

      const imageInput = new TextInputBuilder()
        .setCustomId("welcome_image")
        .setLabel("Image URL (ใส่หรือเว้นว่างได้)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(400);

      const colorInput = new TextInputBuilder()
        .setCustomId("welcome_color")
        .setLabel("สีของ Embed (ไม่บังคับ)") // ≤ 45 ตัวอักษร
        .setPlaceholder("เช่น #9b59b6, #fff, 0xffffff")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(16);

      modal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(descInput),
        new ActionRowBuilder().addComponents(imageInput),
        new ActionRowBuilder().addComponents(colorInput),
      );

      await interaction.showModal(modal);
    } catch (e) {
      console.error("❌ open /welcome modal error:", e);
      if (interaction.isRepliable())
        interaction.reply({ content: "เกิดข้อผิดพลาด", ephemeral: true }).catch(() => {});
    }
  });

  // ---------- 3) รับค่าจากโมดัลแล้วบันทึก Firestore ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (!interaction.isModalSubmit()) return;
      if (interaction.customId !== "welcome_modal") return;

      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน",
          ephemeral: true,
        });
      }

      const guild = interaction.guild;
      const channel = interaction.channel;

      const title = interaction.fields.getTextInputValue("welcome_title").trim();
      const description = interaction.fields.getTextInputValue("welcome_desc").trim();
      const imageUrl = (interaction.fields.getTextInputValue("welcome_image") || "").trim();
      const colorRaw = (interaction.fields.getTextInputValue("welcome_color") || "").trim();

      const parsedColor = parseHexColorToInt(colorRaw);
      const colorInt = parsedColor ?? DEFAULT_COLOR_INT;
      const colorNote = colorRaw && parsedColor === null ? " (ค่าสีไม่ถูกต้อง ใช้สีเริ่มต้นแทน)" : "";

      await db.collection("welcomeChannelsx").doc(guild.id).set({
        channelId: channel.id,
        title,
        description,
        imageUrl: imageUrl || null,
        colorInt, // บันทึกสีเป็น int
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });

      await interaction.reply({
        content:
          `✅ ตั้งค่า Welcome เรียบร้อย${colorNote}\n` +
          `• Channel: <#${channel.id}>\n` +
          `• Title: \`${title}\`\n` +
          `• Image: ${imageUrl ? imageUrl : "—"}\n` +
          `• Color: ${colorRaw ? `\`${colorRaw}\`` : "`#9b59b6` (default)"}`,
        ephemeral: true,
      });
    } catch (e) {
      console.error("❌ save welcome template error:", e);
      if (interaction.isRepliable())
        interaction.reply({ content: "❌ เกิดข้อผิดพลาด กรุณาลองใหม่", ephemeral: true }).catch(() => {});
    }
  });

  // ---------- 4) ส่งข้อความต้อนรับเมื่อมีคนเข้า ----------
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const doc = await db.collection("welcomeChannelsx").doc(member.guild.id).get();
      if (!doc.exists) return;

      const data = doc.data();
      const channel = member.guild.channels.cache.get(data.channelId);
      if (!channel || !channel.isTextBased()) return;

      // แทนที่ @user และ @server ใน description
      const safe = (s) => (typeof s === "string" ? s : "");
      let desc = safe(data.description);
      desc = desc.replaceAll("@user", `<@${member.id}>`);
      desc = desc.replaceAll("@server", `**${member.guild.name}**`);

      const colorInt = typeof data.colorInt === "number" ? data.colorInt : DEFAULT_COLOR_INT;

      const embed = new EmbedBuilder()
        .setTitle(safe(data.title) || "Welcome")
        .setDescription(desc)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setColor(colorInt)
        .setFooter({ text: "Make by Purple Shop" })
        .setTimestamp();

      if (data.imageUrl && /^https?:\/\/.+/i.test(data.imageUrl)) {
        embed.setImage(data.imageUrl);
      }

      await channel.send({ embeds: [embed] });
    } catch (e) {
      console.error("❌ เกิดข้อผิดพลาดในการส่งข้อความต้อนรับ:", e);
    }
  });
};
