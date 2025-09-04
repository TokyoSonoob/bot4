// fix.js — Toggle ปุ่ม <-> เมนูเลื่อนเลือก, สลับซ้ำได้ไม่จำกัด, รีสตาร์ตในโค้ดหลังทำเสร็จ
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  Events,
  MessageFlags,
  PermissionsBitField,
} = require("discord.js");
const { db } = require("./firebase");

/** ===== Safe ephemeral reply (ใช้ flags; มี fallback) ===== */
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

/** ===== ตรวจสิทธิ์แอดมิน ===== */
function isAdmin(interaction) {
  try {
    return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
  } catch {
    return false;
  }
}

/** ===== รวม host จาก Firestore (ไม่ซ้ำ) แล้วดึง Title จาก embed จริง ===== */
async function buildHostPickerRows(client, guildId) {
  const snap = await db.collection("ticket_configs").doc(guildId).collection("configs").get();
  if (snap.empty) return { rows: [], empty: true };

  const hostMap = new Map();
  snap.forEach((d) => {
    const x = d.data();
    if (!x?.hostMessageId || !x?.postChannelId) return;
    if (!hostMap.has(x.hostMessageId)) {
      hostMap.set(x.hostMessageId, {
        hostMessageId: x.hostMessageId,
        postChannelId: x.postChannelId,
        page1: x.page1 || {},
      });
    }
  });

  const options = [];
  for (const v of hostMap.values()) {
    let label = null;
    try {
      const ch = await client.channels.fetch(v.postChannelId).catch(() => null);
      const msg = ch?.isTextBased() ? await ch.messages.fetch(v.hostMessageId).catch(() => null) : null;
      label = (msg?.embeds?.[0]?.title || v.page1?.title || v.page1?.buttonLabel || `#${v.hostMessageId}`).toString();
    } catch {
      label = v.page1?.title || v.page1?.buttonLabel || `#${v.hostMessageId}`;
    }
    options.push({
      label: label.slice(0, 100),
      description: `#${v.hostMessageId} • ch:${v.postChannelId}`.slice(0, 100),
      value: `${v.postChannelId}:${v.hostMessageId}`,
    });
    if (options.length >= 25) break;
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId("fix_pick_host")
    .setPlaceholder("เลือกตั๋ว")
    .addOptions(options);

  const row = new ActionRowBuilder().addComponents(select);
  return { rows: [row], empty: false };
}

/** ===== ดึง “รายการตั๋ว” ของโพสต์จาก Firestore เสมอ (เพื่อสลับซ้ำได้แน่นอน) ===== */
async function getTicketOptionsFromFirestore(guildId, postChannelId, hostMessageId) {
  const snap = await db
    .collection("ticket_configs").doc(guildId)
    .collection("configs")
    .where("postChannelId", "==", postChannelId)
    .where("hostMessageId", "==", hostMessageId)
    .get();

  const items = [];
  snap.forEach((d) => {
    const x = d.data();
    const label = (x?.page1?.buttonLabel || x?.page1?.title || `#${d.id}`).toString().slice(0, 80);
    items.push({ label, configId: d.id });
  });

  return items.slice(0, 25); // Discord จำกัด 25
}

/** ===== สร้างเมนูเลื่อนเลือกจากรายการตั๋ว ===== */
function buildSelectRowsFromOptions(options) {
  const select = new StringSelectMenuBuilder()
    .setCustomId("ticket_open_select")
    .setPlaceholder("เลือกตั๋ว")
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(
      options.map((o) => ({
        label: o.label,
        value: `ticket_open:${o.configId}`,
      }))
    );
  return [new ActionRowBuilder().addComponents(select)];
}

/** ===== สร้างปุ่มจากรายการตั๋ว (จัด 5 ปุ่ม/แถว) ===== */
function buildButtonRowsFromOptions(options) {
  const rows = [];
  let row = new ActionRowBuilder();
  for (const o of options) {
    const btn = new ButtonBuilder()
      .setCustomId(`ticket_open:${o.configId}`)
      .setLabel(o.label)
      .setStyle(ButtonStyle.Primary);

    if ((row.components?.length || 0) >= 5) {
      rows.push(row);
      row = new ActionRowBuilder();
    }
    row.addComponents(btn);
  }
  if ((row.components?.length || 0) > 0) rows.push(row);

  return rows.length
    ? rows
    : [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("noop").setLabel("ไม่มีตั๋ว").setStyle(ButtonStyle.Secondary).setDisabled(true)
      )];
}

