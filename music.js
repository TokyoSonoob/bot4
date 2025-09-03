// music.js — เล่นตรง (Opus passthrough) ไม่ผ่านไมค์/ไม่แตะวอลุ่ม
// ต้องติดตั้ง: @discordjs/voice @distube/ytdl-core @snazzah/davey @discordjs/opus ffmpeg-static
const {
  SlashCommandBuilder,
  Events,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  NoSubscriberBehavior,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  demuxProbe,
  StreamType,
} = require("@discordjs/voice");
const ytdl = require("@distube/ytdl-core");
const ffmpeg = require("ffmpeg-static");
const { spawn, spawnSync } = require("child_process");
const { PassThrough } = require("stream");

// ===== ปุ่มปรับเสถียรภาพ/คุณภาพ =====
const STREAM_HWM = 1 << 26;     // 64MB กันกระตุก
const MAX_QUEUE   = 50;
const FFMPEG_BR   = 192;         // kbps (fallback เท่านั้น) ใช้ CBR ลดแกว่ง
// ====================================

// ต่อกิลด์: { connection, player, voiceChannelId, queue, nowPlaying, eventsBound }
const sessions = new Map();

function getSession(guildId) {
  let s = sessions.get(guildId);
  if (!s) {
    s = { connection: null, player: null, voiceChannelId: null, queue: [], nowPlaying: null, eventsBound: false };
    sessions.set(guildId, s);
  }
  return s;
}

function createPlayerIfNeeded(guildId) {
  const s = getSession(guildId);
  if (s.player) return s.player;

  // หยุดเมื่อไม่มีผู้ฟัง เพื่อลดโอกาสเสียงดีด/รีซิงก์
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Stop } });
  player.on(AudioPlayerStatus.Playing, () => console.log("[player] Playing"));
  player.on(AudioPlayerStatus.Buffering, () => console.log("[player] Buffering"));
  player.on(AudioPlayerStatus.Idle, () => console.log("[player] Idle"));
  player.on("error", (err) => console.error("[player error]", err?.message || err));

  s.player = player;
  sessions.set(guildId, s);
  return player;
}

function ensureFfmpegAvailable() {
  if (!ffmpeg) throw new Error("ffmpeg-static ไม่พร้อมใช้งาน (npm i ffmpeg-static)");
  const res = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
  if (res.status !== 0) throw new Error("เปิด ffmpeg ไม่ได้");
}

async function connectToUserChannel(member) {
  const guild = member.guild;
  const voice = member.voice?.channel;
  if (!voice || (voice.type !== ChannelType.GuildVoice && voice.type !== ChannelType.GuildStageVoice)) {
    throw new Error("กรุณาเข้าห้องเสียงก่อนใช้คำสั่ง");
  }
  const me = guild.members.me;
  const perms = voice.permissionsFor(me);
  if (!perms?.has(PermissionsBitField.Flags.Connect) || !perms?.has(PermissionsBitField.Flags.Speak)) {
    throw new Error("บอทไม่มีสิทธิ์ Connect/Speak ในห้องเสียงนี้");
  }

  let conn = getVoiceConnection(guild.id);
  const sess = getSession(guild.id);

  if (conn && sess.voiceChannelId && sess.voiceChannelId !== voice.id) {
    try { conn.destroy(); } catch (_) {}
    conn = null;
  }
  if (!conn) {
    conn = joinVoiceChannel({
      channelId: voice.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true, // ✅ ยืนยันไม่รับเสียงเข้า (ไม่ใช่ไมค์แน่นอน)
    });

    // auto-rejoin/backoff เล็กน้อยเวลาโดน disconnect
    let tries = 0;
    conn.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
          entersState(conn, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        tries++;
        if (tries > 5) { try { conn.destroy(); } catch {} }
        else { try { conn.rejoin(); } catch { try { conn.destroy(); } catch {} } }
      }
    });
  }

  await entersState(conn, VoiceConnectionStatus.Ready, 15_000).catch(() => {
    try { conn.destroy(); } catch (_) {}
    throw new Error("เชื่อมต่อห้องเสียงไม่สำเร็จ");
  });

  if (voice.type === ChannelType.GuildStageVoice) {
    for (let i = 0; i < 5; i++) {
      try { await guild.members.me.voice.setSuppressed(false); break; }
      catch { await new Promise(r => setTimeout(r, 500 * Math.pow(2, i))); }
    }
  }

  sess.connection = conn;
  sess.voiceChannelId = voice.id;
  sessions.set(guild.id, sess);
  return conn;
}

