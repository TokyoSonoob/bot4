// invite.js
// ฟีเจอร์: /invite → เปิดฟอร์มให้ตั้ง Title/Description (รองรับ @user / @invite / @count)
// เมื่อมีสมาชิกใหม่เข้ามา จะตรวจว่ามาจากลิงก์ของใคร แล้วส่ง Embed ตามเทมเพลตในห้องที่ตั้งไว้

const {
  SlashCommandBuilder,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  Events,
  PermissionsBitField,
} = require("discord.js");
const { db, admin } = require("./firebase"); // ต้องมีไฟล์ firebase.js export { db, admin }

const CONFIG_COL = "inviteTrackers"; // guildId -> { channelId, titleTpl, descTpl, updatedAt }
const LOGS_SUB   = "inviteLogs";     // เก็บประวัติการเชิญ (ออปชัน)
const STATS_SUB  = "inviteStats";    // เก็บจำนวนเชิญต่อคน (ออปชัน)

// ---- แคชค่า invites ต่อกิลด์ ----
// Map<guildId, Map<codeOrSpecial, { uses:number, inviterId?:string|null, kind:'normal'|'vanity' }>>
const invitesCache = new Map();
const VANITY_KEY = "__VANITY__";

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

function getGuildCache(gid) {
  let m = invitesCache.get(gid);
  if (!m) { m = new Map(); invitesCache.set(gid, m); }
  return m;
}

async function fetchInvitesMap(guild) {
  const map = new Map();

  // รายการลิงก์เชิญปกติ
  try {
    const coll = await guild.invites.fetch(); // ต้องการ Manage Guild
    for (const inv of coll.values()) {
      map.set(inv.code, {
        uses: inv.uses ?? 0,
        inviterId: inv.inviter?.id ?? null,
        kind: "normal",
      });
    }
  } catch (e) {
    console.warn(`[invite] fetch normal invites failed on ${guild.id}:`, e?.message || e);
  }

  // vanity URL (ถ้ามี)
  try {
    if (guild.vanityURLCode) {
      const vd = await guild.fetchVanityData(); // { code, uses }
      map.set(VANITY_KEY, {
        uses: vd?.uses ?? 0,
        inviterId: null,
        kind: "vanity",
      });
    }
  } catch (_) {}

  return map;
}

async function ensureCachePrimed(guild) {
  const cache = getGuildCache(guild.id);
  if (cache.size === 0) {
    const snap = await fetchInvitesMap(guild);
    invitesCache.set(guild.id, snap);
  }
}

function diffInvites(oldMap, newMap) {
  // หาตัวที่ uses เพิ่มขึ้นมากที่สุด
  let best = null;
  let bestDiff = 0;

  for (const [code, n] of newMap.entries()) {
    const o = oldMap.get(code);
    const oldUses = o?.uses ?? 0;
    const d = (n.uses ?? 0) - oldUses;
    if (d > bestDiff) {
      bestDiff = d;
      best = { code, ...n, diff: d };
    }
  }
  if (best) return best;

  // เคสลิงก์วันช็อตถูกใช้แล้วโดนลบ → หายไปจาก newMap
  const disappeared = [...oldMap.keys()].filter((code) => !newMap.has(code) && code !== VANITY_KEY);
  if (disappeared.length === 1) {
    const o = oldMap.get(disappeared[0]);
    return {
      code: disappeared[0],
      uses: (o?.uses ?? 0) + 1,
      inviterId: o?.inviterId ?? null,
      kind: "normal",
      diff: 1,
      disappeared: true,
    };
  }
  return null;
}

function renderTemplate(tpl, { userMention, inviteText, countText }) {
  const s = typeof tpl === "string" ? tpl : "";
  // แทนค่า: @user, @invite, @count
  return s
    .replaceAll("@user", userMention)
    .replaceAll("@invite", inviteText)
    .replaceAll("@count", countText);
}

