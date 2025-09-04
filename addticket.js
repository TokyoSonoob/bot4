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
  ChannelType,
} = require("discord.js");
const { db, admin } = require("./firebase");

/** ใช้ตอบแบบ ephemeral ด้วย flags; มี fallback */
async function safeReply(interaction, options) {
  const payload = { ...options };
  try {
    if (payload.ephemeral) delete payload.ephemeral; // ใช้ flags แทน
    payload.flags = MessageFlags.Ephemeral;

    if (interaction.deferred || interaction.replied) {
      try {
        return await interaction.followUp(payload);
      } catch {
        if (interaction.editReply) return await interaction.editReply(payload);
        throw new Error("Cannot followUp or editReply");
      }
    }

    return await interaction.reply(payload);
  } catch (e) {
    try {
      const alt = { ...options, ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        try {
          return await interaction.followUp(alt);
        } catch {
          if (interaction.editReply) return await interaction.editReply(alt);
          throw new Error("Cannot followUp or editReply (alt)");
        }
      }
      return await interaction.reply(alt);
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

/** ===== เก็บสถานะชั่วคราว หลังส่งฟอร์ม แต่ก่อนเลือก Category ===== */
const pendingAddTicket = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 นาที

function setPending(userId, data) {
  pendingAddTicket.set(userId, { ...data, createdAt: Date.now() });
}
function getPending(userId) {
  const v = pendingAddTicket.get(userId);
  if (!v) return null;
  if (Date.now() - v.createdAt > PENDING_TTL_MS) {
    pendingAddTicket.delete(userId);
    return null;
  }
  return v;
}
function clearPending(userId) {
  pendingAddTicket.delete(userId);
}

/** ===== ตัวช่วยสร้างเมนูเลือก host พร้อม “ดึง Title จริงจากข้อความ” =====
 * อ่าน embed[0].title จากข้อความ host; ถ้าอ่านไม่ได้จริง ๆ ค่อย fallback
 */
async function buildHostPickerRows(client, guildId) {
  const colRef = db.collection("ticket_configs").doc(guildId).collection("configs");
  const snap = await colRef.get();

  if (snap.empty) return { rows: [], empty: true };

  // รวม host message แบบไม่ซ้ำ
  const hostMap = new Map(); // key: hostMessageId
  snap.forEach((d) => {
    const data = d.data();
    const key = data.hostMessageId;
    if (!key) return;
    if (!hostMap.has(key)) {
      hostMap.set(key, {
        postChannelId: data.postChannelId,
        hostMessageId: data.hostMessageId,
        page1: data.page1 || {},
      });
    }
  });

  const options = [];
  for (const v of hostMap.values()) {
    let display = null;
    try {
      const ch = await client.channels.fetch(v.postChannelId).catch(() => null);
      const msg = ch?.isTextBased() ? await ch.messages.fetch(v.hostMessageId).catch(() => null) : null;
      const titleFromEmbed = msg?.embeds?.[0]?.title;
      display = String(titleFromEmbed || "").trim();
    } catch { /* ignore */ }

    if (!display) display = v.page1?.title || v.page1?.buttonLabel || `#${v.hostMessageId}`;

    options.push({
      label: String(display).slice(0, 100),
      description: `#${v.hostMessageId} • ch:${v.postChannelId}`.slice(0, 100),
      value: `${v.postChannelId}:${v.hostMessageId}`,
    });

    if (options.length >= 25) break; // Discord จำกัด 25 ตัวเลือก
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("addticket_pick_host")
    .setPlaceholder("เลือกชุดตั๋ว (ชื่ออ่านจาก Embed จริง)")
    .addOptions(options);

  const rowSelect = new ActionRowBuilder().addComponents(select);

  // ปุ่มล้างตัวเลือก
  const clearBtn = new ButtonBuilder()
    .setCustomId("addticket_clear")
    .setLabel("ล้างตัวเลือก")
    .setStyle(ButtonStyle.Secondary);

  const rowButtons = new ActionRowBuilder().addComponents(clearBtn);

  return { rows: [rowSelect, rowButtons], empty: false };
}

/** ===== เมนูเลือก Category จริงจาก Discord (เรียงตาม position) ===== */
function buildCategoryPickerRows(guild) {
  const cats = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position)
    .map((c) => ({ id: c.id, name: c.name }));

  if (!cats.length) return { rows: [], empty: true };

  const options = cats.slice(0, 25).map((c) => ({
    label: c.name.slice(0, 100),
    description: `ID: ${c.id}`.slice(0, 100),
    value: c.id,
  }));

  const select = new StringSelectMenuBuilder()
    .setCustomId("addticket_pick_category")
    .setPlaceholder("เลือกหมวดหมู่ที่จะใช้สร้างห้องตั๋ว")
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(select);
  return { rows: [row], empty: false };
}

/** ====== จัดการ “กลุ่มข้อความ host” ให้มีปุ่มรวม ≤ 25 และเติมได้แม้เกิน 5 ปุ่ม/แถว =======
 * ticket_configs/<guildId>/hosts/<hostMessageId>  => { extraMessageIds: [..] }
 */
function getHostContainerDoc(guildId, hostMessageId) {
  return db.collection("ticket_configs").doc(guildId)
    .collection("hosts").doc(hostMessageId);
}

/** นับจำนวนปุ่มในข้อความหนึ่ง ๆ */
function countButtonsInMessage(msg) {
  const rows = msg.components || [];
  return rows.reduce((acc, row) => acc + (row.components?.length || 0), 0);
}

/** clone แถว/ปุ่มปลอดภัยด้วย ActionRowBuilder.from แล้วค่อย addComponents ปุ่มใหม่ */
function tryPlaceButtonInMessage(message, newButton) {
  const existingRows = message.components || [];
  const newRows = existingRows.map((r) => ActionRowBuilder.from(r)); // clone row

  let placed = false;
  // หาแถวที่ยัง < 5 ปุ่ม แล้ว addComponents(newButton)
  for (const row of newRows) {
    const currentCount = row.components?.length || 0;
    if (currentCount < 5) {
      row.addComponents(newButton);
      placed = true;
      break;
    }
  }

  // ถ้าไม่มีแถวว่างและยังไม่ครบ 5 แถว → เพิ่มแถวใหม่ 1 แถว
  if (!placed) {
    if (newRows.length >= 5) {
      return { placed: false, rows: existingRows };
    }
    newRows.push(new ActionRowBuilder().addComponents(newButton));
    placed = true;
  }

  return { placed, rows: newRows };
}

/** รวม “ปุ่มทั้งหมดในกลุ่ม host” (host หลัก + extra) เพื่อเช็คเพดาน 25 */
async function countButtonsAcrossGroup(client, postChannelId, hostMessageId, extraMessageIds) {
  const ch = await client.channels.fetch(postChannelId).catch(() => null);
  if (!ch?.isTextBased()) return 0;

  let total = 0;
  const hostMsg = await ch.messages.fetch(hostMessageId).catch(() => null);
  if (hostMsg) total += countButtonsInMessage(hostMsg);

  for (const mid of extraMessageIds || []) {
    const m = await ch.messages.fetch(mid).catch(() => null);
    if (m) total += countButtonsInMessage(m);
  }
  return total;
}

/** เติมปุ่มลง “กลุ่ม host”:
 *  1) พยายามใส่ใน host หลักก่อน
 *  2) ถ้าเต็ม ลองไล่ใส่ใน extra messages ที่มีอยู่
 *  3) ถ้ายังเต็มทุกอัน และ total < 25 → ส่งข้อความใหม่ (ปุ่มล้วน) แล้ววางปุ่มลงไป
 */
async function addButtonIntoHostGroup(client, guildId, postChannelId, hostMessageId, newButton) {
  const ch = await client.channels.fetch(postChannelId).catch(() => null);
  if (!ch?.isTextBased()) throw new Error("ไม่พบห้องข้อความ");

  const hostDocRef = getHostContainerDoc(guildId, hostMessageId);
  const hostDocSnap = await hostDocRef.get();
  const extraMessageIds = hostDocSnap.exists ? (hostDocSnap.data().extraMessageIds || []) : [];

  const currentTotal = await countButtonsAcrossGroup(client, postChannelId, hostMessageId, extraMessageIds);
  if (currentTotal >= 25) throw new Error("เพิ่มปุ่มไม่ได้: กลุ่มนี้มีปุ่มครบ 25 แล้ว");

  // 1) host หลัก
  const hostMsg = await ch.messages.fetch(hostMessageId).catch(() => null);
  if (hostMsg) {
    const { placed, rows } = tryPlaceButtonInMessage(hostMsg, newButton);
    if (placed) {
      await hostMsg.edit({ components: rows });
      return { messageId: hostMsg.id, isExtra: false };
    }
  }

  // 2) extra เดิม
  for (const mid of extraMessageIds) {
    const m = await ch.messages.fetch(mid).catch(() => null);
    if (!m) continue;
    const { placed, rows } = tryPlaceButtonInMessage(m, newButton);
    if (placed) {
      await m.edit({ components: rows });
      return { messageId: m.id, isExtra: true };
    }
  }

  // 3) สร้างข้อความใหม่ (ปุ่มล้วน)
  const newMsg = await ch.send({ components: [new ActionRowBuilder().addComponents(newButton)] });
  const newExtra = Array.from(new Set([...extraMessageIds, newMsg.id]));
  await hostDocRef.set(
    { extraMessageIds: newExtra, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );

  return { messageId: newMsg.id, isExtra: true, created: true };
}

module.exports = (client) => {
  // ---------- 1) ลงทะเบียน /addticket ----------
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("addticket")
          .setDescription("เพิ่มปุ่ม ticket ให้ embed เดิม; ถ้าเต็มจะสร้างข้อความปุ่มล้วนด้านล่าง (รวมไม่เกิน 25)")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
          .toJSON()
      );
      console.log("✅ Registered /addticket");
    } catch (e) {
      console.error("❌ Register /addticket failed:", e);
    }
  });

  // ---------- 2) /addticket → เลือก host ----------
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

    const { rows, empty } = await buildHostPickerRows(client, guildId);
    if (empty) {
      return safeReply(interaction, {
        content: "ℹ️ ยังไม่มี embed ticket — ใช้ /ticket เพื่อสร้างก่อน",
        ephemeral: true,
      });
    }

    await safeReply(interaction, {
      content: "เลือกชุดตั๋ว (ชื่ออ่านจาก Embed จริง — กด “ล้างตัวเลือก” เพื่อรีเซ็ต):",
      components: rows,
      ephemeral: true,
    });
  });

  // ---------- 2.1) ปุ่มล้างตัวเลือก ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (interaction.customId !== "addticket_clear") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, {
        content: "❌ เฉพาะแอดมินเท่านั้น",
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

    const { rows, empty } = await buildHostPickerRows(client, guildId);
    if (empty) {
      try {
        return await interaction.update({
          content: "ℹ️ ยังไม่มี embed ticket — ใช้ /ticket เพื่อสร้างก่อน",
          components: [],
        });
      } catch {
        return safeReply(interaction, {
          content: "ℹ️ ยังไม่มี embed ticket — ใช้ /ticket เพื่อสร้างก่อน",
          ephemeral: true,
        });
      }
    }

    await interaction.update({
      content: "เลือกชุดตั๋ว (ล้างแล้ว ✅):",
      components: rows,
    });
  });

  // ---------- 3) เลือก host → เปิด Modal (ไม่มีช่องหมวดหมู่แล้ว) ----------
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
      return safeReply(interaction, { content: "❌ ไม่ได้เลือกชุดตั๋ว", ephemeral: true });
    }
    const [postChannelId, hostMessageId] = picked.split(":");

    const modal = new ModalBuilder()
      .setCustomId(`addticket_modal:${postChannelId}:${hostMessageId}`)
      .setTitle("เพิ่มปุ่ม Ticket (ไม่แก้ embed)");

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

    modal.addComponents(
      new ActionRowBuilder().addComponents(in_title),
      new ActionRowBuilder().addComponents(in_desc),
      new ActionRowBuilder().addComponents(in_room),
      new ActionRowBuilder().addComponents(in_btn)
    );

    await interaction.showModal(modal);
  });

  // ---------- 4) Submit Modal → ให้เลือก Category จริง ----------
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

    const ticketTitle = interaction.fields.getTextInputValue("title").trim();
    const ticketDesc = interaction.fields.getTextInputValue("desc").trim();
    const roomPref = interaction.fields.getTextInputValue("room").trim();
    const btnLabel = interaction.fields.getTextInputValue("btn").trim();

    setPending(interaction.user.id, {
      guildId,
      postChannelId,
      hostMessageId,
      ticketTitle,
      ticketDesc,
      roomPref,
      btnLabel,
    });

    const { rows, empty } = buildCategoryPickerRows(guild);
    if (empty) {
      clearPending(interaction.user.id);
      return safeReply(interaction, {
        content: "❌ ไม่พบหมวดหมู่ (Category) ในเซิร์ฟเวอร์นี้ สร้าง Category ก่อนแล้วลองใหม่",
        ephemeral: true,
      });
    }

    await safeReply(interaction, {
      content: "เกือบเสร็จแล้ว! เลือกหมวดหมู่ที่จะใช้สร้างห้องตั๋ว:",
      components: rows,
      ephemeral: true,
    });
  });

  // ---------- 5) เลือก Category → เพิ่มปุ่มเข้ากลุ่ม host (รองรับแตกข้อความใหม่) ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== "addticket_pick_category") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ เฉพาะแอดมินเท่านั้น", ephemeral: true });
    }

    // ✅ ป้องกัน Unknown interaction: ยืนยันก่อน
    if (!interaction.deferred && !interaction.replied) {
      try {
        await interaction.deferReply({ ephemeral: true });
      } catch { /* ignore */ }
    }

    const guild = interaction.guild;
    const guildId = guild?.id;
    const userId = interaction.user.id;

    const pending = getPending(userId);
    if (!pending || pending.guildId !== guildId) {
      return interaction.editReply({
        content: "⏱️ เซสชันหมดอายุหรือไม่พบข้อมูลฟอร์ม กรุณาเริ่มใหม่ด้วย /addticket",
      });
    }

    const catId = interaction.values?.[0];
    if (!catId) {
      return interaction.editReply({ content: "❌ ไม่ได้เลือกหมวดหมู่" });
    }

    const { postChannelId, hostMessageId, ticketTitle, ticketDesc, roomPref, btnLabel } = pending;

    // ==== สร้าง config ใหม่ก่อน ====
    const cfgRef = db.collection("ticket_configs").doc(guildId)
      .collection("configs").doc();
    const configId = cfgRef.id;

    try {
      await cfgRef.set({
        guildId,
        postChannelId,
        hostMessageId,
        categoryId: catId,
        page1: { buttonLabel: btnLabel }, // เก็บชื่อปุ่มไว้ดูภายหลัง
        page2: {
          title: ticketTitle,
          description: ticketDesc,
          url: null,
          roomNamePrefix: roomPref,
        },
        count: 0,
        createdBy: userId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // ==== ปุ่มใหม่ ====
      const newButton = new ButtonBuilder()
        .setCustomId(`ticket_open:${configId}`)
        .setLabel(btnLabel || "เปิดตั๋ว")
        .setStyle(ButtonStyle.Primary);

      // ==== วางปุ่มลงกลุ่ม host ====
      await addButtonIntoHostGroup(
        client,
        guildId,
        postChannelId,
        hostMessageId,
        newButton
      );

      clearPending(userId);

      return interaction.editReply({
        content: "✅ เพิ่มปุ่มใหม่สำเร็จ (ถ้า host หลักเต็ม จะสร้างข้อความปุ่มล้วนด้านล่างอัตโนมัติ)",
      });
    } catch (e) {
      await cfgRef.delete().catch(() => {});
      return interaction.editReply({
        content: `❌ เพิ่มปุ่มไม่สำเร็จ: ${e.message || e}`,
      });
    }
  });
};
