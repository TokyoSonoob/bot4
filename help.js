// help.js (ฉบับมินิมอล)
const { SlashCommandBuilder, EmbedBuilder, Events } = require("discord.js");

module.exports = (client) => {
  client.once(Events.ClientReady, async () => {
    await client.application.commands.create(
      new SlashCommandBuilder()
        .setName("help")
        .setDescription("แสดงคู่มือแบบย่อ")
        .setDMPermission(false)
        .toJSON()
    );
    console.log("✅ Registered /help");
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "help") return;

    const embed = new EmbedBuilder()
      .setColor(0x9b59b6) // สีม่วง (ปรับได้)
      .setTitle("วิธีการใช้งานบอท")
      .addFields(
        { name: "/help", value: "ไม่ต้องอธิบายละมั้ง มีสมองนี่", inline: true },
        { name: "/welcome", value: "ตามชื่อมันเลย ยินดีต้อนรับ", inline: true },
        { name: "/goodbye", value: "ตามชื่อ ใช้คำสั่งในห้องที่ต้องการ", inline: true },
        { name: "/ticket", value: "บอทสร้างตั๋ว", inline: true },
        { name: "/addticket", value: "สร้างปุ่มต่อไปใน embed อันเดียวกัน", inline: true },
        { name: "/group", value: "สร้างหมวดหมู่", inline: true },
        { name: "/room", value: "สร้างห้อง", inline: true },
        { name: "/delete room", value: "ลบห้อง", inline: true },
        { name: "/delete group", value: "ลบหมวดหมู่", inline: true },
        { name: "/em", value: "สร้าง embed", inline: true },
        { name: "/verify", value: "ใช้ยืนยันตัวตน/รับยศ", inline: true },
        { name: "/music play", value: "เปิดเพลง", inline: true },
        { name: "/music skip", value: "ข้ามเพลง", inline: true },
        { name: "/music queue", value: "ดูคิวเพลง", inline: true },
        { name: "/music close", value: "ปิดเพลง", inline: true },
        { name: "/invite", value: "ใช้ในห้องที่ต้องการ ใช้เช็คว่าลิ้งค์คำเชิญของใคร", inline: true },
      )
      .setFooter({ text: "Make by Purple Shop" })
      .setTimestamp();

    // ส่งแบบเห็นคนเดียว (ephemeral)
    await interaction.reply({ embeds: [embed], ephemeral: true });

    // ถ้าอยากให้เห็นทั้งห้อง ให้ใช้แบบนี้แทน:
    // await interaction.reply({ embeds: [embed] });
  });
};
