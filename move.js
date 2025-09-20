
const {
  Events,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ComponentType,
} = require("discord.js");

module.exports = function (client) {
  const CATEGORY_MAX_CHANNELS = 50;
  const session = new Map();
  function isCategory(ch) { return ch?.type === 4; }
  function isTextLike(ch) { return ch?.type === 0 || ch?.type === 5; }
  function childrenOf(guild, categoryId) {
    return guild.channels.cache
      .filter(ch => ch.parentId === categoryId && isTextLike(ch))
      .sort((a, b) => (a.rawPosition ?? a.position) - (b.rawPosition ?? b.position))
      .toJSON();
  }
  function countChildren(guild, categoryId) { return childrenOf(guild, categoryId).length; }

  async function moveFromToUntil(guild, fromId, toId) {
    let moved = 0;
    while (true) {
      const fromChildren = childrenOf(guild, fromId);
      const toCount = countChildren(guild, toId);
      if (fromChildren.length === 0) break;
      if (toCount >= CATEGORY_MAX_CHANNELS) break;

      const top = fromChildren[0];
      try {
        await top.setParent(toId, { lockPermissions: false });
        moved++;
      } catch (e) {
        break;
      }
      await new Promise(r => setTimeout(r, 400));
    }
    return moved;
  }

  function buildMoveEmbed(sel) {
    const from = sel?.fromCatId ? `<#${sel.fromCatId}>` : "—";
    const to   = sel?.toCatId   ? `<#${sel.toCatId}>`   : "—";
    return new EmbedBuilder()
      .setTitle("ย้ายห้อง")
      .setDescription([
        `**ต้นทาง : ${from}**`,
        `**ปลายทาง : ${to}**`,
      ].join("\n"))
      .setColor(0x8a2be2);
  }

  function buildSelectors() {
    const row1 = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("move_select_from")
        .setPlaceholder("เลือกต้นทาง")
        .addChannelTypes(4)
        .setMinValues(1)
        .setMaxValues(1)
    );
    const row2 = new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId("move_select_to")
        .setPlaceholder("เลือกปลายทาง")
        .addChannelTypes(4)
        .setMinValues(1)
        .setMaxValues(1)
    );
    const row3 = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("move_start")
        .setLabel("เริ่มย้าย")
        .setStyle(ButtonStyle.Primary)
    );
    return [row1, row2, row3];
  }
  client.once(Events.ClientReady, async () => {
    try {
      const guild = client.guilds.cache.first();
      if (!guild) return;
      const existing = await guild.commands.fetch().catch(() => null);
      const dup = existing?.find(c => c.name === "moveroom");
      if (dup) await guild.commands.delete(dup.id).catch(() => {});

      await guild.commands.create({
        name: "move",
        description: "ย้ายห้อง",
      });
      // eslint-disable-next-line no-console
      console.log("✅ Registered /move");
    } catch (e) {
      console.error("register /move failed:", e?.message || e);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand && interaction.isChatInputCommand() && interaction.commandName === "move") {
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
        }
        const uid = interaction.user.id;
        session.set(uid, { fromCatId: null, toCatId: null });

        await interaction.reply({
          embeds: [buildMoveEmbed(session.get(uid))],
          components: buildSelectors(),
          ephemeral: true,
        });
        return;
      }

      if (interaction.isChannelSelectMenu?.()) {
        const uid = interaction.user.id;
        if (!session.has(uid)) {
          return interaction.reply({ content: "⚠️ โปรดเริ่มจาก /move ก่อน", ephemeral: true });
        }
        const picked = interaction.values?.[0];
        const cur = session.get(uid) || {};
        if (interaction.customId === "move_select_from") {
          cur.fromCatId = picked;
        } else if (interaction.customId === "move_select_to") {
          cur.toCatId = picked;
        }
        session.set(uid, cur);
        await interaction.update({
          embeds: [buildMoveEmbed(cur)],
          components: buildSelectors(),
        });
        return;
      }

      // เริ่มย้าย
      if (interaction.isButton && interaction.isButton() && interaction.customId === "move_start") {
        // เช็คสิทธิ์
        if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
        }
        const uid = interaction.user.id;
        const sel = session.get(uid);
        if (!sel?.fromCatId || !sel?.toCatId) {
          return interaction.reply({ content: "⚠️ กรุณาเลือกหมวดหมู่ทั้ง 2 ช่องให้ครบก่อน", ephemeral: true });
        }
        if (sel.fromCatId === sel.toCatId) {
          return interaction.reply({ content: "⚠️ หมวดหมู่ต้นทางและปลายทางต้องไม่ใช่อันเดียวกัน", ephemeral: true });
        }

        const guild = interaction.guild;
        const fromCat = guild.channels.cache.get(sel.fromCatId);
        const toCat   = guild.channels.cache.get(sel.toCatId);
        if (!isCategory(fromCat) || !isCategory(toCat)) {
          return interaction.reply({ content: "❌ กรุณาเลือกเป็น **หมวดหมู่ (Category)** เท่านั้น", ephemeral: true });
        }

        // เริ่มงาน
        await interaction.deferReply({ ephemeral: true });

        const beforeFrom = countChildren(guild, fromCat.id);
        const beforeTo   = countChildren(guild, toCat.id);

        const moved = await moveFromToUntil(guild, fromCat.id, toCat.id);

        const afterFrom = countChildren(guild, fromCat.id);
        const afterTo   = countChildren(guild, toCat.id);

        await interaction.editReply({
          content: [
            `** เสร็จสิ้น! ย้ายห้องจำนวน ${moved} ห้อง**`,
            `** ต้นทาง : <#${fromCat.id}> ${beforeFrom} → ${afterFrom} ห้อง`,
            `** ปลายทาง : <#${toCat.id}> ${beforeTo} → ${afterTo} ห้อง`,
            (afterFrom === 0 ? "• ต้นทางหมด" : ""),
            (afterTo >= CATEGORY_MAX_CHANNELS ? `• ปลายทางเต็ม (${CATEGORY_MAX_CHANNELS})` : ""),
          ].filter(Boolean).join("\n"),
        });

        // เคลียร์เซสชัน
        session.delete(uid);
        return;
      }

      // กดปุ่ม/มีอินเทอแอคชันอื่นบนเมสเสจนี้ แต่ไม่มีเซสชัน
      if ((interaction.isButton?.() || interaction.isChannelSelectMenu?.()) && !session.has(interaction.user.id)) {
        return interaction.reply({ content: "⚠️ โปรดเริ่มจาก /move ก่อน", ephemeral: true });
      }
    } catch (err) {
      console.error("move module interaction error:", err);
      if (interaction?.isRepliable?.() && !interaction.replied && !interaction.deferred) {
        try { await interaction.reply({ content: "❌ มีข้อผิดพลาดในคำสั่ง /move", ephemeral: true }); } catch {}
      }
    }
  });
};
