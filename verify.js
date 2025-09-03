// verify.js
const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  Events,
} = require("discord.js");
const { db, admin } = require("./firebase");

/** reply ephemeral สั้นๆ พร้อม fallback */
async function safeReply(interaction, options) {
  const payload = { ...options, ephemeral: true };
  try {
    if (interaction.deferred || interaction.replied) {
      return interaction.followUp(payload);
    }
    return interaction.reply(payload);
  } catch (e) {
    console.error("safeReply error:", e);
  }
}

/** รอแบบ async */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function isAdmin(interaction) {
  return interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator);
}

module.exports = (client) => {
  const IDS = {
    CMD: "verify",
    MODAL: "verify_modal",
    INPUT_TITLE: "verify_title",
    INPUT_DESC: "verify_desc",
    INPUT_IMG: "verify_img",
    INPUT_ROLEID: "verify_role",
    INPUT_BTN: "verify_btn",
    BTN_VERIFY_PREFIX: "verify_btn_role_", // + roleId
  };

  const DEFAULT_COLOR_INT = 0x9b59b6; // ม่วง

  // ---- helpers ----
  function parseHexColorToInt(input) {
    if (!input) return null;
    let s = String(input).trim().toLowerCase();
    if (s.startsWith("0x")) s = s.slice(2);
    if (s.startsWith("#")) s = s.slice(1);
    if (s.length === 3 && /^[0-9a-f]{3}$/i.test(s)) {
      s = s.split("").map((ch) => ch + ch).join("");
    }
    if (s.length !== 6 || !/^[0-9a-f]{6}$/i.test(s)) return null;
    return parseInt(s, 16);
  }

  // อ่าน Title แล้วแยกสีจากรูปแบบ "หัวข้อ/#ffffff" (ใช้ '/' สุดท้าย)
  function parseTitleAndColor(titleRaw) {
    let title = (titleRaw || "").trim();
    let colorInt = DEFAULT_COLOR_INT;

    const idx = title.lastIndexOf("/");
    if (idx > -1) {
      const namePart = title.slice(0, idx).trim();
      const colorPart = title.slice(idx + 1).trim();
      const parsed = parseHexColorToInt(colorPart);
      if (parsed !== null) {
        title = namePart;
        colorInt = parsed;
      }
    }
    return { title, colorInt };
  }

  function applyRuleKeyword(desc, roleName) {
    if (!desc) return "";
    return desc.replaceAll("@rule", roleName ?? "ยศ");
  }

  function toHex(colorInt) {
    return `#${(colorInt >>> 0).toString(16).padStart(6, "0")}`;
  }

  function isTransientNetworkErr(err) {
    const code = err?.code || err?.cause?.code;
    return ["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ETIMEDOUT"].includes(code);
  }

  // ---- 1) ลงทะเบียน /verify (เฉพาะแอดมิน) ----
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName(IDS.CMD)
          .setDescription("ตั้งค่า Verify")
          .setDMPermission(false)
          .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) // ✅ limit to admins
          .toJSON()
      );
      console.log("✅ Registered /verify");
    } catch (e) {
      console.error("❌ Register /verify failed:", e);
    }
  });

  // ---- 2) /verify → เปิดฟอร์ม ----
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== IDS.CMD) return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน" });
    }

    const me = interaction.guild?.members?.me;
    const needPerms = [
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.ManageChannels,
      PermissionsBitField.Flags.SendMessages,
    ];
    if (!me || !me.permissions.has(needPerms)) {
      return safeReply(interaction, {
        content: "❌ บอทต้องมีสิทธิ์ Manage Roles / Manage Channels / Send Messages",
      });
    }

    const modal = new ModalBuilder().setCustomId(IDS.MODAL).setTitle("ตั้งค่า Verify");

    const iTitle = new TextInputBuilder()
      .setCustomId(IDS.INPUT_TITLE)
      .setLabel("Title สี embed(หัวข้อ/#ffffff)") // ≤ 45 chars
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(256);

    const iDesc = new TextInputBuilder()
      .setCustomId(IDS.INPUT_DESC)
      .setLabel("Description (@rule = ชื่อยศนาจาาา)")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setMaxLength(4000);

    const iImg = new TextInputBuilder()
      .setCustomId(IDS.INPUT_IMG)
      .setLabel("URL รูปภาพ")
      .setPlaceholder("https")
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setMaxLength(400);

    const iRole = new TextInputBuilder()
      .setCustomId(IDS.INPUT_ROLEID)
      .setLabel("ID ของยศ")
      .setPlaceholder("เช่น 123456789012345678")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(32);

    const iBtn = new TextInputBuilder()
      .setCustomId(IDS.INPUT_BTN)
      .setLabel("ชื่อปุ่ม")
      .setPlaceholder("เช่น กดยืนยัน / รับยศ")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(80);

    modal.addComponents(
      new ActionRowBuilder().addComponents(iTitle),
      new ActionRowBuilder().addComponents(iDesc),
      new ActionRowBuilder().addComponents(iImg),
      new ActionRowBuilder().addComponents(iRole),
      new ActionRowBuilder().addComponents(iBtn)
    );

    await interaction.showModal(modal);
  });

  // ---- 3) รับฟอร์ม → ส่ง Embed+ปุ่ม แล้ว "ซ่อนทุกห้องยกเว้นห้องนี้" ----
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId !== IDS.MODAL) return;

    if (!isAdmin(interaction)) {
      return safeReply(interaction, { content: "❌ คำสั่งนี้ใช้ได้เฉพาะแอดมิน" });
    }

    await interaction.deferReply({ ephemeral: true }); // กัน timeout ระหว่างตั้งค่า

    const guild = interaction.guild;
    const channel = interaction.channel;

    const titleRaw = (interaction.fields.getTextInputValue(IDS.INPUT_TITLE) || "").trim();
    const descRaw = (interaction.fields.getTextInputValue(IDS.INPUT_DESC) || "").trim();
    const imgUrl = (interaction.fields.getTextInputValue(IDS.INPUT_IMG) || "").trim();
    const roleId = (interaction.fields.getTextInputValue(IDS.INPUT_ROLEID) || "").trim();
    const buttonLabel = (interaction.fields.getTextInputValue(IDS.INPUT_BTN) || "").trim();

    // ตรวจ role
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      return interaction.editReply({ content: "❌ ไม่พบยศตาม ID ที่ระบุ" });
    }

    // ตรวจลำดับ role (บอทต้องจัดการได้)
    const me = guild.members.me;
    if (!me || (me.roles.highest?.position ?? 0) <= role.position) {
      return interaction.editReply({
        content: "❌ บอทไม่มีสิทธิ์จัดการยศนี้ (role hierarchy สูงกว่าบอท)",
      });
    }

    // แยกหัวข้อ + สีจาก Title
    const { title, colorInt } = parseTitleAndColor(titleRaw);

    // สร้าง embed + ปุ่ม
    const desc = applyRuleKeyword(descRaw, role.name);
    const embed = new EmbedBuilder().setColor(colorInt);
    if (title) embed.setTitle(title);
    if (desc) embed.setDescription(desc);
    if (imgUrl && /^https?:\/\//i.test(imgUrl)) embed.setImage(imgUrl);

    const btn = new ButtonBuilder()
      .setCustomId(IDS.BTN_VERIFY_PREFIX + role.id)
      .setStyle(ButtonStyle.Primary)
      .setLabel(buttonLabel || "ยืนยัน");

    const rowBtn = new ActionRowBuilder().addComponents(btn);

    // ส่งสาธารณะในห้องนี้
    const sent = await channel.send({ embeds: [embed], components: [rowBtn] });

    // —— ซ่อนทุกห้องจาก @everyone ยกเว้นห้องนี้ —— //
    const everyone = guild.roles.everyone;
    let networkOffline = false;

    async function ensureView(guildChannel, roleOrUser, allow) {
      if (networkOffline) return;
      const overwrite = { ViewChannel: allow ? true : false };
      const MAX_RETRIES = 5;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          await guildChannel.permissionOverwrites.edit(roleOrUser, overwrite);
          return;
        } catch (e) {
          console.error(`overwrite error on ${guildChannel.id}`, e);
          if (isTransientNetworkErr(e)) {
            if ((e.code || e?.cause?.code) === "ENOTFOUND") {
              networkOffline = true;
              throw new Error("Network/DNS unavailable (ENOTFOUND discord.com)");
            }
            if (attempt < MAX_RETRIES - 1) {
              await wait(500 * Math.pow(2, attempt));
              continue;
            }
          }
          throw e;
        }
      }
    }

    try {
      const allChannels = [...guild.channels.cache.values()];
      for (const ch of allChannels) {
        if (networkOffline) break;
        if (ch.id === channel.id) continue;
        await ensureView(ch, everyone, false);
      }
      if (!networkOffline) {
        await ensureView(channel, everyone, true);
      }

      // บันทึก config
      await db.collection("verifyConfigs").doc(guild.id).set({
        channelId: channel.id,
        messageId: sent.id,
        roleId: role.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (networkOffline) {
        return interaction.editReply({
          content:
            "⚠️ ส่ง Verify แล้ว แต่ตั้งค่าสิทธิ์บางส่วนไม่สำเร็จ (เครือข่าย/DNS มีปัญหา: ENOTFOUND)\n" +
            "โปรดตรวจสอบอินเทอร์เน็ตหรือ DNS แล้วลองใหม่อีกครั้ง",
        });
      }

      await interaction.editReply({
        content:
          `• <#${channel.id}>\n` +
          `• **${role.name}** เมื่อกดสำเร็จ\n` +
          `• สี \`${titleRaw.includes("/") ? titleRaw.split("/").pop().trim() : toHex(colorInt)}\``,
      });
    } catch (e) {
      console.error("permission setup error:", e);
      await interaction.editReply({
        content:
          "❌ ตั้งค่าสิทธิ์ล้มเหลว กรุณาตรวจสอบสิทธิ์บอท/ลำดับยศ/เครือข่าย แล้วลองใหม่",
      });
    }
  });

  // ---- 4) ปุ่มกดรับยศ ----
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith(IDS.BTN_VERIFY_PREFIX)) return;

    const roleId = interaction.customId.slice(IDS.BTN_VERIFY_PREFIX.length);
    const guild = interaction.guild;
    const member = interaction.member;

    const role = guild.roles.cache.get(roleId);
    if (!role) {
      return safeReply(interaction, { content: "❌ ไม่พบยศ โปรดแจ้งแอดมิน" });
    }

    const me = guild.members.me;
    if (!me || (me.roles.highest?.position ?? 0) <= role.position) {
      return safeReply(interaction, {
        content: "❌ บอทไม่มีสิทธิ์จัดการยศนี้ โปรดแจ้งแอดมิน",
      });
    }

    try {
      if (member.roles.cache.has(role.id)) {
        return safeReply(interaction, { content: "✅ คุณมียศนี้อยู่แล้ว" });
      }
      await member.roles.add(role, "Self-verify");
      return safeReply(interaction, {
        content: `✅ ยืนยันสำเร็จ ${role.name}`,
      });
    } catch (e) {
      console.error("add role error:", e);
      return safeReply(interaction, { content: "❌ ให้ยศไม่สำเร็จ โปรดลองใหม่/แจ้งแอดมิน" });
    }
  });
};
