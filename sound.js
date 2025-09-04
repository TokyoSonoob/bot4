// sound.js — ใช้ได้เฉพาะสมาชิกที่มีสิทธิ์ (Manage Channels หรือ Administrator), ไม่มี whitelist
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

/** ตอบแบบ ephemeral โดยใช้ flags พร้อม fallback */
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

/** อนุญาตเฉพาะคนที่มีสิทธิ์: ManageChannels หรือ Administrator */
function memberIsAllowed(interaction) {
  const perms = interaction.memberPermissions;
  if (!perms) return false;
  return (
    perms.has(PermissionsBitField.Flags.ManageChannels) ||
    perms.has(PermissionsBitField.Flags.Administrator)
  );
}

/** บอทต้องมี ManageChannels เพื่อสร้างห้อง */
function botHasManageChannels(interaction) {
  return interaction.guild?.members?.me?.permissions?.has(PermissionsBitField.Flags.ManageChannels);
}

module.exports = (client) => {
  const MAX_CREATE = 25;
  const IDS = {
    PICK: "sound_pick_category",
    MODAL_PREFIX: "sound_name_modal",
    INPUT_NAMES: "sound_channel_names",
    INPUT_LIMIT: "sound_channel_limit",
  };

  // 1) ลงทะเบียน /sound — จำกัดให้คนที่มี ManageChannels เห็นคำสั่ง
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("sound")
          .setDescription("เลือกหมวดหมู่ แล้วกรอกชื่อเพื่อสร้างห้องเสียง (Voice) ในนั้น")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.ManageChannels)
          .toJSON()
      );
      console.log("✅ Registered /sound");
    } catch (e) {
      console.error("❌ Register /sound failed:", e);
    }
  });

  // 2) /sound → เลือกหมวดหมู่
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "sound") return;

    if (!memberIsAllowed(interaction)) {
      return safeReply(interaction, { content: "❌ คุณต้องมีสิทธิ์ Manage Channels (หรือเป็นแอดมิน) เพื่อใช้ /sound" });
    }
    if (!botHasManageChannels(interaction)) {
      return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ Manage Channels" });
    }

    const categories = [...interaction.guild.channels.cache.values()]
      .filter((c) => c.type === ChannelType.GuildCategory)
      .sort((a, b) => a.name.localeCompare(b.name, "th"));

    if (categories.length === 0) {
      return safeReply(interaction, { content: "⚠️ เซิร์ฟเวอร์นี้ยังไม่มีหมวดหมู่ (Category) เลย" });
    }

    const limited = categories.slice(0, 25); // Discord จำกัด 25 ตัวเลือก
    const select = new StringSelectMenuBuilder()
      .setCustomId(IDS.PICK)
      .setPlaceholder("เลือกหมวดหมู่ที่จะสร้างห้องเสียง")
      .addOptions(limited.map((c) => ({ label: c.name.slice(0, 100), value: c.id })));

    const row = new ActionRowBuilder().addComponents(select);
    await safeReply(interaction, {
      content: "เลือกหมวดหมู่",
      components: [row],
    });
  });

  // 3) เลือก Category → เปิด Modal กรอกชื่อ + จำนวนคน
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== IDS.PICK) return;

    if (!memberIsAllowed(interaction)) {
      return safeReply(interaction, { content: "❌ คุณต้องมีสิทธิ์ Manage Channels (หรือเป็นแอดมิน) เพื่อใช้ /sound" });
    }

    const categoryId = interaction.values?.[0];
    const category = interaction.guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      return safeReply(interaction, { content: "❌ หมวดหมู่ไม่ถูกต้องหรือไม่พบ" });
    }

    const modal = new ModalBuilder()
      .setCustomId(`${IDS.MODAL_PREFIX}:${category.id}`)
      .setTitle(`สร้างห้องเสียงใน: ${category.name.slice(0, 30)}`);

    const namesInput = new TextInputBuilder()
      .setCustomId(IDS.INPUT_NAMES)
      .setLabel("ชื่อห้องเสียง (คั่นด้วย space/newline)")
      .setPlaceholder("เช่น: คุยเล่น สตรีม คอลงาน")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000);

    const limitInput = new TextInputBuilder()
      .setCustomId(IDS.INPUT_LIMIT)
      .setLabel("จำนวนคนสูงสุด (1–99, เว้นว่าง=ไม่จำกัด)")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(3);

    modal.addComponents(
      new ActionRowBuilder().addComponents(namesInput),
      new ActionRowBuilder().addComponents(limitInput)
    );

    await interaction.showModal(modal);
  });

  // 4) Modal Submit → สร้าง Voice ใต้ Category
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (!interaction.customId.startsWith(IDS.MODAL_PREFIX + ":")) return;

    if (!memberIsAllowed(interaction)) {
      return safeReply(interaction, { content: "❌ คุณต้องมีสิทธิ์ Manage Channels (หรือเป็นแอดมิน) เพื่อใช้ /sound" });
    }

    // กัน timeout 3 วิ
    try { await interaction.deferReply({ ephemeral: true }); } catch {}

    const [, categoryId] = interaction.customId.split(":");
    const category = interaction.guild.channels.cache.get(categoryId);
    if (!category || category.type !== ChannelType.GuildCategory) {
      return interaction.editReply({ content: "❌ หมวดหมู่ไม่ถูกต้องหรือไม่พบ" });
    }

    if (!botHasManageChannels(interaction)) {
      return interaction.editReply({ content: "❌ บอทไม่มีสิทธิ์ Manage Channels" });
    }

    const rawNames = interaction.fields.getTextInputValue(IDS.INPUT_NAMES) || "";
    const rawLimit = interaction.fields.getTextInputValue(IDS.INPUT_LIMIT)?.trim();

    let userLimit = 0; // 0 = ไม่จำกัด
    if (rawLimit) {
      const num = parseInt(rawLimit, 10);
      if (!isNaN(num) && num >= 1 && num <= 99) userLimit = num;
    }

    let names = rawNames
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);

    if (names.length === 0) {
      return interaction.editReply({ content: "⚠️ กรุณาระบุชื่ออย่างน้อย 1 ชื่อ" });
    }

    // unique + limit 25
    const seen = new Set();
    names = names
      .filter((n) => {
        const k = n.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, MAX_CREATE);

    const existingLower = new Set(
      interaction.guild.channels.cache
        .filter((ch) => ch.parentId === category.id && ch.type === ChannelType.GuildVoice)
        .map((ch) => ch.name.toLowerCase())
    );

    const results = [];
    for (const nameRaw of names) {
      const name = nameRaw.slice(0, 100);
      if (existingLower.has(name.toLowerCase())) {
        results.push(`• ⏭️ มีอยู่แล้วในหมวดนี้: **${name}**`);
        continue;
      }

      try {
        const created = await interaction.guild.channels.create({
          name,
          type: ChannelType.GuildVoice,
          parent: category.id,
          reason: `Created by ${interaction.user.tag} in ${category.name}`,
          userLimit,
        });
        results.push(`• ✅ สร้างห้องเสียง: **${created.name}** (จำกัด ${userLimit || "ไม่จำกัด"})`);
        existingLower.add(created.name.toLowerCase());
      } catch (e) {
        console.error("create voice channel error:", e);
        results.push(`• ❌ ล้มเหลว: **${name}** (สิทธิ์ไม่พอหรือชื่อไม่ถูกต้อง)`);
      }
    }

    const summary = [
      `📁 หมวดหมู่: **${category.name}**`,
      `🧾 สรุปการสร้างห้องเสียง: **${results.filter((r) => r.includes("✅")).length}/${names.length}** สำเร็จ`,
      ...results,
    ].join("\n").slice(0, 1900);

    await interaction.editReply({ content: summary || "ไม่มีผลลัพธ์" });
  });
};