async function saveLogAndBumpStats(guildId, payload) {
  // payload: { memberId, inviterId, code, uses, type, ts }
  const guildRef = db.collection(CONFIG_COL).doc(guildId);
  await guildRef.collection(LOGS_SUB).add(payload).catch(() => {});
  if (payload.inviterId) {
    await guildRef.collection(STATS_SUB).doc(payload.inviterId).set({
      count: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
  }
}

const IDS = {
  MODAL: "invite_modal",
  INPUT_TITLE: "invite_title",
  INPUT_DESC: "invite_desc",
};

module.exports = (client) => {
  // ---------- ลงทะเบียน /invite (เฉพาะแอดมิน) ----------
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("invite")
          .setDescription("ตั้งค่า Title/Description สำหรับรายงานคนเข้ามาใหม่ (รองรับ @user/@invite/@count)")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) // ✅ แอดมินเท่านั้น
          .toJSON()
      );
      console.log("✅ Registered /invite");
    } catch (e) {
      console.error("❌ Register /invite failed:", e);
    }

    // prime cache สำหรับกิลด์ที่ตั้งค่าไว้แล้ว
    try {
      const snap = await db.collection(CONFIG_COL).get();
      for (const doc of snap.docs) {
        const guildId = doc.id;
        const guild = client.guilds.cache.get(guildId);
        if (guild) ensureCachePrimed(guild).catch(() => {});
      }
    } catch (_) {}
  });

  // ---------- /invite → เปิด Modal ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "invite") return;

    try {
      if (!isAdmin(interaction)) {
        return interaction.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
      }

      const me = interaction.guild?.members?.me;
      if (!me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
        return interaction.reply({
          content: "❌ บอทต้องการสิทธิ์ **Manage Guild** เพื่ออ่าน/ติดตามลิงก์เชิญ",
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(IDS.MODAL)
        .setTitle("ตั้งค่า Invite Message"); // ≤ 45 ตัวอักษร

      const iTitle = new TextInputBuilder()
        .setCustomId(IDS.INPUT_TITLE)
        .setLabel("Title")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(256)
        .setPlaceholder(" ");

      const iDesc = new TextInputBuilder()
        .setCustomId(IDS.INPUT_DESC)
        .setLabel("คำอธิบาย (ใช้ @user / @invite / @count)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setPlaceholder("@user มาจาก @invite ตอนนี้เชิญทั้งสิ้น @count คน");

      modal.addComponents(
        new ActionRowBuilder().addComponents(iTitle),
        new ActionRowBuilder().addComponents(iDesc),
      );

      await interaction.showModal(modal);
    } catch (e) {
      console.error("❌ open /invite modal error:", e);
      if (interaction.isRepliable()) {
        interaction.reply({ content: "เกิดข้อผิดพลาด", ephemeral: true }).catch(() => {});
      }
    }
  });

  // ---------- รับค่า Modal & บันทึกตั้งค่า ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId !== IDS.MODAL) return;

    try {
      if (!isAdmin(interaction)) {
        return interaction.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
      }

      const guild = interaction.guild;
      const channel = interaction.channel;

      const titleTpl = interaction.fields.getTextInputValue(IDS.INPUT_TITLE).trim();
      const descTpl = interaction.fields.getTextInputValue(IDS.INPUT_DESC).trim();

      // บันทึกห้องปัจจุบัน + เทมเพลต
      await db.collection(CONFIG_COL).doc(guild.id).set({
        channelId: channel.id,
        titleTpl,
        descTpl,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // เตรียม cache ทันที
      await ensureCachePrimed(guild);

      await interaction.reply({
        content: `✅ ตั้งค่า Invite Message เรียบร้อย\n• Channel: <#${channel.id}>`,
        ephemeral: true,
      });
    } catch (e) {
      console.error("❌ save invite template error:", e);
      if (interaction.isRepliable()) {
        interaction.reply({ content: "❌ เกิดข้อผิดพลาด กรุณาลองใหม่", ephemeral: true }).catch(() => {});
      }
    }
  });

  // ---------- อัปเดต cache เมื่อมีการสร้าง/ลบลิงก์ ----------
  client.on(Events.InviteCreate, async (invite) => {
    try {
      const map = await fetchInvitesMap(invite.guild);
      invitesCache.set(invite.guild.id, map);
    } catch (_) {}
  });
  client.on(Events.InviteDelete, async (invite) => {
    try {
      const map = await fetchInvitesMap(invite.guild);
      invitesCache.set(invite.guild.id, map);
    } catch (_) {}
  });

  // ---------- ส่ง Embed เมื่อมีคนเข้า ----------
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const guild = member.guild;

      // โหลดตั้งค่า
      const cfgDoc = await db.collection(CONFIG_COL).doc(guild.id).get();
      if (!cfgDoc.exists) return;
      const cfg = cfgDoc.data();
      const reportChannel = guild.channels.cache.get(cfg.channelId);
      if (!reportChannel || !reportChannel.isTextBased()) return;

      // ให้มีค่าเก่าก่อน
      await ensureCachePrimed(guild);

      // old/new snapshot
      const oldMap = getGuildCache(guild.id);
      const newMap = await fetchInvitesMap(guild);
      invitesCache.set(guild.id, newMap);

      // หาลิงก์ที่ถูกใช้
      const used = diffInvites(oldMap, newMap);

      const inviterId = used?.inviterId || null;
      const type = used?.kind || "unknown";
      const uses = used?.uses ?? null;

      const userMention = `<@${member.id}>`;
      const inviteText =
        inviterId ? `<@${inviterId}>`
        : (type === "vanity" ? "vanity" : "ไม่ทราบ");
      const countText = uses != null ? String(uses) : "—";

      // เรนเดอร์เทมเพลต
      const title = renderTemplate(cfg.titleTpl, { userMention, inviteText, countText }) || "Welcome";
      const description = renderTemplate(cfg.descTpl, { userMention, inviteText, countText }) || "";

      // (ออปชัน) เก็บ log/สถิติ
      saveLogAndBumpStats(guild.id, {
        memberId: member.id,
        inviterId: inviterId || null,
        code: used?.kind === "vanity" ? guild.vanityURLCode : used?.code || null,
        uses: uses,
        type,
        ts: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});

      // สร้าง Embed และส่ง
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle(title.slice(0, 256))
        .setDescription(description.slice(0, 4000))
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
        .setTimestamp();

      await reportChannel.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {
      console.error("❌ invite tracker on join error:", e);
    }
  });
};
