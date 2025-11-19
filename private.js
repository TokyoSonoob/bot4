// private.js
// /private → เลือกห้องเสียงต้นทาง; เมื่อมีคนเข้าห้องนั้น จะสร้างห้องส่วนตัวใต้หมวดเดียวกัน ย้ายคนเข้าไป และมีปุ่มควบคุมห้อง
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
// เก็บ id ห้อง private ที่บอทสร้างเอง
const privateChannels = new Set();
// เก็บเจ้าของห้อง: Map<voiceChannelId, ownerUserId>
const privateOwners = new Map();

const IDS = {
  SELECT_BASE: "private_select_base_voice",
};

const CONTROL_PREFIX = {
  SET_LIMIT_BUTTON: "private_set_limit_",      // + channelId
  LIMIT_MODAL: "private_limit_modal_",         // + channelId
  KICK_BUTTON: "private_kick_",                // + channelId
  KICK_SELECT: "private_kick_select_",         // + channelId
};

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

function isRoomController(interaction, channelId) {
  const ownerId = privateOwners.get(channelId);
  if (interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) return true;
  if (!ownerId) return false;
  return interaction.user.id === ownerId;
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
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
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

      const voices = [...interaction.guild.channels.cache.values()]
        .filter((ch) => ch.type === ChannelType.GuildVoice)
        .sort((a, b) => {
          const pa = interaction.guild.channels.cache.get(a.parentId || "")?.position ?? -1;
          const pb = interaction.guild.channels.cache.get(b.parentId || "")?.position ?? -1;
          if (pa !== pb) return pa - pb;
          return a.position - b.position;
        });

      if (voices.length === 0) {
        return interaction.reply({
          content: "⚠️ เซิร์ฟเวอร์นี้ยังไม่มีห้องเสียง (Voice Channel)",
          ephemeral: true,
        });
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

  // ---------- 3) เลือกห้องเสียงจาก Select (/private) ----------
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

      await db.collection(COLLECTION).doc(interaction.guild.id).set(
        {
          baseVoiceId: voice.id,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

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

  // ---------- 4) ปุ่ม + Modal ควบคุมห้อง (ตั้งจำนวนคน / เตะสมาชิก) ----------
  client.on(Events.InteractionCreate, async (interaction) => {
    // ปุ่มตั้งจำนวนคน
    if (interaction.isButton() && interaction.customId.startsWith(CONTROL_PREFIX.SET_LIMIT_BUTTON)) {
      const channelId = interaction.customId.slice(CONTROL_PREFIX.SET_LIMIT_BUTTON.length);
      const channel = interaction.guild.channels.cache.get(channelId);

      if (!channel || channel.type !== ChannelType.GuildVoice) {
        return interaction.reply({ content: "❌ ไม่พบห้องเสียงนี้แล้ว", ephemeral: true });
      }

      if (!isRoomController(interaction, channelId)) {
        return interaction.reply({
          content: "❌ ปุ่มนี้ใช้ได้เฉพาะเจ้าของห้องหรือแอดมิน",
          ephemeral: true,
        });
      }

      const modal = new ModalBuilder()
        .setCustomId(CONTROL_PREFIX.LIMIT_MODAL + channelId)
        .setTitle("ตั้งจำนวนคนสูงสุดของห้องนี้");

      const input = new TextInputBuilder()
        .setCustomId("max_users")
        .setLabel("จำนวนคนสูงสุด (1-99) — ใส่ 2 สำหรับห้อง 2 คน")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("เช่น 2 หรือ 5");

      const row = new ActionRowBuilder().addComponents(input);
      modal.addComponents(row);

      return interaction.showModal(modal);
    }

    // ปุ่มเตะสมาชิก
    if (interaction.isButton() && interaction.customId.startsWith(CONTROL_PREFIX.KICK_BUTTON)) {
      const channelId = interaction.customId.slice(CONTROL_PREFIX.KICK_BUTTON.length);
      const channel = interaction.guild.channels.cache.get(channelId);

      if (!channel || channel.type !== ChannelType.GuildVoice) {
        return interaction.reply({ content: "❌ ไม่พบห้องเสียงนี้แล้ว", ephemeral: true });
      }

      if (!isRoomController(interaction, channelId)) {
        return interaction.reply({
          content: "❌ ปุ่มนี้ใช้ได้เฉพาะเจ้าของห้องหรือแอดมิน",
          ephemeral: true,
        });
      }

      const members = channel.members.filter(
        (m) => !m.user.bot && m.id !== interaction.user.id
      );

      if (!members.size) {
        return interaction.reply({
          content: "⚠️ ไม่มีสมาชิกอื่นในห้องให้เตะ",
          ephemeral: true,
        });
      }

      const options = members.map((m) => ({
        label: (m.displayName || m.user.username).slice(0, 100),
        value: m.id,
      }));

      const select = new StringSelectMenuBuilder()
        .setCustomId(CONTROL_PREFIX.KICK_SELECT + channelId)
        .setPlaceholder("เลือกสมาชิกที่จะเตะออก (เลือกได้หลายคน)")
        .setMinValues(1)
        .setMaxValues(Math.min(options.length, 25))
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(select);

      return interaction.reply({
        content: "เลือกสมาชิกที่จะเตะออกจากห้องเสียงนี้",
        components: [row],
        ephemeral: true,
      });
    }

    // Modal ตั้งจำนวนคน
    if (interaction.isModalSubmit() && interaction.customId.startsWith(CONTROL_PREFIX.LIMIT_MODAL)) {
      const channelId = interaction.customId.slice(CONTROL_PREFIX.LIMIT_MODAL.length);
      const channel = interaction.guild.channels.cache.get(channelId);

      if (!channel || channel.type !== ChannelType.GuildVoice) {
        return interaction.reply({ content: "❌ ไม่พบห้องเสียงนี้แล้ว", ephemeral: true });
      }

      if (!isRoomController(interaction, channelId)) {
        return interaction.reply({
          content: "❌ ฟอร์มนี้ใช้ได้เฉพาะเจ้าของห้องหรือแอดมิน",
          ephemeral: true,
        });
      }

      const raw = interaction.fields.getTextInputValue("max_users");
      const n = parseInt(raw, 10);

      if (Number.isNaN(n) || n < 1) {
        return interaction.reply({
          content: "❌ กรุณาใส่ตัวเลขจำนวนเต็มตั้งแต่ 1 ขึ้นไป",
          ephemeral: true,
        });
      }

      const limit = Math.max(1, Math.min(n, 99));

      try {
        await channel.setUserLimit(limit);
        return interaction.reply({
          content: `✅ ตั้งจำนวนคนสูงสุดของห้องนี้เป็น **${limit} คน** แล้ว`,
          ephemeral: true,
        });
      } catch (e) {
        console.error("setUserLimit error:", e);
        return interaction.reply({
          content: "❌ ตั้งจำนวนคนไม่สำเร็จ กรุณาลองใหม่",
          ephemeral: true,
        });
      }
    }

    // เมนูเลือกสมาชิกที่จะเตะ
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith(CONTROL_PREFIX.KICK_SELECT)) {
      const channelId = interaction.customId.slice(CONTROL_PREFIX.KICK_SELECT.length);
      const channel = interaction.guild.channels.cache.get(channelId);

      if (!channel || channel.type !== ChannelType.GuildVoice) {
        return interaction.update({
          content: "❌ ไม่พบห้องเสียงนี้แล้ว",
          components: [],
        });
      }

      if (!isRoomController(interaction, channelId)) {
        return interaction.update({
          content: "❌ ใช้เมนูนี้ได้เฉพาะเจ้าของห้องหรือแอดมิน",
          components: [],
        });
      }

      const targets = interaction.values || [];

      let success = 0;
      for (const uid of targets) {
        try {
          const member = await interaction.guild.members.fetch(uid).catch(() => null);
          if (!member || !member.voice || member.voice.channelId !== channel.id) continue;
          await member.voice.setChannel(null, "Kicked from private room");
          success++;
        } catch (_) {}
      }

      return interaction.update({
        content:
          success > 0
            ? `✅ เตะสมาชิกออกจากห้องแล้ว ${success} คน`
            : "⚠️ ไม่พบใครในห้องให้เตะ",
        components: [],
      });
    }
  });

  // ---------- 5) สร้างห้องส่วนตัวเมื่อมีคนเข้า base voice & ลบเมื่อว่าง ----------
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
        const isPrivateRoom =
          privateChannels.has(leftCh.id) ||
          (typeof leftCh.name === "string" && leftCh.name.startsWith("ห้องส่วนตัวของ_"));

        if (isPrivateRoom && leftCh.members.size === 0) {
          try {
            await leftCh.delete("Auto-delete private room when empty");
            privateChannels.delete(leftCh.id);
            privateOwners.delete(leftCh.id);
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

      const parentId = base.parentId ?? null;
      const basePos = base.position;
      const bitrate = base.bitrate;
      const user = newState.member.user;

      // ชื่อห้อง private = ชื่อเหมือนห้องหลัก
      const privateName = base.name;

      // สร้างห้องใหม่ ใต้หมวดเดียวกัน + ปรับ Permission ให้เป็นส่วนตัว + จำกัด 2 คนเริ่มต้น
      const created = await guild.channels.create({
        name: privateName.slice(0, 100),
        type: ChannelType.GuildVoice,
        parent: parentId ?? undefined,
        bitrate,
        userLimit: 2, // เริ่มต้นห้อง 2 คน
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

      privateChannels.add(created.id);
      privateOwners.set(created.id, user.id);

      // วางตำแหน่งถัดจากห้อง base
      try {
        await created.setPosition(basePos + 1);
      } catch (_) {}

      // ส่ง embed ควบคุมห้องในแชทของห้องเสียง
      try {
        const controlEmbed = new EmbedBuilder()
          .setColor(0x9b59b6)
          .setTitle(`ควบคุมห้อง: ${created.name}`)
          .setDescription(
            [
              `เจ้าของห้อง: <@${user.id}>`,
            ].join("\n")
          );

        const controlRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(CONTROL_PREFIX.SET_LIMIT_BUTTON + created.id)
            .setLabel("ตั้งจำนวนคน")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId(CONTROL_PREFIX.KICK_BUTTON + created.id)
            .setLabel("เตะสมาชิก")
            .setStyle(ButtonStyle.Danger)
        );

        await created.send({
          embeds: [controlEmbed],
          components: [controlRow],
        }).catch(() => {});
      } catch (_) {}

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
