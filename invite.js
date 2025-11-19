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
const { db, admin } = require("./firebase");

const CONFIG_COL = "inviteTrackers";
const STATS_SUB = "inviteStats";

const invitesCache = new Map();
const configCache = new Map();

const VANITY_KEY = "__VANITY__";

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(
    PermissionsBitField.Flags.Administrator
  );
}

function getGuildCache(gid) {
  let m = invitesCache.get(gid);
  if (!m) {
    m = new Map();
    invitesCache.set(gid, m);
  }
  return m;
}

async function fetchInvitesMap(guild) {
  const map = new Map();

  try {
    const coll = await guild.invites.fetch();
    for (const inv of coll.values()) {
      map.set(inv.code, {
        uses: inv.uses ?? 0,
        inviterId: inv.inviter?.id ?? null,
        kind: "normal",
      });
    }
  } catch (e) {
    console.warn(
      `[invite] fetch normal invites failed on ${guild.id}:`,
      e?.message || e
    );
  }

  try {
    if (guild.vanityURLCode) {
      const vd = await guild.fetchVanityData();
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

  const disappeared = [...oldMap.keys()].filter(
    (code) => !newMap.has(code) && code !== VANITY_KEY
  );
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
  return s
    .replaceAll("@user", userMention)
    .replaceAll("@invite", inviteText)
    .replaceAll("@count", countText);
}

const IDS = {
  MODAL: "invite_modal",
  INPUT_TITLE: "invite_title",
  INPUT_DESC: "invite_desc",
};

async function getGuildConfig(guildId) {
  if (configCache.has(guildId)) {
    return configCache.get(guildId);
  }

  try {
    const doc = await db.collection(CONFIG_COL).doc(guildId).get();
    if (!doc.exists) {
      configCache.set(guildId, null);
      return null;
    }
    const cfg = doc.data() || null;
    configCache.set(guildId, cfg);
    return cfg;
  } catch (e) {
    console.error("❌ getGuildConfig error:", e);
    configCache.set(guildId, null);
    return null;
  }
}

async function bumpInviteStats(guildId, inviterId) {
  if (!inviterId) return;
  try {
    await db
      .collection(CONFIG_COL)
      .doc(guildId)
      .collection(STATS_SUB)
      .doc(inviterId)
      .set(
        {
          count: admin.firestore.FieldValue.increment(1),
        },
        { merge: true }
      );
  } catch (_) {}
}

// ===== สร้าง embed Top 10 (ใช้ได้ทั้ง /topinvite และตัวรีเฟรช 10 นาที) =====
async function buildTopInviteEmbed(guild) {
  const snap = await db
    .collection(CONFIG_COL)
    .doc(guild.id)
    .collection(STATS_SUB)
    .orderBy("count", "desc")
    .limit(10)
    .get();

  if (snap.empty) return null;

  const rows = [];
  let rank = 1;

  for (const doc of snap.docs) {
    const inviterId = doc.id;
    const data = doc.data() || {};
    const count = data.count || 0;

    let name = `<@${inviterId}>`;
    try {
      const member = await guild.members.fetch(inviterId).catch(() => null);
      if (member?.user) {
        name = `${member.user.tag}`;
      }
    } catch (_) {}

    const line = `\`${String(rank).padStart(2, " ")}.\` ${name} — **${count}** คน`;
    rows.push(line);
    rank++;
  }

  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle("Top 10 คำเชิญในเซิร์ฟเวอร์นี้")
    .setDescription(rows.join("\n"))
    .setTimestamp();

  return embed;
}

module.exports = (client) => {
  // ====== ลงทะเบียน Slash Commands + ตั้ง cron รีเฟรชทุก 10 นาที ======
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("invite")
          .setDescription(
            "ตั้งค่า Title/Description สำหรับรายงานคนเข้ามาใหม่ (รองรับ @user/@invite/@count)"
          )
          .setDMPermission(false)
          .setDefaultMemberPermissions(
            PermissionsBitField.Flags.Administrator
          )
          .toJSON()
      );

      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("topinvite")
          .setDescription("แสดงอันดับ Top 10 คนเชิญเพื่อนในเซิร์ฟเวอร์นี้")
          .setDMPermission(false)
          .setDefaultMemberPermissions(
            PermissionsBitField.Flags.Administrator // ✅ เฉพาะแอดมิน
          )
          .toJSON()
      );

      console.log("✅ Registered /invite & /topinvite");
    } catch (e) {
      console.error("❌ Register commands failed:", e);
    }

    // 🔁 รีเฟรช Top 10 ทุก 10 นาที
    setInterval(async () => {
      try {
        for (const guild of client.guilds.cache.values()) {
          const cfg = await getGuildConfig(guild.id);
          if (!cfg || !cfg.topInviteChannelId || !cfg.topInviteMessageId) {
            continue;
          }

          const channel = guild.channels.cache.get(cfg.topInviteChannelId);
          if (!channel || !channel.isTextBased()) continue;

          let message;
          try {
            message = await channel.messages
              .fetch(cfg.topInviteMessageId)
              .catch(() => null);
          } catch {
            message = null;
          }
          if (!message) continue;

          const embed = await buildTopInviteEmbed(guild);
          if (!embed) continue;

          await message.edit({ embeds: [embed] }).catch(() => {});
        }
      } catch (e) {
        console.error("❌ topinvite refresh error:", e);
      }
    }, 10 * 60 * 1000); // 10 นาที
  });

  // ====== Chat Input Commands ======
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // ----- /invite -----
    if (interaction.commandName === "invite") {
      try {
        if (!isAdmin(interaction)) {
          return interaction.reply({
            content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน",
            ephemeral: true,
          });
        }

        const me = interaction.guild?.members?.me;
        if (!me?.permissions?.has(PermissionsBitField.Flags.ManageGuild)) {
          return interaction.reply({
            content:
              "❌ บอทต้องการสิทธิ์ **Manage Guild** เพื่ออ่าน/ติดตามลิงก์เชิญ",
            ephemeral: true,
          });
        }

        const modal = new ModalBuilder()
          .setCustomId(IDS.MODAL)
          .setTitle("ตั้งค่า Invite Message");

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
          new ActionRowBuilder().addComponents(iDesc)
        );

        await interaction.showModal(modal);
      } catch (e) {
        console.error("❌ open /invite modal error:", e);
        try {
          if (!interaction.deferred && !interaction.replied) {
            await interaction.reply({
              content: "เกิดข้อผิดพลาด",
              ephemeral: true,
            });
          }
        } catch (_) {}
      }
      return;
    }

    // ----- /topinvite -----
    if (interaction.commandName === "topinvite") {
      try {
        if (!isAdmin(interaction)) {
          return interaction.reply({
            content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน",
            ephemeral: true,
          });
        }

        const guild = interaction.guild;
        if (!guild) {
          return interaction.reply({
            content: "ใช้คำสั่งนี้ในเซิร์ฟเวอร์เท่านั้น",
            ephemeral: true,
          });
        }

        await interaction.deferReply({ ephemeral: false });

        const embed = await buildTopInviteEmbed(guild);
        if (!embed) {
          return interaction.editReply("ยังไม่มีข้อมูลการเชิญเพื่อนเลยน้า");
        }

        const msg = await interaction.editReply({ embeds: [embed] });

        // บันทึก message นี้ไว้เป็น "บอร์ด Top 10" สำหรับรีเฟรชทุก 10 นาที
        const patch = {
          topInviteChannelId: msg.channelId,
          topInviteMessageId: msg.id,
        };

        await db
          .collection(CONFIG_COL)
          .doc(guild.id)
          .set(patch, { merge: true });

        const existing = (configCache.get(guild.id) || {});
        configCache.set(guild.id, { ...existing, ...patch });
      } catch (e) {
        console.error("❌ /topinvite error:", e);
        try {
          if (interaction.deferred || interaction.replied) {
            await interaction.editReply(
              "❌ เกิดข้อผิดพลาดในการดึงอันดับเชิญเพื่อน"
            );
          } else {
            await interaction.reply({
              content: "❌ เกิดข้อผิดพลาดในการดึงอันดับเชิญเพื่อน",
              ephemeral: true,
            });
          }
        } catch (_) {}
      }
    }
  });

  // ====== Modal Submit (/invite) ======
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId !== IDS.MODAL) return;

    try {
      if (!isAdmin(interaction)) {
        return interaction.reply({
          content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน",
          ephemeral: true,
        });
      }

      const guild = interaction.guild;
      const channel = interaction.channel;

      const titleTpl = interaction.fields
        .getTextInputValue(IDS.INPUT_TITLE)
        .trim();
      const descTpl = interaction.fields
        .getTextInputValue(IDS.INPUT_DESC)
        .trim();

      const data = {
        channelId: channel.id,
        titleTpl,
        descTpl,
      };

      await db.collection(CONFIG_COL).doc(guild.id).set(data, { merge: true });
      const existing = configCache.get(guild.id) || {};
      configCache.set(guild.id, { ...existing, ...data });

      await ensureCachePrimed(guild);

      await interaction.deferUpdate().catch(() => {});
    } catch (e) {
      console.error("❌ save invite template error:", e);
      try {
        if (!interaction.deferred && !interaction.replied) {
          await interaction.reply({
            content: "❌ เกิดข้อผิดพลาด กรุณาลองใหม่",
            ephemeral: true,
          });
        }
      } catch (_) {}
    }
  });

  // ====== อัปเดต cache เมื่อสร้าง/ลบ invite ======
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

  // ====== เมื่อมีคนเข้าเซิร์ฟเวอร์ ======
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const guild = member.guild;

      const cfg = await getGuildConfig(guild.id);
      if (!cfg) return;

      const reportChannel = guild.channels.cache.get(cfg.channelId);
      if (!reportChannel || !reportChannel.isTextBased()) return;

      await ensureCachePrimed(guild);

      const oldMap = getGuildCache(guild.id);
      const newMap = await fetchInvitesMap(guild);
      invitesCache.set(guild.id, newMap);

      const used = diffInvites(oldMap, newMap);

      const inviterId = used?.inviterId || null;
      const type = used?.kind || "unknown";
      const uses = used?.uses ?? null;

      if (inviterId) {
        bumpInviteStats(guild.id, inviterId).catch(() => {});
      }

      const userMention = `<@${member.id}>`;
      const inviteText =
        inviterId ? `<@${inviterId}>` : type === "vanity" ? "vanity" : "ไม่ทราบ";
      const countText = uses != null ? String(uses) : "—";

      const title =
        renderTemplate(cfg.titleTpl, {
          userMention,
          inviteText,
          countText,
        }) || "Welcome";
      const description =
        renderTemplate(cfg.descTpl, {
          userMention,
          inviteText,
          countText,
        }) || "";

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
