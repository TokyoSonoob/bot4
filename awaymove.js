const {
  SlashCommandBuilder,
  Events,
  PermissionsBitField,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
} = require("discord.js");
const { db, admin } = require("./firebase");

const AWAY_COL = "awayMoves";
const awaySelections = new Map();

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(
    PermissionsBitField.Flags.Administrator
  );
}

function makeKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

// ===== ฟังก์ชันย้ายห้อง (เก็บ perms เดิม) =====
async function runAwayMoveForPair(guild, fromId, toId) {
  const fromCat = guild.channels.cache.get(fromId);
  const toCat = guild.channels.cache.get(toId);

  if (
    !fromCat ||
    !toCat ||
    fromCat.type !== ChannelType.GuildCategory ||
    toCat.type !== ChannelType.GuildCategory
  ) {
    return 0;
  }

  const LIMIT = 50;

  const dest = guild.channels.cache.filter(
    (c) => c.parentId === toId && !c.isThread()
  );
  let destCount = dest.size;

  const source = guild.channels.cache
    .filter(
      (c) =>
        c.parentId === fromId &&
        !c.isThread()
    )
    .sort((a, b) => a.position - b.position);

  let moved = 0;

  for (const ch of source.values()) {
    if (destCount >= LIMIT) break;
    try {
      // ❗ ไม่ lockPermissions → ใช้ permission เดิมของห้อง
      await ch.setParent(toCat);
      destCount++;
      moved++;
    } catch (_) {}
  }

  return moved;
}

// ===== UI เลือกหมวดหมู่ =====
function buildCategorySelectRows(guild, current) {
  const cats = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position)
    .first(25);

  const options = cats.map((c) => ({
    label: c.name.slice(0, 100),
    value: c.id,
  }));

  const src = new StringSelectMenuBuilder()
    .setCustomId("awaymove_src")
    .setPlaceholder(
      current?.fromId
        ? `ต้นทาง: ${guild.channels.cache.get(current.fromId)?.name ?? "ไม่พบ"}`
        : "เลือกหมวดหมู่ต้นทาง"
    )
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  const dst = new StringSelectMenuBuilder()
    .setCustomId("awaymove_dst")
    .setPlaceholder(
      current?.toId
        ? `ปลายทาง: ${
            guild.channels.cache.get(current.toId)?.name ?? "ไม่พบ"
          }`
        : "เลือกหมวดหมู่ปลายทาง"
    )
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options);

  return [
    new ActionRowBuilder().addComponents(src),
    new ActionRowBuilder().addComponents(dst),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("awaymove_confirm")
        .setLabel("บันทึก & ย้ายห้อง")
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

module.exports = (client) => {
  // ===== ลงทะเบียนคำสั่ง & ตั้ง cron 1 นาที =====
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("awaymove")
          .setDescription("ระบบย้ายห้องตามหมวดหมู่")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
          .addSubcommand((s) =>
            s.setName("set").setDescription("ตั้งคู่หมวดหมู่ ต้นทาง → ปลายทาง")
          )
          .addSubcommand((s) =>
            s.setName("delete").setDescription("ลบคู่ที่ตั้งค่าไว้")
          )
          .toJSON()
      );
      console.log("✅ awaymove system loaded");
    } catch (e) {
      console.error("❌ Register /awaymove failed:", e);
    }

    // 🔁 ตรวจทุก 1 นาที แล้วลองย้ายตามคู่ที่ตั้งไว้
    setInterval(async () => {
      try {
        for (const guild of client.guilds.cache.values()) {
          const snap = await db
            .collection(AWAY_COL)
            .doc(guild.id)
            .collection("pairs")
            .get();

          if (snap.empty) continue;

          for (const doc of snap.docs) {
            const d = doc.data();
            await runAwayMoveForPair(guild, d.fromId, d.toId);
          }
        }
      } catch (e) {
        console.error("❌ awaymove cron error:", e);
      }
    }, 60 * 1000);
  });

  // ===== /awaymove set & delete =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "awaymove") return;

    if (!isAdmin(interaction)) {
      return interaction.reply({
        content: "❌ ต้องเป็นแอดมินเท่านั้น",
        ephemeral: true,
      });
    }

    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();

    if (sub === "set") {
      const key = makeKey(guild.id, interaction.user.id);
      const now = awaySelections.get(key) || {};
      const rows = buildCategorySelectRows(guild, now);

      return interaction.reply({
        content: "เลือกหมวดหมู่ต้นทางและปลายทาง",
        components: rows,
        ephemeral: true,
      });
    }

    if (sub === "delete") {
      const snap = await db
        .collection(AWAY_COL)
        .doc(guild.id)
        .collection("pairs")
        .get();

      if (snap.empty) {
        return interaction.reply({
          content: "ยังไม่มีคู่ awaymove ที่ตั้งไว้",
          ephemeral: true,
        });
      }

      const rows = [];
      let row = new ActionRowBuilder();
      let count = 0;

      for (const docu of snap.docs) {
        const id = docu.id;
        const d = docu.data();

        const btn = new ButtonBuilder()
          .setCustomId(`away_del_${id}`)
          .setLabel(`${d.fromId} → ${d.toId}`.slice(0, 80))
          .setStyle(ButtonStyle.Danger);

        row.addComponents(btn);
        count++;

        if (count === 5) {
          rows.push(row);
          row = new ActionRowBuilder();
          count = 0;
        }
      }

      if (count > 0) rows.push(row);

      return interaction.reply({
        content: "เลือกคู่ที่ต้องการลบ",
        components: rows,
        ephemeral: true,
      });
    }
  });

  // ===== เลือกหมวดหมู่ src/dst =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;

    const guild = interaction.guild;
    const key = makeKey(guild.id, interaction.user.id);
    const prev = awaySelections.get(key) || {};

    if (interaction.customId === "awaymove_src") {
      prev.fromId = interaction.values[0];
    } else if (interaction.customId === "awaymove_dst") {
      prev.toId = interaction.values[0];
    }

    awaySelections.set(key, prev);
    const rows = buildCategorySelectRows(guild, prev);

    return interaction.update({ components: rows });
  });

  // ===== ปุ่ม confirm / delete =====
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const guild = interaction.guild;

    if (interaction.customId.startsWith("away_del_")) {
      const id = interaction.customId.replace("away_del_", "");

      await db
        .collection(AWAY_COL)
        .doc(guild.id)
        .collection("pairs")
        .doc(id)
        .delete();

      return interaction.update({
        content: "✅ ลบคู่แล้ว",
        components: [],
      });
    }

    if (interaction.customId === "awaymove_confirm") {
      const key = makeKey(guild.id, interaction.user.id);
      const sel = awaySelections.get(key);

      if (!sel?.fromId || !sel?.toId) {
        return interaction.reply({
          content: "กรุณาเลือกหมวดหมู่ให้ครบ",
          ephemeral: true,
        });
      }

      await db
        .collection(AWAY_COL)
        .doc(guild.id)
        .collection("pairs")
        .add({
          fromId: sel.fromId,
          toId: sel.toId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

      const moved = await runAwayMoveForPair(guild, sel.fromId, sel.toId);

      return interaction.update({
        content: `✅ บันทึกเรียบร้อย และย้ายห้องแล้ว **${moved} ห้อง**`,
        components: [],
      });
    }
  });
};
