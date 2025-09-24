// move.js — compatible with hardened ticket.js style
const {
  Events,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  MessageFlags,
} = require("discord.js");

// ===== CONFIG =====
const CATEGORY_MAX_CHANNELS = 50;
const session = new Map();

// ===== Helpers =====
function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}
function isCategory(ch) {
  return ch?.type === ChannelType.GuildCategory;
}
function isTextLike(ch) {
  return ch?.type === ChannelType.GuildText || ch?.type === ChannelType.GuildAnnouncement;
}
function childrenOf(guild, categoryId) {
  return guild.channels.cache
    .filter((ch) => ch.parentId === categoryId && isTextLike(ch))
    .sort((a, b) => (a.rawPosition ?? a.position) - (b.rawPosition ?? b.position))
    .toJSON();
}
function countChildren(guild, categoryId) {
  return childrenOf(guild, categoryId).length;
}
async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** reply แบบ ephemeral ตามสไตล์ hardened */
async function safeReply(interaction, options) {
  const payload = { ...options };
  try {
    if (payload.ephemeral) delete payload.ephemeral;
    payload.flags = MessageFlags.Ephemeral;
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
  } catch (e) {
    try {
      const alt = { ...options, ephemeral: true };
      if (interaction.deferred || interaction.replied) return interaction.followUp(alt);
      return interaction.reply(alt);
    } catch (_) {
      console.error("safeReply error:", e);
    }
  }
}

function buildMoveEmbed(sel) {
  const from = sel?.fromCatId ? `<#${sel.fromCatId}>` : "—";
  const to = sel?.toCatId ? `<#${sel.toCatId}>` : "—";
  return new EmbedBuilder()
    .setTitle("ย้ายห้อง")
    .setDescription([`**ต้นทาง:** ${from}`, `**ปลายทาง:** ${to}`].join("\n"))
    .setColor(0x8a2be2);
}

function buildSelectors() {
  const row1 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("move_select_from")
      .setPlaceholder("เลือกหมวดหมู่ต้นทาง")
      .addChannelTypes(ChannelType.GuildCategory)
      .setMinValues(1)
      .setMaxValues(1)
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId("move_select_to")
      .setPlaceholder("เลือกหมวดหมู่ปลายทาง")
      .addChannelTypes(ChannelType.GuildCategory)
      .setMinValues(1)
      .setMaxValues(1)
  );
  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("move_start").setLabel("เริ่มย้าย").setStyle(ButtonStyle.Primary)
  );
  return [row1, row2, row3];
}

/** พยายามกู้ state จากข้อความเดิม ถ้า session หาย (ไม่เตือน /move ก่อน) */
function recoverStateFromMessage(msg) {
  const sel = { fromCatId: null, toCatId: null };
  const emb = msg?.embeds?.[0];
  const desc = emb?.description || "";
  // หา pattern <#1234567890>
  const matches = [...desc.matchAll(/<#[0-9]+>/g)].map((m) => m[0].slice(2, -1));
  // โดย buildMoveEmbed วาง **ต้นทาง** ขึ้นก่อนตามด้วย **ปลายทาง**
  if (matches[0]) sel.fromCatId = matches[0];
  if (matches[1]) sel.toCatId = matches[1];
  if (!sel.fromCatId && !sel.toCatId) return null;
  return sel;
}

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
      break; // สิทธิ์/ลิมิต/ฯลฯ
    }
    await wait(400); // ผ่อน rate limit
  }
  return moved;
}

