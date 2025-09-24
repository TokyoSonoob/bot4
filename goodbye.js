const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  PermissionsBitField,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const admin = require("firebase-admin");
const db = admin.firestore();

module.exports = (client) => {
  const DEFAULT_COLOR_INT = 0xef4444;

  function parseHexColorToInt(input) {
    if (!input) return null;
    let s = String(input).trim().toLowerCase();
    if (s.startsWith("0x")) s = s.slice(2);
    if (s.startsWith("#")) s = s.slice(1);
    if (s.length === 3 && /^[0-9a-f]{3}$/i.test(s)) s = s.split("").map((ch) => ch + ch).join("");
    if (s.length !== 6 || !/^[0-9a-f]{6}$/i.test(s)) return null;
    return parseInt(s, 16);
  }

  const isAdmin = (interaction) =>
    interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);

  // ลงทะเบียน /goodbye (เฉพาะแอดมิน)
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("goodbye")
          .setDescription("ตั้งค่าข้อความลาก่อนน้าาาา")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
          .toJSON()
      );
      console.log("✅ Registered /goodbye command");
    } catch (err) {
      console.error("❌ Register /goodbye failed:", err);
    }
  });

  // /goodbye → เปิดโมดัลตั้งค่า
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "goodbye") return;

    if (!isAdmin(interaction)) {
      return interaction.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const modal = new ModalBuilder().setCustomId("goodbye_modal").setTitle("ตั้งค่า Goodbye");

    const msgInput = new TextInputBuilder()
      .setCustomId("goodbye_message")
      .setLabel("ข้อความ (@user, @server)")
      .setPlaceholder("จะส่งข้อความนี้ก่อน Embed")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(200);

    const titleInput = new TextInputBuilder()
      .setCustomId("goodbye_title")
      .setLabel("หัวข้อ")
      .setPlaceholder("หัวข้อของ Embed")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(256);

    const descInput = new TextInputBuilder()
      .setCustomId("goodbye_desc")
      .setLabel("รายละเอียด (@user, @server)")
      .setPlaceholder("@user แทนผู้ที่ออกจากเซิร์ฟเวอร์\n@server แทนชื่อเซิร์ฟเวอร์")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);

    const imageInput = new TextInputBuilder()
      .setCustomId("goodbye_image")
      .setLabel("ลิงก์รูปภาพ (ไม่บังคับ)")
      .setPlaceholder("ตรงนี้จะวางเป็นลิ้งค์ จากGoogle หรือ ดิส")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(400);

    const colorInput = new TextInputBuilder()
      .setCustomId("goodbye_color")
      .setLabel("สีของ Embed")
      .setPlaceholder("เช่น #ef4444")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(16);

    modal.addComponents(
      new ActionRowBuilder().addComponents(msgInput),
      new ActionRowBuilder().addComponents(titleInput),
      new ActionRowBuilder().addComponents(descInput),
      new ActionRowBuilder().addComponents(imageInput),
      new ActionRowBuilder().addComponents(colorInput),
    );

    await interaction.showModal(modal);
  });

  // รับโมดัล → บันทึกค่า → ตอบกลับปุ่ม "ทดสอบ"
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId !== "goodbye_modal") return;

    if (!isAdmin(interaction)) {
      return interaction.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const guild = interaction.guild;
    const channel = interaction.channel;

    const message = (interaction.fields.getTextInputValue("goodbye_message") || "").trim();
    const title = interaction.fields.getTextInputValue("goodbye_title").trim();
    const description = interaction.fields.getTextInputValue("goodbye_desc").trim();
    const imageUrl = (interaction.fields.getTextInputValue("goodbye_image") || "").trim();
    const colorRaw = (interaction.fields.getTextInputValue("goodbye_color") || "").trim();

    const parsedColor = parseHexColorToInt(colorRaw);
    const colorInt = parsedColor ?? DEFAULT_COLOR_INT;

    await db.collection("goodbyeChannelsx").doc(guild.id).set({
      channelId: channel.id,
      message: message || null,
      title,
      description,
      imageUrl: imageUrl || null,
      colorInt,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    const testBtn = new ButtonBuilder()
      .setCustomId(`goodbye_test:${guild.id}`)
      .setStyle(ButtonStyle.Primary)
      .setLabel("ทดสอบ");

    await interaction.reply({
      content: "✅ ตั้งค่า Goodbye เรียบร้อยแล้ววว",
      components: [new ActionRowBuilder().addComponents(testBtn)],
      ephemeral: true,
    });
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("goodbye_test:")) return;

    if (!isAdmin(interaction)) {
      return interaction.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const guildId = interaction.customId.split(":")[1];
    const doc = await db.collection("goodbyeChannelsx").doc(guildId).get();
    if (!doc.exists) {
      return interaction.reply({ content: "❌ ยังไม่ได้ตั้งค่า Goodbye", ephemeral: true });
    }

    const data = doc.data();

    const replaceVars = (txt, userId, guildName) =>
      (txt || "")
        .replaceAll("@user", `<@${userId}>`)
        .replaceAll("@server", `**${guildName}**`);

    const msg = replaceVars(data.message, interaction.user.id, interaction.guild.name);
    const desc = replaceVars(data.description, interaction.user.id, interaction.guild.name);

    const colorInt = typeof data.colorInt === "number" ? data.colorInt : DEFAULT_COLOR_INT;

    const embed = new EmbedBuilder()
      .setTitle(data.title || "Goodbye")
      .setDescription(desc)
      .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
      .setColor(colorInt)
      .setFooter({ text: "Make by Purple Shop" })
      .setTimestamp();

    if (data.imageUrl && /^https?:\/\/.+/i.test(data.imageUrl)) embed.setImage(data.imageUrl);

    return interaction.reply({ content: msg || null, embeds: [embed], ephemeral: true });
  });

  // ส่งจริงเมื่อมีสมาชิกออกจากเซิร์ฟเวอร์
  client.on(Events.GuildMemberRemove, async (member) => {
    const doc = await db.collection("goodbyeChannelsx").doc(member.guild.id).get();
    if (!doc.exists) return;
    const data = doc.data();
    const channel = member.guild.channels.cache.get(data.channelId);
    if (!channel?.isTextBased()) return;

    const replaceVars = (txt, userId, guildName) =>
      (txt || "")
        .replaceAll("@user", `<@${userId}>`)
        .replaceAll("@server", `**${guildName}**`);

    const msg = replaceVars(data.message, member.id, member.guild.name);
    const desc = replaceVars(data.description, member.id, member.guild.name);

    const colorInt = typeof data.colorInt === "number" ? data.colorInt : DEFAULT_COLOR_INT;

    const embed = new EmbedBuilder()
      .setTitle(data.title || "Goodbye")
      .setDescription(desc)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .setColor(colorInt)
      .setFooter({ text: "Make by Purple Shop" })
      .setTimestamp();

    if (data.imageUrl && /^https?:\/\/.+/i.test(data.imageUrl)) embed.setImage(data.imageUrl);

    await channel.send({ content: msg || null, embeds: [embed] });
  });
};
