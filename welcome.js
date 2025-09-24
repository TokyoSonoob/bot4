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
  const DEFAULT_COLOR_INT = 0x9b59b6;

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

  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("welcome")
          .setDescription("ตั้งค่าข้อความต้อนรับ")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
          .toJSON()
      );
      console.log("✅ Registered /welcome command");
    } catch (err) {
      console.error("❌ Register /welcome failed:", err);
    }
  });

  // /welcome → เปิด modal
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "welcome") return;

    if (!isAdmin(interaction)) {
      return interaction.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId("welcome_modal")
      .setTitle("ตั้งค่า Welcome");

    const msgInput = new TextInputBuilder()
      .setCustomId("welcome_message")
      .setLabel("ข้อความ")
      .setPlaceholder("จะส่งข้อความไปพร้อมกับ embed")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(200);

    const titleInput = new TextInputBuilder()
      .setCustomId("welcome_title")
      .setLabel("Title")
      .setPlaceholder("จะเป็นหัวข้อของembed")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(256);

    const descInput = new TextInputBuilder()
      .setCustomId("welcome_desc")
      .setLabel("Description (@user , @server)")
      .setPlaceholder("@user ใช้แทนในส่วนของคนที่เข้ามา\n@server ใช้แทนชื่อของเซิฟเวอร์ดิสคอร์ส")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);

    const imageInput = new TextInputBuilder()
      .setCustomId("welcome_image")
      .setLabel("Image (เว้นว่างได้)")
      .setPlaceholder("ตรงนี้จะวางเป็นลิ้งค์ จากGoogle หรือ ดิส")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(400);

    const colorInput = new TextInputBuilder()
      .setCustomId("welcome_color")
      .setLabel("สีของ Embed")
      .setPlaceholder("เช่น #9b59b6")
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

  // บันทึกค่า
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId !== "welcome_modal") return;
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const guild = interaction.guild;
    const channel = interaction.channel;

    const message = (interaction.fields.getTextInputValue("welcome_message") || "").trim();
    const title = interaction.fields.getTextInputValue("welcome_title").trim();
    const description = interaction.fields.getTextInputValue("welcome_desc").trim();
    const imageUrl = (interaction.fields.getTextInputValue("welcome_image") || "").trim();
    const colorRaw = (interaction.fields.getTextInputValue("welcome_color") || "").trim();

    const parsedColor = parseHexColorToInt(colorRaw);
    const colorInt = parsedColor ?? DEFAULT_COLOR_INT;

    await db.collection("welcomeChannelsx").doc(guild.id).set({
      channelId: channel.id,
      message: message || null,
      title,
      description,
      imageUrl: imageUrl || null,
      colorInt,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
    });

    const testBtn = new ButtonBuilder()
      .setCustomId(`welcome_test:${guild.id}`)
      .setStyle(ButtonStyle.Primary)
      .setLabel("ทดสอบ");

    await interaction.reply({
      content: "✅ ตั้งค่า Welcome เรียบร้อยแล้วววว",
      components: [new ActionRowBuilder().addComponents(testBtn)],
      ephemeral: true,
    });
  });
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("welcome_test:")) return;
    if (!isAdmin(interaction)) {
      return interaction.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const guildId = interaction.customId.split(":")[1];
    const doc = await db.collection("welcomeChannelsx").doc(guildId).get();
    if (!doc.exists) return interaction.reply({ content: "ยังไม่ได้ตั้งค่า Welcome", ephemeral: true });

    const data = doc.data();
    const safe = (s) => (typeof s === "string" ? s : "");
    const replaceVars = (txt, userId, guildName) =>
      (txt || "")
        .replaceAll("@user", `<@${userId}>`)
        .replaceAll("@server", `**${guildName}**`);

    const desc = replaceVars(data.description, interaction.user.id, interaction.guild.name);
    const msg = replaceVars(data.message, interaction.user.id, interaction.guild.name);

    const colorInt = typeof data.colorInt === "number" ? data.colorInt : DEFAULT_COLOR_INT;

    const embed = new EmbedBuilder()
      .setTitle(safe(data.title) || "Welcome")
      .setDescription(desc)
      .setThumbnail(interaction.user.displayAvatarURL({ dynamic: true }))
      .setColor(colorInt)
      .setFooter({ text: "Make by Purple Shop" })
      .setTimestamp();

    if (data.imageUrl && /^https?:\/\/.+/i.test(data.imageUrl)) embed.setImage(data.imageUrl);

    return interaction.reply({ content: msg || null, embeds: [embed], ephemeral: true });
  });

  // ส่งจริงเมื่อมีสมาชิกใหม่
  client.on(Events.GuildMemberAdd, async (member) => {
    const doc = await db.collection("welcomeChannelsx").doc(member.guild.id).get();
    if (!doc.exists) return;
    const data = doc.data();
    const channel = member.guild.channels.cache.get(data.channelId);
    if (!channel?.isTextBased()) return;

    const replaceVars = (txt, userId, guildName) =>
      (txt || "")
        .replaceAll("@user", `<@${userId}>`)
        .replaceAll("@server", `**${guildName}**`);

    const desc = replaceVars(data.description, member.id, member.guild.name);
    const msg = replaceVars(data.message, member.id, member.guild.name);

    const colorInt = typeof data.colorInt === "number" ? data.colorInt : DEFAULT_COLOR_INT;

    const embed = new EmbedBuilder()
      .setTitle(data.title || "Welcome")
      .setDescription(desc)
      .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
      .setColor(colorInt)
      .setFooter({ text: "Make by Purple Shop" })
      .setTimestamp();

    if (data.imageUrl && /^https?:\/\/.+/i.test(data.imageUrl)) embed.setImage(data.imageUrl);

    await channel.send({ content: msg || null, embeds: [embed] });
  });
};
