// ticket.js
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField,
  ChannelType,
  Events,
  MessageFlags,
} = require("discord.js");
const { db, admin } = require("./firebase");

/** ใช้ตอบ ephemeral โดยไม่โดน warning; fallback ถ้า flags ใช้ไม่ได้ */
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

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

module.exports = (client) => {
  // ===== 1) ลงทะเบียน /ticket (เฉพาะแอดมิน) =====
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("ticket")
          .setDescription("สร้างชุดตั๋ว (สองหน้า) และโพสต์ปุ่มเปิดห้อง")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) // ✅ แอดมินเท่านั้น
          .toJSON()
      );
      console.log("✅ Registered /ticket");
    } catch (e) {
      console.error("❌ Register /ticket failed:", e);
    }
  });

  // ===== 2) เปิด Modal หน้า 1 =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "ticket") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const modal1 = new ModalBuilder()
      .setCustomId("ticket_modal_page1")
      .setTitle("ตั้งค่า Ticket — หน้า 1"); // <= ไม่เกิน 45 ตัว

    const in_title = new TextInputBuilder()
      .setCustomId("p1_title")
      .setLabel("Title")
      .setPlaceholder("หัวข้อจะแสดงในโพสต์ปุ่ม")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const in_desc = new TextInputBuilder()
      .setCustomId("p1_desc")
      .setLabel("Description")
      .setPlaceholder("รายละเอียดจะแสดงในโพสต์ปุ่ม")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const in_url = new TextInputBuilder()
      .setCustomId("p1_url")
      .setLabel("Image URL")
      .setPlaceholder("ลิงก์รูปภาพ (ตัวเลือก)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(200);

    const in_btn = new TextInputBuilder()
      .setCustomId("p1_button_label")
      .setLabel("ชื่อปุ่ม")
      .setPlaceholder("เช่น เปิดตั๋ว")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80);

    const in_cat = new TextInputBuilder()
      .setCustomId("p1_category_id")
      .setLabel("ID หมวดหมู่")
      .setPlaceholder("เช่น 1375026841114509332")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(30);

    modal1.addComponents(
      new ActionRowBuilder().addComponents(in_title),
      new ActionRowBuilder().addComponents(in_desc),
      new ActionRowBuilder().addComponents(in_url),
      new ActionRowBuilder().addComponents(in_btn),
      new ActionRowBuilder().addComponents(in_cat)
    );

    await interaction.showModal(modal1);
  });

  // ===== 3) รับผล Modal หน้า 1 → ตอบกลับด้วยปุ่มเปิดหน้า 2 =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId !== "ticket_modal_page1") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const guild = interaction.guild;
    const channel = interaction.channel;
    const userId = interaction.user.id;

    const p1 = {
      title: interaction.fields.getTextInputValue("p1_title").trim(),
      description: interaction.fields.getTextInputValue("p1_desc").trim(),
      url: (interaction.fields.getTextInputValue("p1_url") || "").trim(),
      buttonLabel: interaction.fields.getTextInputValue("p1_button_label").trim(),
      categoryId: interaction.fields.getTextInputValue("p1_category_id").trim(),
    };

    // เก็บสถานะ wizard ชั่วคราว
    const sessionId = `${guild.id}_${userId}_${Date.now()}`;
    await db.collection("ticket_wizard").doc(sessionId).set({
      guildId: guild.id,
      channelId: channel.id,
      userId,
      page1: p1,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const openPage2 = new ButtonBuilder()
      .setCustomId(`ticket_open_page2:${sessionId}`)
      .setLabel("กรอกหน้า 2")
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(openPage2);

    await safeReply(interaction, {
      content: "✅ บันทึกหน้า 1 แล้ว — กดปุ่มเพื่อกรอกหน้า 2",
      components: [row],
      ephemeral: true,
    });
  });

  // ===== 4) เปิด Modal หน้า 2 จากปุ่ม =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    const [key, sessionId] = interaction.customId.split(":");
    if (key !== "ticket_open_page2") return;

    // ต้องเป็นแอดมิน และเป็นเจ้าของเซสชัน
    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ เฉพาะแอดมินเท่านั้น", ephemeral: true });
    }

    const snap = await db.collection("ticket_wizard").doc(sessionId).get();
    if (!snap.exists) {
      return safeReply(interaction, { content: "❌ เซสชันหมดอายุ หรือไม่พบข้อมูลหน้า 1", ephemeral: true });
    }
    const wiz = snap.data();
    if (wiz.userId !== interaction.user.id) {
      return safeReply(interaction, { content: "❌ คุณไม่ได้เริ่มเซสชันนี้", ephemeral: true });
    }

    const modal2 = new ModalBuilder()
      .setCustomId(`ticket_modal_page2:${sessionId}`)
      .setTitle("ตั้งค่า Ticket — หน้า 2"); // <= ไม่เกิน 45 ตัว

    const in_title = new TextInputBuilder()
      .setCustomId("p2_title")
      .setLabel("Title")
      .setPlaceholder("หัวข้อที่จะส่งในห้องใหม่")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const in_desc = new TextInputBuilder()
      .setCustomId("p2_desc")
      .setLabel("Description")
      .setPlaceholder("รายละเอียดที่จะส่งในห้องใหม่")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const in_url = new TextInputBuilder()
      .setCustomId("p2_url")
      .setLabel("Image URL")
      .setPlaceholder("ลิงก์รูปภาพ (ตัวเลือก)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(200);

    const in_room = new TextInputBuilder()
      .setCustomId("p2_room_name")
      .setLabel("ชื่อห้อง (คำนำหน้า)")
      .setPlaceholder("บอทจะต่อท้ายเป็น {count} เช่น ตั๋ว-")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(50);

    modal2.addComponents(
      new ActionRowBuilder().addComponents(in_title),
      new ActionRowBuilder().addComponents(in_desc),
      new ActionRowBuilder().addComponents(in_url),
      new ActionRowBuilder().addComponents(in_room)
    );

    await interaction.showModal(modal2);
  });

  // ===== 5) รับผล Modal หน้า 2 → สร้าง "ชุดตั๋ว" และโพสต์ปุ่ม =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (!interaction.customId.startsWith("ticket_modal_page2:")) return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const sessionId = interaction.customId.split(":")[1];
    const snap = await db.collection("ticket_wizard").doc(sessionId).get();
    if (!snap.exists) {
      return safeReply(interaction, { content: "❌ เซสชันหมดอายุ หรือไม่พบข้อมูลหน้า 1", ephemeral: true });
    }
    const wizard = snap.data();
    if (wizard.userId !== interaction.user.id) {
      return safeReply(interaction, { content: "❌ คุณไม่ได้เริ่มเซสชันนี้", ephemeral: true });
    }

    const guild = interaction.guild;
    const postChannel = interaction.channel;

    const p1 = wizard.page1;
    const p2 = {
      title: interaction.fields.getTextInputValue("p2_title").trim(),
      description: interaction.fields.getTextInputValue("p2_desc").trim(),
      url: (interaction.fields.getTextInputValue("p2_url") || "").trim(),
      roomNamePrefix: interaction.fields.getTextInputValue("p2_room_name").trim(),
    };

    // Embed โพสต์ชุดตั๋ว (หน้า 1)
    const hostEmbed = new EmbedBuilder()
      .setTitle(p1.title)
      .setDescription(p1.description)
      .setColor(0x7c3aed)
      .setFooter({ text: "Make by Purple Shop" })
      .setTimestamp();
    if (p1.url && /^https?:\/\//i.test(p1.url)) hostEmbed.setImage(p1.url);

    // บันทึก config ใหม่: ticket_configs/<guildId>/configs/<autoId>
    const cfgRef = db.collection("ticket_configs").doc(guild.id).collection("configs").doc();
    const configId = cfgRef.id;

    const openBtn = new ButtonBuilder()
      .setCustomId(`ticket_open:${configId}`)
      .setLabel(p1.buttonLabel || "เปิดตั๋ว")
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(openBtn);

    const hostMsg = await postChannel.send({ embeds: [hostEmbed], components: [row] });

    // เซฟ config + เริ่มตัวนับที่ 0 (เก็บ page1.title เป็น fallback ให้ /addticket)
    await cfgRef.set({
      guildId: guild.id,
      postChannelId: postChannel.id,
      hostMessageId: hostMsg.id,
      categoryId: p1.categoryId,
      page1: {
        title: p1.title,
        description: p1.description,
        url: p1.url,
        buttonLabel: p1.buttonLabel,
      },
      page2: p2,
      count: 0, // เริ่ม 0 แล้วค่อย +1 ตอนกดปุ่ม
      createdBy: interaction.user.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ล้าง wizard ชั่วคราว (option)
    await db.collection("ticket_wizard").doc(sessionId).delete().catch(() => {});

    await safeReply(interaction, { content: "✅ สร้างชุดตั๋วสำเร็จ และโพสต์ปุ่มแล้ว", ephemeral: true });
  });

  // ===== 6) คลิกปุ่ม "เปิดตั๋ว" → สร้างห้อง + ส่งหน้า 2 + นับ increment =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("ticket_open:")) return;

    const configId = interaction.customId.split(":")[1];
    const guild = interaction.guild;

    const cfgRef = db.collection("ticket_configs").doc(guild.id).collection("configs").doc(configId);
    const snap = await cfgRef.get();
    if (!snap.exists) {
      return safeReply(interaction, { content: "❌ ไม่พบชุดตั๋วนี้แล้ว", ephemeral: true });
    }
    const cfg = snap.data();

    // ตรวจสิทธิ์บอท
    try {
      const me = guild.members.me;
      if (!me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ Manage Channels", ephemeral: true });
      }
    } catch {}

    // เพิ่มตัวนับ
    await cfgRef.update({
      count: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const latest = await cfgRef.get();
    const count = latest.data().count;

    // ตั้งชื่อห้อง
    const roomName = `${cfg.page2.roomNamePrefix}${count}`;

    // สร้างห้อง
    const parentId = cfg.categoryId;
    const created = await guild.channels.create({
      name: roomName,
      type: ChannelType.GuildText,
      parent: parentId || undefined,
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          deny: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.EmbedLinks,
          ],
        },
        {
          id: guild.members.me.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.EmbedLinks,
            PermissionsBitField.Flags.AttachFiles,
          ],
        },
      ],
    });

    // Embed หน้า 2
    const e2 = new EmbedBuilder()
      .setTitle(cfg.page2.title)
      .setDescription(cfg.page2.description)
      .setColor(0x7c3aed)
      .setFooter({ text: `Make by Purple Shop • Ticket #${count}` })
      .setTimestamp();
    if (cfg.page2.url && /^https?:\/\//i.test(cfg.page2.url)) e2.setImage(cfg.page2.url);

    // ปุ่มปิดห้อง
    const closeBtn = new ButtonBuilder()
      .setCustomId(`ticket_close:${configId}:${count}:${interaction.user.id}`)
      .setLabel("ปิดห้อง")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(closeBtn);

    await created.send({
      content: `<@${interaction.user.id}>`,
      embeds: [e2],
      components: [row],
    });

    await safeReply(interaction, { content: `✅ เปิดห้อง **${roomName}** เรียบร้อย`, ephemeral: true });
  });

  // ===== 7) คลิกปุ่ม "ปิดห้อง" =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith("ticket_close:")) return;

    const parts = interaction.customId.split(":");
    // รูปแบบ: ticket_close:<configId>:<count>:<openerId>
    const configId  = parts[1];
    const count     = parts[2];
    const openerId  = parts[3]; // อาจเป็น undefined ถ้าใช้ปุ่มรุ่นเก่า

    const channel = interaction.channel;
    const guild   = interaction.guild;

    // เช็คสิทธิ์ผู้กด:
    // - คนเปิดห้อง (openerId) หรือ
    // - ผู้มี ManageChannels
    const member = interaction.member;
    const isOpener = openerId && interaction.user.id === openerId;
    const canManage = member?.permissions?.has(PermissionsBitField.Flags.ManageChannels);

    if (!isOpener && !canManage) {
      return safeReply(interaction, { content: "❌ คุณไม่มีสิทธิ์ปิดห้องนี้", ephemeral: true });
    }

    // เช็คสิทธิ์บอทก่อนลบ
    const me = guild.members.me;
    if (!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
      return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ Manage Channels เพื่อลบห้องนี้", ephemeral: true });
    }

    // ตอบยืนยันแบบ ephemeral ก่อนลบ
    await safeReply(interaction, { content: "ลบห้อง...", ephemeral: true });

    try {
      if (!channel?.deletable) {
        return channel?.send?.("⚠️ ไม่สามารถลบห้องนี้ได้ (สิทธิ์ไม่พอหรือเป็นระบบ)")?.catch(() => {});
      }
      await channel.delete(`Ticket closed by ${interaction.user.tag} (config ${configId} #${count})`);
    } catch (e) {
      console.error("Error closing ticket:", e);
      try {
        await channel?.send?.("❌ ลบห้องไม่สำเร็จ กรุณาตรวจสอบสิทธิ์บอท (Manage Channels)")?.catch(() => {});
      } catch {}
    }
  });

  // ===== 8) เปิดตั๋วผ่าน "เมนูเลื่อนเลือก" (รองรับโพสต์ที่ถูก /fix แปลงเป็น select) =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== "ticket_open_select") return;

    // ป้องกัน timeout
    if (!interaction.deferred && !interaction.replied) {
      try { await interaction.deferReply({ ephemeral: true }); } catch {}
    }

    const value = interaction.values?.[0];
    if (!value) {
      return interaction.editReply({ content: "❌ ไม่ได้เลือกประเภท" });
    }

    // value ควรเป็น "ticket_open:<configId>" หรือ "<configId>"
    const customId = value.startsWith("ticket_open:") ? value : `ticket_open:${value}`;
    const configId = customId.split(":")[1];
    const guild = interaction.guild;

    const cfgRef = db.collection("ticket_configs").doc(guild.id).collection("configs").doc(configId);
    const snap = await cfgRef.get();
    if (!snap.exists) {
      return interaction.editReply({ content: "❌ ไม่พบชุดตั๋วนี้แล้ว" });
    }
    const cfg = snap.data();

    // ตรวจสิทธิ์บอท
    try {
      const me = guild.members.me;
      if (!me.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
        return interaction.editReply({ content: "❌ บอทไม่มีสิทธิ์ Manage Channels" });
      }
    } catch {}

    // เพิ่มตัวนับ
    await cfgRef.update({
      count: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const latest = await cfgRef.get();
    const count = latest.data().count;

    const roomName = `${cfg.page2.roomNamePrefix}${count}`;
    const parentId = cfg.categoryId;

    // สร้างห้อง
    const created = await guild.channels.create({
      name: roomName,
      type: ChannelType.GuildText,
      parent: parentId || undefined,
      permissionOverwrites: [
        {
          id: guild.roles.everyone,
          deny: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
          ],
        },
        {
          id: interaction.user.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.AttachFiles,
            PermissionsBitField.Flags.EmbedLinks,
          ],
        },
        {
          id: guild.members.me.id,
          allow: [
            PermissionsBitField.Flags.ViewChannel,
            PermissionsBitField.Flags.SendMessages,
            PermissionsBitField.Flags.ReadMessageHistory,
            PermissionsBitField.Flags.ManageChannels,
            PermissionsBitField.Flags.EmbedLinks,
            PermissionsBitField.Flags.AttachFiles,
          ],
        },
      ],
    });

    // Embed หน้า 2
    const e2 = new EmbedBuilder()
      .setTitle(cfg.page2.title)
      .setDescription(cfg.page2.description)
      .setColor(0x7c3aed)
      .setFooter({ text: `Make by Purple Shop • Ticket #${count}` })
      .setTimestamp();
    if (cfg.page2.url && /^https?:\/\//i.test(cfg.page2.url)) e2.setImage(cfg.page2.url);

    // ปุ่มปิดห้อง
    const closeBtn = new ButtonBuilder()
      .setCustomId(`ticket_close:${configId}:${count}:${interaction.user.id}`)
      .setLabel("ปิดห้อง")
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder().addComponents(closeBtn);

    await created.send({
      content: `<@${interaction.user.id}>`,
      embeds: [e2],
      components: [row],
    });

    return interaction.editReply({ content: `✅ เปิดห้อง **${roomName}** เรียบร้อย` });
  });
};
