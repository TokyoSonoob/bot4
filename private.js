// private.js
// /private → เลือกห้องเสียงต้นทาง; เมื่อมีคนเข้าห้องนั้น จะสร้าง "ห้องส่วนตัวของ_{User}" ใต้หมวดเดียวกัน และย้ายคนเข้าไปให้
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  Events,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");
const { db, admin } = require("./firebase"); // ต้องมี firebase.js ที่ export { db, admin }

const COLLECTION = "privateVoiceConfig"; // Firestore: per-guild config

// cache config ในหน่วยความจำ: Map<guildId, { baseVoiceId }>
const configCache = new Map();
// กัน Trigger ซ้ำ (voiceStateUpdate ที่มารัว ๆ)
const processingJoin = new Set();

const IDS = {
  SELECT_BASE: "private_select_base_voice",
};

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

module.exports = (client) => {
  // ---------- 1) ลงทะเบียน /private (เฉพาะแอดมิน) ----------
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("private")
          .setDescription("สร้างห้องส่วนตัวอัตโนมัติ")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) // ✅ แอดมินเท่านั้น
          .toJSON()
      );
      console.log("✅ Registered /private");

      // prime cache จาก Firestore (กิลด์ที่บอทอยู่)
      for (const [gid] of client.guilds.cache) {
        try {
          const doc = await db.collection(COLLECTION).doc(gid).get();
          if (doc.exists) {
            const data = doc.data();
            if (data?.baseVoiceId) configCache.set(gid, { baseVoiceId: data.baseVoiceId });
          }
        } catch (_) {}
      }
    } catch (e) {
      console.error("❌ Register /private failed:", e);
    }
  });

  // ---------- 2) /private → ส่ง Embed + Select เลือกห้องเสียง ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "private") return;

    try {
      if (!isAdmin(interaction)) {
        return interaction.reply({ content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน", ephemeral: true });
      }

      const me = interaction.guild?.members?.me;
      const needPerms = [
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.MoveMembers,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.ViewChannel,
      ];
      for (const p of needPerms) {
        if (!me?.permissions?.has(p)) {
          return interaction.reply({
            content: "❌ บอทต้องการสิทธิ์ Manage Channels, Move Members, Connect, View Channel",
            ephemeral: true,
          });
        }
      }

      // รวบรวม "ห้องเสียง" เฉพาะ GuildVoice (ไม่รวม Stage)
      const voices = [...interaction.guild.channels.cache.values()]
        .filter((ch) => ch.type === ChannelType.GuildVoice)
        .sort((a, b) => {
          const pa = interaction.guild.channels.cache.get(a.parentId || "")?.position ?? -1;
          const pb = interaction.guild.channels.cache.get(b.parentId || "")?.position ?? -1;
          if (pa !== pb) return pa - pb;
          return a.position - b.position;
        });

      if (voices.length === 0) {
        return interaction.reply({ content: "⚠️ เซิร์ฟเวอร์นี้ยังไม่มีห้องเสียง (Voice Channel)", ephemeral: true });
      }

      const limited = voices.slice(0, 25); // StringSelect สูงสุด 25
      const select = new StringSelectMenuBuilder()
        .setCustomId(IDS.SELECT_BASE)
        .setPlaceholder("เลือกห้องเสียงต้นทาง")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
          limited.map((v) => {
            const cat = interaction.guild.channels.cache.get(v.parentId || "")?.name || "ไม่มีหมวด";
            return {
              label: `[${cat}] ${v.name}`.slice(0, 100),
              value: v.id,
            };
          })
        );

      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle("ตั้งค่าห้องส่วนตัวอัตโนมัติ")
        .setDescription("เลือก **ห้องเสียงต้นทาง** ที่ต้องการ");

      await interaction.reply({
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(select)],
        ephemeral: true,
      });
    } catch (e) {
      console.error("❌ /private error:", e);
      if (interaction.isRepliable()) {
        interaction.reply({ content: "เกิดข้อผิดพลาด", ephemeral: true }).catch(() => {});
      }
    }
  });

  // ---------- 3) เลือกห้องเสียงจาก Select ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    if (interaction.customId !== IDS.SELECT_BASE) return;

    try {
      if (!isAdmin(interaction)) {
        return interaction.reply({ content: "❌ คำสั่งนี้สำหรับแอดมินเท่านั้น", ephemeral: true });
      }

      const [voiceId] = interaction.values;
      const voice = interaction.guild.channels.cache.get(voiceId);
      if (!voice || voice.type !== ChannelType.GuildVoice) {
        return interaction.reply({ content: "❌ ห้องเสียงไม่ถูกต้องหรือไม่พบ", ephemeral: true });
      }

      // บันทึก Firestore + อัปเดต cache
      await db.collection(COLLECTION).doc(interaction.guild.id).set({
        baseVoiceId: voice.id,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      configCache.set(interaction.guild.id, { baseVoiceId: voice.id });

      await interaction.reply({
        content: `✅ ตั้งค่าห้องเสียงต้นทางเป็น **${voice.name}** เรียบร้อย`,
        ephemeral: true,
      });
    } catch (e) {
      console.error("❌ save private base error:", e);
      if (interaction.isRepliable())
        interaction.reply({ content: "❌ เกิดข้อผิดพลาด กรุณาลองใหม่", ephemeral: true }).catch(() => {});
    }
  });

  // ---------- 4) สร้างห้องส่วนตัวเมื่อมีคนเข้า base voice & ลบเมื่อว่าง ----------
  client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
      const guild = newState.guild || oldState.guild;
      if (!guild) return;
      if (newState.member?.user?.bot) return;

      // โหลด config จาก cache → ถ้าไม่มี ลองโหลดจาก DB 1 ครั้ง
      let cfg = configCache.get(guild.id);
      if (!cfg) {
        try {
          const doc = await db.collection(COLLECTION).doc(guild.id).get();
          if (doc.exists) {
            cfg = { baseVoiceId: doc.data()?.baseVoiceId };
            if (cfg?.baseVoiceId) configCache.set(guild.id, cfg);
          }
        } catch (_) {}
      }

      // ---- A) ลบห้องส่วนตัวเมื่อว่าง ----
      const leftCh = oldState.channel;
      if (leftCh && leftCh.type === ChannelType.GuildVoice) {
        const isPrivateName = typeof leftCh.name === "string" && leftCh.name.startsWith("ห้องส่วนตัวของ_");
        if (isPrivateName && leftCh.members.size === 0) {
          try {
            await leftCh.delete("Auto-delete private room when empty");
          } catch (e) {
            console.warn("cannot delete empty private room:", e?.message || e);
          }
        }
      }

      // ไม่มีการตั้งค่า base ก็พอแค่นี้
      if (!cfg?.baseVoiceId) return;

      // ---- B) ถ้าเพิ่งเข้าห้อง base → สร้างห้องและย้าย ----
      const joinedBase =
        newState.channelId &&
        newState.channelId === cfg.baseVoiceId &&
        oldState.channelId !== cfg.baseVoiceId;
      if (!joinedBase) return;

      const base = newState.channel;
      if (!base || base.type !== ChannelType.GuildVoice) return;

      // กัน Trigger ซ้ำช่วงสั้น ๆ ต่อ user
      const key = `${guild.id}:${newState.id}`;
      if (processingJoin.has(key)) return;
      processingJoin.add(key);
      setTimeout(() => processingJoin.delete(key), 3000);

      const me = guild.members.me;
      const needPerms = [
        PermissionsBitField.Flags.ManageChannels,
        PermissionsBitField.Flags.MoveMembers,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.ViewChannel,
      ];
      for (const p of needPerms) {
        if (!me?.permissions?.has(p)) return;
      }

      // ค่าพื้นฐานจากห้อง base
      const parentId = base.parentId ?? null;
      const basePos = base.position;
      const bitrate = base.bitrate;
      const user = newState.member.user;
      const privateName = `ห้องส่วนตัวของ_${user.username}`;

      // สร้างห้องใหม่ ใต้หมวดเดียวกัน + ปรับ Permission ให้เป็นส่วนตัว
      const created = await guild.channels.create({
        name: privateName.slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: parentId ?? undefined,
        bitrate,
        reason: `Auto private voice for ${user.tag}`,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [
              PermissionsBitField.Flags.Connect,
              PermissionsBitField.Flags.ViewChannel,
            ],
          },
          {
            id: user.id,
            allow: [
              PermissionsBitField.Flags.Connect,
              PermissionsBitField.Flags.ViewChannel,
              PermissionsBitField.Flags.Speak,
              PermissionsBitField.Flags.Stream,
              PermissionsBitField.Flags.UseVAD,
            ],
          },
        ],
      });

      // วางตำแหน่งถัดจากห้อง base
      try { await created.setPosition(basePos + 1); } catch (_) {}

      // ย้ายผู้ใช้เข้าไป
      try {
        await newState.setChannel(created, "Move to private voice");
      } catch (e) {
        console.warn("move member to private failed:", e?.message || e);
      }
    } catch (e) {
      console.error("❌ VoiceStateUpdate error:", e);
    }
  });
};
