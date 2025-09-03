// delete.js
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  ChannelType,
  PermissionsBitField,
  MessageFlags,
} = require("discord.js");

/** ตอบแบบ ephemeral โดยใช้ flags พร้อม fallback */
async function safeReply(interaction, options) {
  const payload = { ...options };
  try {
    if (payload.ephemeral) delete payload.ephemeral;
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

module.exports = (client) => {
  const allowedUsers = [
    "849964668177088562",
    "571999000237178881",
    "1010202066720936048",
  ];

  const pendingGroupSelections = new Map(); // userId -> string[] categoryIds
  const pendingRoomSelections = new Map();  // userId -> { categoryId, channelIds: string[] }

  const IDS = {
    CMD_DELETE_GROUP: "delete_group",
    CMD_DELETE_ROOM: "delete_room",
    SELECT_GROUPS: "delete_select_groups",
    BTN_GROUP_CONFIRM: "delete_groups_confirm",
    BTN_GROUP_CANCEL: "delete_groups_cancel",
    SELECT_CATEGORY_FOR_ROOMS: "delete_select_category_for_rooms",
    SELECT_ROOMS: "delete_select_rooms",
    BTN_ROOMS_CONFIRM: "delete_rooms_confirm",
    BTN_ROOMS_CANCEL: "delete_rooms_cancel",
  };

  // 1) ลงทะเบียน /delete group|room
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("delete")
          .setDescription("ลบหมวดหมู่หรือห้อง")
          .addSubcommand((sc) => sc.setName("group").setDescription("ลบหมวดหมู่"))
          .addSubcommand((sc) => sc.setName("room").setDescription("ลบห้อง"))
          .setDMPermission(false)
          .toJSON()
      );
      console.log("✅ Registered /delete group, /delete room");
    } catch (e) {
      console.error("❌ Register /delete failed:", e);
    }
  });

  // 2) entry /delete
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "delete") return;
    const sub = interaction.options.getSubcommand();

    if (!allowedUsers.includes(interaction.user.id)) {
      return safeReply(interaction, { content: "❌ คุณไม่มีสิทธิ์ใช้คำสั่งนี้" });
    }
    const me = interaction.guild?.members?.me;
    if (!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
      return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ Manage Channels" });
    }

    if (sub === "group") {
      // ✅ เรียงตามตำแหน่งจริงในเซิร์ฟเวอร์
      const categoriesAll = [...interaction.guild.channels.cache.values()]
        .filter((ch) => ch.type === ChannelType.GuildCategory)
        .sort((a, b) => a.rawPosition - b.rawPosition);

      const categories = categoriesAll.slice(0, 25);

      if (categories.length === 0) {
        return safeReply(interaction, { content: "⚠️ ไม่มีหมวดหมู่ (Category) ให้ลบ" });
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId(IDS.SELECT_GROUPS)
        .setPlaceholder("เลือกหมวดหมู่ที่จะลบ")
        .setMinValues(1)
        .setMaxValues(categories.length)
        .addOptions(categories.map((c) => ({ label: c.name.slice(0, 100), value: c.id })));

      const row = new ActionRowBuilder().addComponents(select);
      await safeReply(interaction, {
        content:
          categoriesAll.length > 25
            ? `เลือกหมวดหมู่ที่จะลบ (แสดงได้สูงสุด 25 จากทั้งหมด ${categoriesAll.length}) แล้วกด **ยืนยัน**`
            : "เลือกหมวดหมู่ที่จะลบ แล้วกด **ยืนยัน**",
        components: [row],
      });
    }

    if (sub === "room") {
      // ✅ เรียงหมวดหมู่ตามตำแหน่งจริง
      const categoriesAll = [...interaction.guild.channels.cache.values()]
        .filter((ch) => ch.type === ChannelType.GuildCategory)
        .sort((a, b) => a.rawPosition - b.rawPosition);

      const categories = categoriesAll.slice(0, 25);

      if (categories.length === 0) {
        return safeReply(interaction, { content: "ไม่มีหมวดหมู่ (Category) ในเซิร์ฟเวอร์นี้" });
      }

      const selectCat = new StringSelectMenuBuilder()
        .setCustomId(IDS.SELECT_CATEGORY_FOR_ROOMS)
        .setPlaceholder("เลือกหมวดหมู่ก่อน")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(categories.map((c) => ({ label: c.name.slice(0, 100), value: c.id })));

      const row = new ActionRowBuilder().addComponents(selectCat);
      await safeReply(interaction, {
        content:
          categoriesAll.length > 25
            ? `เลือกหมวดหมู่ที่จะลบ **ห้อง** (แสดงได้สูงสุด 25 จากทั้งหมด ${categoriesAll.length})`
            : "เลือกหมวดหมู่ที่จะลบ **ห้อง** ข้างใน",
        components: [row],
      });
    }
  });

  // 3) select handlers
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;

    // /delete group → select groups
    if (interaction.customId === IDS.SELECT_GROUPS) {
      if (!allowedUsers.includes(interaction.user.id)) {
        return safeReply(interaction, { content: "❌ คุณไม่มีสิทธิ์" });
      }

      const categoryIds = interaction.values || [];
      if (categoryIds.length === 0) {
        return safeReply(interaction, { content: "กรุณาเลือกอย่างน้อย 1 หมวดหมู่" });
      }

      pendingGroupSelections.set(interaction.user.id, categoryIds);

      const confirm = new ButtonBuilder()
        .setCustomId(IDS.BTN_GROUP_CONFIRM)
        .setStyle(ButtonStyle.Danger)
        .setLabel("ลบหมวดหมู่");
      const cancel = new ButtonBuilder()
        .setCustomId(IDS.BTN_GROUP_CANCEL)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("ยกเลิก");
      const row = new ActionRowBuilder().addComponents(confirm, cancel);

      const names = categoryIds
        .map((id) => interaction.guild.channels.cache.get(id)?.name || id)
        .map((n) => `• ${n}`)
        .join("\n")
        .slice(0, 1700);

      await safeReply(interaction, {
        content:
          `หมวดหมู่ที่จะลบ:\n${names}\n\nโปรดกดยืนยันเพื่อลบ`,
        components: [row],
      });
    }

    // /delete room → select category then list rooms
    if (interaction.customId === IDS.SELECT_CATEGORY_FOR_ROOMS) {
      if (!allowedUsers.includes(interaction.user.id)) {
        return safeReply(interaction, { content: "❌ คุณไม่มีสิทธิ์" });
      }

      const [categoryId] = interaction.values;
      const category = interaction.guild.channels.cache.get(categoryId);
      if (!category || category.type !== ChannelType.GuildCategory) {
        return safeReply(interaction, { content: "❌ หมวดหมู่ไม่ถูกต้องหรือไม่พบ" });
      }

      // ✅ เรียงห้องลูกตามตำแหน่งจริงใต้หมวดนั้น
      const childrenAll = [...interaction.guild.channels.cache.values()]
        .filter((ch) => ch.parentId === category.id && ch.type !== ChannelType.GuildCategory)
        .sort((a, b) => a.rawPosition - b.rawPosition);

      if (childrenAll.length === 0) {
        return safeReply(interaction, { content: `หมวดหมู่ **${category.name}** ไม่มีห้องให้ลบ` });
      }

      const children = childrenAll.slice(0, 25);
      const options = children.map((ch) => ({
        label: `${ch.name}`.slice(0, 100),
        value: ch.id,
      }));

      pendingRoomSelections.set(interaction.user.id, { categoryId, channelIds: [] });

      const selectRooms = new StringSelectMenuBuilder()
        .setCustomId(IDS.SELECT_ROOMS)
        .setPlaceholder(`เลือกห้องใน "${category.name}" เพื่อลบ`)
        .setMinValues(1)
        .setMaxValues(options.length)
        .addOptions(options);

      const row = new ActionRowBuilder().addComponents(selectRooms);
      await safeReply(interaction, {
        content:
          childrenAll.length > 25
            ? `เลือกห้องภายใต้หมวดหมู่ **${category.name}** (แสดงได้สูงสุด 25 จากทั้งหมด ${childrenAll.length})`
            : `เลือกห้องภายใต้หมวดหมู่ **${category.name}** เพื่อลบ`,
        components: [row],
      });
    }

    // /delete room → select rooms
    if (interaction.customId === IDS.SELECT_ROOMS) {
      if (!allowedUsers.includes(interaction.user.id)) {
        return safeReply(interaction, { content: "❌ คุณไม่มีสิทธิ์" });
      }

      const current = pendingRoomSelections.get(interaction.user.id);
      if (!current?.categoryId) {
        return safeReply(interaction, { content: "ขั้นตอนหมดอายุ/ข้อมูลหายไป กรุณาเริ่มใหม่" });
      }

      const channelIds = interaction.values || [];
      if (channelIds.length === 0) {
        return safeReply(interaction, { content: "กรุณาเลือกห้องอย่างน้อย 1 ห้อง" });
      }

      current.channelIds = channelIds;
      pendingRoomSelections.set(interaction.user.id, current);

      const confirm = new ButtonBuilder()
        .setCustomId(IDS.BTN_ROOMS_CONFIRM)
        .setStyle(ButtonStyle.Danger)
        .setLabel("ลบห้อง");
      const cancel = new ButtonBuilder()
        .setCustomId(IDS.BTN_ROOMS_CANCEL)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("ยกเลิก");
      const row = new ActionRowBuilder().addComponents(confirm, cancel);

      const names = channelIds
        .map((id) => interaction.guild.channels.cache.get(id)?.name || id)
        .map((n) => `• ${n}`)
        .join("\n")
        .slice(0, 1700);

      await safeReply(interaction, {
        content: `ห้องที่จะลบ:\n${names}\n\n`,
        components: [row],
      });
    }
  });

  // 4) ปุ่มยืนยัน/ยกเลิก
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    // --- GROUP CONFIRM ---
    if (interaction.customId === IDS.BTN_GROUP_CONFIRM) {
      if (!allowedUsers.includes(interaction.user.id)) {
        return safeReply(interaction, { content: "❌ คุณไม่มีสิทธิ์" });
      }
      const me = interaction.guild?.members?.me;
      if (!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
        return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ Manage Channels" });
      }

      await interaction.deferReply({ ephemeral: true }); // ✅ กัน timeout

      const ids = pendingGroupSelections.get(interaction.user.id) || [];
      pendingGroupSelections.delete(interaction.user.id);

      if (ids.length === 0) {
        return interaction.editReply({ content: "ไม่มีรายการให้ลบ" });
      }

      const results = [];
      for (const id of ids) {
        const cat = interaction.guild.channels.cache.get(id);
        if (!cat || cat.type !== ChannelType.GuildCategory) {
          results.push(`• ❌ ไม่พบ/ไม่ใช่หมวดหมู่: \`${id}\``);
          continue;
        }
        try {
          await cat.delete(`Deleted by ${interaction.user.tag}`);
          results.push(`• ✅ ลบหมวดหมู่: **${cat.name}**`);
        } catch (e) {
          console.error("delete category error:", e);
          results.push(`• ❌ ล้มเหลว: **${cat.name}**`);
        }
      }

      const summary = [
        `🗑️ สรุปการลบหมวดหมู่: **${results.filter((r) => r.includes("✅")).length}/${ids.length}** สำเร็จ`,
        ...results,
      ]
        .join("\n")
        .slice(0, 1900);

      return interaction.editReply({ content: summary });
    }

    if (interaction.customId === IDS.BTN_GROUP_CANCEL) {
      pendingGroupSelections.delete(interaction.user.id);
      return safeReply(interaction, { content: "ยกเลิกการลบหมวดหมู่แล้ว" });
    }

    // --- ROOMS CONFIRM ---
    if (interaction.customId === IDS.BTN_ROOMS_CONFIRM) {
      if (!allowedUsers.includes(interaction.user.id)) {
        return safeReply(interaction, { content: "❌ คุณไม่มีสิทธิ์" });
      }
      const me = interaction.guild?.members?.me;
      if (!me?.permissions?.has(PermissionsBitField.Flags.ManageChannels)) {
        return safeReply(interaction, { content: "❌ บอทไม่มีสิทธิ์ Manage Channels" });
      }

      await interaction.deferReply({ ephemeral: true }); // ✅ กัน timeout

      const data = pendingRoomSelections.get(interaction.user.id);
      pendingRoomSelections.delete(interaction.user.id);
      if (!data?.channelIds?.length) {
        return interaction.editReply({ content: "ไม่มีห้องให้ลบ" });
      }

      const results = [];
      for (const id of data.channelIds) {
        const ch = interaction.guild.channels.cache.get(id);
        if (!ch || ch.type === ChannelType.GuildCategory) {
          results.push(`• ❌ ไม่ใช่ห้องที่ลบได้: \`${id}\``);
          continue;
        }
        try {
          await ch.delete(`Deleted by ${interaction.user.tag}`);
          results.push(`• ✅ ลบห้อง: **${ch.name}**`);
        } catch (e) {
          console.error("delete channel error:", e);
          results.push(`• ❌ ล้มเหลว: **${ch?.name ?? id}**`);
        }
      }

      const summary = [
        `🗑️ สรุปการลบห้อง: **${results.filter((r) => r.includes("✅")).length}/${data.channelIds.length}** สำเร็จ`,
        ...results,
      ]
        .join("\n")
        .slice(0, 1900);

      return interaction.editReply({ content: summary });
    }

    if (interaction.customId === IDS.BTN_ROOMS_CANCEL) {
      pendingRoomSelections.delete(interaction.user.id);
      return safeReply(interaction, { content: "ยกเลิกการลบห้องแล้ว" });
    }
  });

  function labelByType(t) {
    switch (t) {
      case ChannelType.GuildText: return "ข้อความ";
      case ChannelType.GuildVoice: return "เสียง";
      case ChannelType.GuildAnnouncement: return "ประกาศ";
      case ChannelType.GuildForum: return "ฟอรั่ม";
      case ChannelType.GuildStageVoice: return "สเตจ";
      default: return "ห้อง";
    }
  }
};