// ---------- เลือก Opus format จาก YouTube (เล่นตรงจริง) ----------
async function getOpusReadable(url) {
  const info = await ytdl.getInfo(url);

  // เลือก format ที่เป็น webm+opus (มีเสียง, bitrate สูงสุด)
  const opusFmt = info.formats
    .filter(f => f.hasAudio && f.audioCodec?.includes("opus") && f.container === "webm")
    .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];

  const common = {
    highWaterMark: STREAM_HWM,
    requestOptions: {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
    },
    // ไม่ปิดหัวอ่านเป็นชิ้นเล็ก ๆ เพื่อลดแกว่ง
    dlChunkSize: 0,
    liveBuffer: STREAM_HWM,
    filter: "audioonly",
  };

  if (opusFmt) {
    // ดึงตาม itag ตรง ๆ (Opus passthrough)
    return ytdl.downloadFromInfo(info, { ...common, quality: opusFmt.itag });
  }
  // ไม่มี Opus ในวิดีโอนั้น → คืนสตรีม audio ดีสุด เพื่อตามด้วย ffmpeg fallback
  return ytdl.downloadFromInfo(info, { ...common, quality: "highestaudio" });
}

async function makeResourceFromYouTube(url) {
  if (!ytdl.validateURL(url)) throw new Error("URL YouTube ไม่ถูกต้อง");

  // วิธี 1: พยายาม Opus passthrough ก่อน (ดีที่สุด/ไม่แกว่ง)
  try {
    const yt = await getOpusReadable(url);

    // กัน backpressure: ผ่าน PassThrough HWM ใหญ่
    const pipe = new PassThrough({ highWaterMark: STREAM_HWM });
    yt.on("error", (e) => pipe.destroy(e));
    yt.pipe(pipe);

    const probe = await demuxProbe(pipe);
    // ✅ ไม่เปิด inlineVolume → ไม่ผ่านตัวปรับวอลุ่ม (ไม่แกว่ง)
    return createAudioResource(probe.stream, { inputType: probe.type, inlineVolume: false });
  } catch (e) {
    console.warn("[passthrough failed → ffmpeg fallback]", e?.message || e);
  }

  // วิธี 2: Fallback → ffmpeg CBR (ลดแกว่งของบิตเรต)
  ensureFfmpegAvailable();

  const yt = ytdl(url, {
    quality: "highestaudio",
    highWaterMark: STREAM_HWM,
    liveBuffer: STREAM_HWM,
    dlChunkSize: 0,
    requestOptions: {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      },
    },
    filter: "audioonly",
  });

  const ff = spawn(ffmpeg, [
    "-vn",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-c:a", "libopus",
    "-application", "audio",
    "-vbr", "off",                // ✅ ใช้ CBR ลดความแกว่ง (bitrate คงที่)
    "-compression_level", "10",
    "-frame_duration", "20",
    "-b:a", `${FFMPEG_BR}k`,
    "-ar", "48000",
    "-ac", "2",
    "-f", "opus",
    "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"] });

  ff.stderr.on("data", d => {
    const s = d.toString().trim();
    if (s) console.warn("[ffmpeg stderr]", s);
  });

  yt.on("error", (err) => {
    console.warn("[ytdl error]", err?.message || err);
    ff.stdin.destroy(err);
  });
  ff.stdin.on("error", () => {});
  yt.pipe(ff.stdin, { end: true });

  return createAudioResource(ff.stdout, { inputType: StreamType.Opus, inlineVolume: false });
}

// ---------- Queue / Playback ----------
function makeTrack(url, title = "", requestedBy = "") { return { url, title, requestedBy }; }

async function fetchTitle(url) {
  try { const info = await ytdl.getBasicInfo(url); return info?.videoDetails?.title || ""; }
  catch { return ""; }
}

async function playNext(guildId) {
  const sess = sessions.get(guildId);
  if (!sess || !sess.player) return;
  const next = sess.queue.shift();
  if (!next) { sess.nowPlaying = null; return; }

  try {
    const resource = await makeResourceFromYouTube(next.url);
    sess.nowPlaying = next;
    sess.player.play(resource);
  } catch (e) {
    console.error("playNext error (skip):", e?.message || e);
    await playNext(guildId);
  }
}

function bindPlayerEventsOnce(guildId) {
  const sess = getSession(guildId);
  if (sess.eventsBound || !sess.player) return;
  sess.player.on(AudioPlayerStatus.Idle, () => {
    playNext(guildId).catch(e => console.error("auto playNext error:", e));
  });
  sess.eventsBound = true;
  sessions.set(guildId, sess);
}

function leave(guildId) {
  const sess = sessions.get(guildId);
  if (!sess) return;
  try { sess.player?.stop(true); } catch {}
  try { sess.connection?.destroy(); } catch {}
  sessions.delete(guildId);
}