module.exports = function (client) {
  // ===== Register /move (global) =====
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create({
        name: "move",
        description:
          "ย้ายห้องจากหมวดหมู่หนึ่งไปอีกหมวด (ย้ายทีละห้องจากบนลงล่าง จนกว่าปลายทางจะเต็ม)",
        default_member_permissions: String(PermissionsBitField.Flags.Administrator),
        dm_permission: false,
      });
      console.log("✅ Registered /move");
    } catch (e) {
      console.error("register /move failed:", e?.message || e);
    }
  });

  // ===== Interactions =====
  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      // /move
      if (interaction.isChatInputCommand?.() && interaction.commandName === "move") {
        if (!isAdmin(interaction)) {
          return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน" });
        }
        const uid = interaction.user.id;
        session.set(uid, { fromCatId: null, toCatId: null });

        return safeReply(interaction, {
          embeds: [buildMoveEmbed(session.get(uid))],
          components: buildSelectors(),
        });
      }

      // เลือกหมวดหมู่ (from/to)
      if (interaction.isChannelSelectMenu?.()) {
        if (!isAdmin(interaction)) {
          return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน" });
        }
        const uid = interaction.user.id;
        // ถ้าไม่มี session → กู้จากข้อความเดิม แทนการเตือน
        if (!session.has(uid)) {
          const recovered = recoverStateFromMessage(interaction.message);
          session.set(uid, recovered || { fromCatId: null, toCatId: null });
        }

        const picked = interaction.values?.[0];
        const cur = session.get(uid) || {};
        if (interaction.customId === "move_select_from") {
          cur.fromCatId = picked;
        } else if (interaction.customId === "move_select_to") {
          cur.toCatId = picked;
        }
        session.set(uid, cur);
        return interaction.update({
          embeds: [buildMoveEmbed(cur)],
          components: buildSelectors(),
        });
      }

      // เริ่มย้าย
      if (interaction.isButton?.() && interaction.customId === "move_start") {
        if (!isAdmin(interaction)) {
          return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน" });
        }
        const uid = interaction.user.id;

        // ถ้าไม่มี session → กู้จากข้อความเดิม (ไม่เตือน)
        if (!session.has(uid)) {
          const recovered = recoverStateFromMessage(interaction.message);
          if (recovered) session.set(uid, recovered);
        }
        const sel = session.get(uid);

        // ถ้ากู้ไม่ได้จริงๆ ก็เงียบๆ (ไม่เด้ง “/move ก่อน”)
        if (!sel?.fromCatId || !sel?.toCatId || sel.fromCatId === sel.toCatId) {
          // อัปเดต embed ให้เห็นสถานะปัจจุบัน แต่ไม่เตือน
          if (interaction.isRepliable?.()) {
            await safeReply(interaction, {
              content: "⚠️ ยังเลือกต้นทาง/ปลายทางไม่ครบหรือซ้ำกัน",
            });
          }
          return;
        }

        const guild = interaction.guild;
        const fromCat = guild.channels.cache.get(sel.fromCatId);
        const toCat = guild.channels.cache.get(sel.toCatId);
        if (!isCategory(fromCat) || !isCategory(toCat)) {
          return safeReply(interaction, { content: "❌ กรุณาเลือกเป็น **หมวดหมู่ (Category)** เท่านั้น" });
        }

        await safeReply(interaction, { content: "⏳ กำลังย้ายห้อง..." });

        const beforeFrom = countChildren(guild, fromCat.id);
        const beforeTo = countChildren(guild, toCat.id);

        const moved = await moveFromToUntil(guild, fromCat.id, toCat.id);

        const afterFrom = countChildren(guild, fromCat.id);
        const afterTo = countChildren(guild, toCat.id);

        await safeReply(interaction, {
          content: [
            `✅ **เสร็จสิ้น: ย้ายแล้ว ${moved} ห้อง**`,
            `• ต้นทาง: <#${fromCat.id}> — ${beforeFrom} → ${afterFrom}`,
            `• ปลายทาง: <#${toCat.id}> — ${beforeTo} → ${afterTo}`,
            afterFrom === 0 ? "• ต้นทางหมด ✅" : "",
            afterTo >= CATEGORY_MAX_CHANNELS ? `• ปลายทางเต็ม (ลิมิต ${CATEGORY_MAX_CHANNELS})` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        });

        session.delete(uid);
        return;
      }

      // ถ้าเป็น interaction อื่นๆ แล้วไม่มี session → เงียบ (ไม่เตือน)
    } catch (err) {
      console.error("move module interaction error:", err);
      try {
        if (interaction?.isRepliable?.()) {
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: "❌ มีข้อผิดพลาดในคำสั่ง /move", flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content: "❌ มีข้อผิดพลาดในคำสั่ง /move", ephemeral: true });
          }
        }
      } catch {}
    }
  });
};
