// addticket.js
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  Events,
  MessageFlags,
  PermissionsBitField,
} = require("discord.js");
const { db, admin } = require("./firebase");

/** ตอบแบบ ephemeral โดยใช้ flags (ตัด warning) พร้อม fallback */
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

/** helper: ตรวจว่าเป็นแอดมิน (Administrator) ไหม */
function isAdmin(interaction) {
  try {
    return interaction.memberPermissions?.has(
      PermissionsBitField.Flags.Administrator
    );
  } catch {
    return false;
  }
}

module.exports = (client) => {
  // ---------- 1) ลงทะเบียน /addticket (จำกัดเฉพาะ Administrator) ----------
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("addticket")
          .setDescription("เพิ่มปุ่ม ticket ให้ embed เดิม (ไม่แก้ embed หลัก)")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) // ✅ แอดมินเท่านั้น
          .toJSON()
      );
      console.log("✅ Registered /addticket");
    } catch (e) {
      console.error("❌ Register /addticket failed:", e);
    }
  });

  // ---------- 2) /addticket → ให้เลือก embed หลักที่เคยสร้าง ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "addticket") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, {
        content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน (Administrator) เท่านั้น",
        ephemeral: true,
      });
    }

    const guildId = interaction.guild?.id;
    if (!guildId) {
      return safeReply(interaction, {
        content: "❌ ใช้คำสั่งในเซิร์ฟเวอร์เท่านั้น",
        ephemeral: true,
      });
    }

    const colRef = db.collection("ticket_configs").doc(guildId).collection("configs");
    const snap = await colRef.get();

    if (snap.empty) {
      return safeReply(interaction, {
        content: "ℹ️ ยังไม่มี embed ticket — ใช้ /ticket เพื่อสร้างก่อน",
        ephemeral: true,
      });
    }

    // รวม host message แบบไม่ซ้ำ
    const hostMap = new Map(); // key: hostMessageId
    snap.forEach((d) => {
      const data = d.data();
      const key = data.hostMessageId;
      if (!hostMap.has(key)) {
        hostMap.set(key, {
          postChannelId: data.postChannelId,
          hostMessageId: data.hostMessageId,
          title: data.page1?.title || "Ticket Host",
        });
      }
    });

    const options = [];
    for (const v of hostMap.values()) {
      options.push({
        label: `${v.title}`.slice(0, 100),
        description: `#${v.hostMessageId} • ch:${v.postChannelId}`.slice(0, 100),
        value: `${v.postChannelId}:${v.hostMessageId}`,
      });
    }

    const limited = options.slice(0, 25); // select menu จำกัด 25 ตัวเลือก
    const select = new StringSelectMenuBuilder()
      .setCustomId("addticket_pick_host")
      .setPlaceholder("เลือก embed ticket ที่ต้องการเพิ่มปุ่ม")
      .addOptions(limited);

    const row = new ActionRowBuilder().addComponents(select);

    await safeReply(interaction, {
      content: "เลือก embed ticket ที่จะเพิ่มปุ่ม:",
      components: [row],
      ephemeral: true,
    });
  });

  // ---------- 3) เลือก host → เปิด Modal กรอกข้อมูลชุดปุ่มใหม่ ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== "addticket_pick_host") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, {
        content: "❌ เฉพาะแอดมินเท่านั้น",
        ephemeral: true,
      });
    }

    const picked = interaction.values?.[0];
    if (!picked) {
      return safeReply(interaction, { content: "❌ ไม่ได้เลือก embed", ephemeral: true });
    }
    const [postChannelId, hostMessageId] = picked.split(":");

    const modal = new ModalBuilder()
      .setCustomId(`addticket_modal:${postChannelId}:${hostMessageId}`)
      .setTitle("เพิ่มปุ่ม Ticket (ไม่แก้ embed)"); // <= ไม่เกิน ~45 ตัวอักษร

    // ⚠️ ฟอร์มนี้ใช้สำหรับ "ในห้องตั๋ว" เท่านั้น ไม่แก้ embed หลัก
    const in_title = new TextInputBuilder()
      .setCustomId("title")
      .setLabel("Title (ในห้องตั๋ว)")
      .setPlaceholder("หัวข้อที่จะส่งในห้องตั๋วที่สร้าง")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(100);

    const in_desc = new TextInputBuilder()
      .setCustomId("desc")
      .setLabel("Description (ในห้องตั๋ว)")
      .setPlaceholder("รายละเอียดที่จะส่งในห้องตั๋วที่สร้าง")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    const in_room = new TextInputBuilder()
      .setCustomId("room")
      .setLabel("ชื่อห้อง (คำนำหน้า)")
      .setPlaceholder("บอทจะต่อท้ายเป็น {count} เช่น ตั๋ว-")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(50);

    const in_btn = new TextInputBuilder()
      .setCustomId("btn")
      .setLabel("ชื่อปุ่ม")
      .setPlaceholder("เช่น เปิดตั๋ว, ติดต่อทีมงาน")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80);

    const in_cat = new TextInputBuilder()
      .setCustomId("cat")
      .setLabel("ID หมวดหมู่")
      .setPlaceholder("เช่น 1375026841114509332")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(30);

    modal.addComponents(
      new ActionRowBuilder().addComponents(in_title),
      new ActionRowBuilder().addComponents(in_desc),
      new ActionRowBuilder().addComponents(in_room),
      new ActionRowBuilder().addComponents(in_btn),
      new ActionRowBuilder().addComponents(in_cat)
    );

    await interaction.showModal(modal);
  });

  // ---------- 4) Submit Modal → เพิ่มปุ่มเข้า host (ไม่แก้ embed) + สร้าง config ใหม่ ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (!interaction.customId.startsWith("addticket_modal:")) return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, {
        content: "❌ เฉพาะแอดมินเท่านั้น",
        ephemeral: true,
      });
    }

    const [, postChannelId, hostMessageId] = interaction.customId.split(":");
    const guild = interaction.guild;
    const guildId = guild?.id;

    if (!guildId) {
      return safeReply(interaction, {
        content: "❌ ใช้คำสั่งในเซิร์ฟเวอร์เท่านั้น",
        ephemeral: true,
      });
    }

    // ข้อมูลสำหรับ "ในห้องตั๋ว"
    const ticketTitle = interaction.fields.getTextInputValue("title").trim();
    const ticketDesc = interaction.fields.getTextInputValue("desc").trim();
    const roomPref = interaction.fields.getTextInputValue("room").trim();

    // ปุ่ม + หมวดหมู่สำหรับชุดใหม่นี้
    const btnLabel = interaction.fields.getTextInputValue("btn").trim();
    const catId = interaction.fields.getTextInputValue("cat").trim();

    // หา host message เดิม
    const postChannel = await client.channels.fetch(postChannelId).catch(() => null);
    if (!postChannel || !postChannel.isTextBased()) {
      return safeReply(interaction, {
        content: "❌ ไม่พบห้องที่มี embed หลัก",
        ephemeral: true,
      });
    }
    const hostMsg = await postChannel.messages.fetch(hostMessageId).catch(() => null);
    if (!hostMsg) {
      return safeReply(interaction, {
        content: "❌ ไม่พบข้อความ embed หลัก",
        ephemeral: true,
      });
    }

    // ตรวจจำนวนปุ่ม/แถวเดิม
    const existingRows = hostMsg.components || [];
    const totalButtons = existingRows.reduce(
      (acc, row) => acc + (row.components?.length || 0),
      0
    );

    if (totalButtons >= 25) {
      return safeReply(interaction, {
        content: "❌ เพิ่มปุ่มไม่ได้: embed นี้มีปุ่มครบ 25 แล้ว",
        ephemeral: true,
      });
    }

    // สร้าง config ใหม่
    const cfgRef = db
      .collection("ticket_configs")
      .doc(guildId)
      .collection("configs")
      .doc();
    const configId = cfgRef.id;

    // ปุ่มใหม่
    const newButton = new ButtonBuilder()
      .setCustomId(`ticket_open:${configId}`)
      .setLabel(btnLabel || "เปิดตั๋ว")
      .setStyle(ButtonStyle.Primary);

    // สร้าง rows ใหม่ โดย "เพิ่มปุ่มนี้" เข้าไป
    const newRows = [];
    let placed = false;

    // คัดลอกแถวเดิม และพยายามยัดปุ่มใหม่ในแถวสุดท้ายที่ยังไม่ครบ 5 ปุ่ม
    for (const row of existingRows) {
      const cloned = new ActionRowBuilder();
      const comps = [];
      for (const comp of row.components || []) {
        // เฉพาะปุ่มเท่านั้น
        if (comp.data?.type === 2) {
          const b = new ButtonBuilder()
            .setCustomId(comp.data.custom_id)
            .setLabel(comp.data.label ?? "button")
            .setStyle(comp.data.style ?? ButtonStyle.Secondary)
            .setDisabled(!!comp.data.disabled);
          comps.push(b);
        }
      }
      // ถ้ายังไม่วาง และแถวนี้มีปุ่ม < 5 ให้เพิ่มปุ่มใหม่ลงแถวนี้
      if (!placed && comps.length < 5) {
        comps.push(newButton);
        placed = true;
      }
      cloned.addComponents(comps);
      newRows.push(cloned);
    }

    // ถ้ายังวางไม่ได้ (ทุกแถวเต็ม 5 ปุ่ม) และยังไม่ครบ 5 แถว → สร้างแถวใหม่
    if (!placed) {
      if (newRows.length >= 5) {
        return safeReply(interaction, {
          content: "❌ เพิ่มปุ่มไม่ได้: มีครบ 5 แถวแล้ว",
          ephemeral: true,
        });
      }
      newRows.push(new ActionRowBuilder().addComponents(newButton));
    }

    // แก้ไข “เฉพาะ components” ของ host (ไม่แตะ embed หลัก)
    await hostMsg.edit({ components: newRows });

    // บันทึก config สำหรับปุ่มใหม่นี้ (นับเริ่ม 0)
    await cfgRef.set({
      guildId,
      postChannelId,
      hostMessageId,
      categoryId: catId,
      // page1 เก็บเฉพาะปุ่ม (เผื่ออ้างอิง)
      page1: { buttonLabel: btnLabel },
      // page2 = สิ่งที่จะส่งใน "ห้องตั๋ว" ที่เปิดใหม่
      page2: {
        title: ticketTitle,
        description: ticketDesc,
        url: null,
        roomNamePrefix: roomPref,
      },
      count: 0,
      createdBy: interaction.user.id,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await safeReply(interaction, {
      content: "✅ เพิ่มปุ่มใหม่สำเร็จ (embed หลักไม่ถูกแก้ไข)",
      ephemeral: true,
    });
  });
};