/** ===== ตรวจว่าข้อความปัจจุบันเป็น “เมนูเลื่อนเลือก” อยู่ไหม ===== */
function isCurrentlySelect(message) {
  return (message.components || []).some((r) =>
    (r.components || []).some((c) => c.type === 3 /* StringSelect */)
  );
}

module.exports = (client) => {
  // ===== Register /fix (Admin only) =====
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("fix")
          .setDescription("สลับรูปแบบโพสต์ตั๋ว: ปุ่ม ↔ เมนูเลื่อนเลือก (ไม่แก้ embed) — กดซ้ำได้ และรีบอทอัตโนมัติ")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
          .toJSON()
      );
      console.log("✅ Registered /fix");
    } catch (e) {
      console.error("❌ Register /fix failed:", e);
    }
  });

  // ===== /fix → เลือกโพสต์ =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "fix") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
    }

    const guildId = interaction.guild?.id;
    if (!guildId) {
      return safeReply(interaction, { content: "❌ ใช้คำสั่งในเซิร์ฟเวอร์เท่านั้น", ephemeral: true });
    }

    const { rows, empty } = await buildHostPickerRows(client, guildId);
    if (empty) {
      return safeReply(interaction, {
        content: "ℹ️ ยังไม่มีโพสต์ตั๋ว — ใช้ /ticket เพื่อสร้างก่อน",
        ephemeral: true,
      });
    }

    return safeReply(interaction, {
      content: "เลือกตั๋ว",
      components: rows,
      ephemeral: true,
    });
  });

  // ===== เลือก host → สลับรูปแบบ (อิง Firestore เสมอ) + รีบอทในโค้ด =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== "fix_pick_host") return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ เฉพาะแอดมินเท่านั้น", ephemeral: true });
    }

    // กัน timeout
    if (!interaction.deferred && !interaction.replied) {
      try { await interaction.deferReply({ ephemeral: true }); } catch {}
    }

    const picked = interaction.values?.[0];
    if (!picked) {
      return interaction.editReply({ content: "❌ ไม่ได้เลือกโพสต์ตั๋ว" });
    }
    const [postChannelId, hostMessageId] = picked.split(":");
    const guildId = interaction.guild.id;

    // โหลด host message
    const ch = await interaction.client.channels.fetch(postChannelId).catch(() => null);
    if (!ch?.isTextBased()) {
      return interaction.editReply({ content: "❌ ไม่พบห้องข้อความของโพสต์ตั๋ว" });
    }
    const hostMsg = await ch.messages.fetch(hostMessageId).catch(() => null);
    if (!hostMsg) {
      return interaction.editReply({ content: "❌ ไม่พบข้อความโพสต์ตั๋ว" });
    }

    // ดึงรายการตั๋วจาก Firestore ทุกครั้ง (เชื่อถือได้ในการสลับซ้ำ)
    const options = await getTicketOptionsFromFirestore(guildId, postChannelId, hostMessageId);
    if (!options.length) {
      return interaction.editReply({ content: "⚠️ โพสต์นี้ยังไม่มีตั๋วให้เลือกแปลง" });
    }

    const currentlySelect = isCurrentlySelect(hostMsg);

    try {
      if (currentlySelect) {
        // เมนู → ปุ่ม
        const newRows = buildButtonRowsFromOptions(options);
        await hostMsg.edit({ components: newRows });
        await interaction.editReply({
          content: "✅ กำลังแปลง",
        });
      } else {
        // ปุ่ม → เมนู
        const newRows = buildSelectRowsFromOptions(options);
        await hostMsg.edit({ components: newRows });
        await interaction.editReply({
          content: "✅ กำลังแปลง",
        });
      }

      // === รีสตาร์ตในโค้ด หลังตอบกลับสำเร็จ ===
      setTimeout(() => {
        console.log("🔁 Exiting process for auto-restart after /fix");
        process.exit(0);
      }, 1500);

    } catch (e) {
      console.error("fix transform error:", e);
      return interaction.editReply({ content: `❌ ไม่สามารถสลับรูปแบบ: ${e.message || e}` });
    }
  });
};