// ---------- Register + Handlers ----------
module.exports = (client) => {
  client.once(Events.ClientReady, async () => {
    try {
      await client.application.commands.create(
        new SlashCommandBuilder()
          .setName("music")
          .setDescription("เล่นเพลงคุณภาพสูง (Opus passthrough)")
          .setDMPermission(false)
          .addSubcommand(sc =>
            sc.setName("play")
              .setDescription("เปิด/เพิ่มเพลงในคิว จาก YouTube URL ในห้องเสียงที่คุณอยู่")
              .addStringOption(opt =>
                opt.setName("url").setDescription("ลิงก์ YouTube (https://...)").setRequired(true)
              )
          )
          .addSubcommand(sc => sc.setName("skip").setDescription("ข้ามเพลงที่กำลังเล่น"))
          .addSubcommand(sc => sc.setName("queue").setDescription("ดูคิวเพลง"))
          .addSubcommand(sc => sc.setName("close").setDescription("หยุดและให้บอทออกจากห้องเสียง"))
          .toJSON()
      );
      console.log("✅ Registered /music play|skip|queue|close");
    } catch (e) {
      console.error("❌ Register /music failed:", e);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "music") return;
    const sub = interaction.options.getSubcommand();

    if (sub === "play") {
      const url = interaction.options.getString("url", true);
      await interaction.deferReply({ ephemeral: true });
      try {
        const conn = await connectToUserChannel(interaction.member);
        const player = createPlayerIfNeeded(interaction.guild.id);
        bindPlayerEventsOnce(interaction.guild.id);
        conn.subscribe(player);

        const sess = getSession(interaction.guild.id);
        if (sess.queue.length >= MAX_QUEUE) {
          return interaction.editReply({ content: `⚠️ คิวเต็ม (สูงสุด ${MAX_QUEUE})` });
        }

        const title = await fetchTitle(url);
        const track = makeTrack(url, title, interaction.user.tag);
        sess.queue.push(track);

        const isIdle = sess.player.state.status === AudioPlayerStatus.Idle && !sess.nowPlaying;
        if (isIdle) {
          await playNext(interaction.guild.id);
          await interaction.editReply({
            content: track.title ? `▶️ กำลังเล่น: **${track.title}**\nห้องเสียง <#${sess.voiceChannelId}>`
                                 : `▶️ เริ่มเล่นจากลิงก์\nห้องเสียง <#${sess.voiceChannelId}>`,
          });
        } else {
          await interaction.editReply({
            content: track.title ? `➕ เพิ่มเข้าคิว: **${track.title}** (คิวลำดับที่ ${sess.queue.length})`
                                 : `➕ เพิ่มเข้าคิวแล้ว (คิวลำดับที่ ${sess.queue.length})`,
          });
        }
      } catch (e) {
        console.error("music play error:", e);
        await interaction.editReply({
          content: `❌ เล่นเพลงไม่สำเร็จ: ${e.message || e}\n` +
                   `ลองลิงก์อื่น (ไม่ live/ไม่ age-restricted) หรือเช็คสิทธิ์ห้องเสียง`,
        });
      }
    }

    if (sub === "skip") {
      const sess = sessions.get(interaction.guild.id);
      if (!sess?.player || (!sess.nowPlaying && sess.queue.length === 0)) {
        return interaction.reply({ content: "ℹ️ ไม่มีเพลงให้ข้าม", ephemeral: true });
      }
      const skipped = sess.nowPlaying;
      try {
        sess.player.stop(true);
        return interaction.reply({
          content: skipped?.title ? `⏭️ ข้าม: **${skipped.title}**` : "⏭️ ข้ามเพลงปัจจุบัน",
          ephemeral: true,
        });
      } catch (e) {
        console.error("music skip error:", e);
        return interaction.reply({ content: "❌ ข้ามเพลงไม่สำเร็จ", ephemeral: true });
      }
    }

    if (sub === "queue") {
      const sess = sessions.get(interaction.guild.id) || {};
      const now = sess.nowPlaying ? `🎶 กำลังเล่น: ${sess.nowPlaying.title || "(ไม่ทราบชื่อ)"}\n` : "";
      if (!sess.nowPlaying && (!sess.queue || sess.queue.length === 0)) {
        return interaction.reply({ content: "ℹ️ คิวว่างเปล่า", ephemeral: true });
      }
      const list = (sess.queue || []).slice(0, 10).map((t, i) => `${i + 1}. ${t.title || t.url}`).join("\n");
      const more = (sess.queue?.length || 0) > 10 ? `\n…และอีก ${sess.queue.length - 10} รายการ` : "";
      return interaction.reply({ content: `${now}📜 คิวถัดไป:\n${list || "(ไม่มีรายการถัดไป)"}${more}`, ephemeral: true });
    }

    if (sub === "close") {
      try {
        const conn = getVoiceConnection(interaction.guild.id);
        if (!conn) return interaction.reply({ content: "ℹ️ ตอนนี้บอทไม่ได้อยู่ในห้องเสียง", ephemeral: true });
        leave(interaction.guild.id);
        return interaction.reply({ content: "🛑 ปิดเพลงและออกจากห้องเสียงแล้ว", ephemeral: true });
      } catch (e) {
        console.error("music close error:", e);
        return interaction.reply({ content: "❌ มีข้อผิดพลาดขณะออกจากห้องเสียง", ephemeral: true });
      }
    }
  });
};
