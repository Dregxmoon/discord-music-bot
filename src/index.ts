import {
  Client,
  GatewayIntentBits,
  Interaction,
  TextChannel,
  VoiceState,
} from "discord.js";

import dotenv from "dotenv";
dotenv.config();

import { createLavalinkClient } from "./lavalink/client";
import {
  playSong,
  skipSong,
  stopSong,
  getQueue,
  toggleShuffle,
  toggleLoop,
  pauseSong,
  resumeSong,
  seekSong,
  getNowPlaying,
  formatDuration,
  buildProgressBar,
  onVoiceChannelEmpty,
  onVoiceChannelJoined,
} from "./music/player";
import { queues } from "./music/queue";
import { Shoukaku } from "shoukaku";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

let lavalink: Shoukaku;

async function start() {
  console.log("🚀 Iniciando bot...");
  await client.login(process.env.DISCORD_TOKEN);
  console.log(`✅ Logeado como ${client.user?.tag}`);
  lavalink = createLavalinkClient(client);
  console.log("🧩 Shoukaku creado");
}

start().catch(console.error);

// ─────────────────────────────────────────────
// AUTO-DISCONNECT — detecta canal vacío
// ─────────────────────────────────────────────

client.on("voiceStateUpdate", (oldState: VoiceState, newState: VoiceState) => {
  const guildId = oldState.guild.id;
  const queue   = queues.get(guildId);
  if (!queue) return;

  // ID del canal donde está el bot
  const botChannelId = oldState.guild.members.me?.voice.channelId;
  if (!botChannelId) return;

  // El bot se movió o desconectó — ignorar
  if (oldState.member?.id === client.user?.id) return;

  const channel = oldState.guild.channels.cache.get(botChannelId);
  if (!channel?.isVoiceBased()) return;

  // Contar miembros humanos en el canal (excluir bots)
  const humans = channel.members.filter((m) => !m.user.bot).size;

  // Obtener el textChannel desde la queue para los mensajes
  // Buscamos el primer canal de texto disponible del servidor
  const textChannel = oldState.guild.channels.cache
    .filter((c) => c.isTextBased() && c.isSendable())
    .first() as TextChannel | undefined;

  if (!textChannel) return;

  if (humans === 0) {
    // Canal quedó vacío → programar desconexión
    onVoiceChannelEmpty(guildId, lavalink, textChannel);
  } else if (newState.channelId === botChannelId) {
    // Alguien se unió al canal del bot → cancelar timer
    onVoiceChannelJoined(guildId);
  }
});

// ─────────────────────────────────────────────
// SLASH COMMANDS
// ─────────────────────────────────────────────

client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    switch (commandName) {

      case "ping": {
        await interaction.reply("🏓 Pong!");
        break;
      }

      case "play": {
        const member       = interaction.guild?.members.cache.get(interaction.user.id);
        const voiceChannel = member?.voice.channel;

        if (!voiceChannel) {
          await interaction.reply({ content: "❌ Debes estar en un canal de voz.", ephemeral: true });
          return;
        }

        const query = interaction.options.get("query")?.value as string;
        if (!query) {
          await interaction.reply({ content: "❌ Debes indicar una canción o URL.", ephemeral: true });
          return;
        }

        await interaction.deferReply();
        await interaction.editReply(`🔎 Buscando: \`${query}\``);

        await playSong(lavalink, interaction.guildId!, voiceChannel, interaction.channel as TextChannel, query);
        break;
      }

      case "skip": {
        await interaction.deferReply();
        await skipSong(lavalink, interaction.guildId!, interaction.channel as TextChannel);
        await interaction.editReply("⏭ Canción saltada.");
        break;
      }

      case "stop": {
        await stopSong(interaction.guildId!, lavalink);
        await interaction.reply("⏹ Música detenida y cola limpiada.");
        break;
      }

      case "queue": {
        await interaction.reply(getQueue(interaction.guildId!));
        break;
      }

      case "pause": {
        const result = await pauseSong(interaction.guildId!);
        if (result === "paused") {
          await interaction.reply("⏸ Música pausada. Usa `/resume` para continuar.");
        } else {
          await interaction.reply({ content: "❌ No hay nada reproduciéndose o ya está pausado.", ephemeral: true });
        }
        break;
      }

      case "resume": {
        const result = await resumeSong(interaction.guildId!);
        if (result === "resumed") {
          await interaction.reply("▶️ Reproducción reanudada.");
        } else {
          await interaction.reply({ content: "❌ La música no está pausada.", ephemeral: true });
        }
        break;
      }

      case "seek": {
        const input = interaction.options.get("position")?.value as string;
        let totalSeconds = 0;
        const parts = input.trim().split(":").map(Number);

        if (parts.some(isNaN)) {
          await interaction.reply({ content: "❌ Formato inválido. Usa `1:30` o `90` (segundos).", ephemeral: true });
          break;
        }

        if (parts.length === 1)      totalSeconds = parts[0];
        else if (parts.length === 2) totalSeconds = parts[0] * 60 + parts[1];
        else if (parts.length === 3) totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];

        const posMs  = totalSeconds * 1000;
        const result = await seekSong(interaction.guildId!, posMs);

        switch (result) {
          case "ok":           await interaction.reply(`⏩ Saltando a \`${formatDuration(posMs)}\`.`); break;
          case "not_playing":  await interaction.reply({ content: "❌ No hay nada reproduciéndose.", ephemeral: true }); break;
          case "out_of_range": await interaction.reply({ content: "❌ Posición fuera del rango de la canción.", ephemeral: true }); break;
          case "not_seekable": await interaction.reply({ content: "❌ No se puede buscar en streams en vivo.", ephemeral: true }); break;
        }
        break;
      }

      case "nowplaying": {
        const info = getNowPlaying(interaction.guildId!);

        if (!info) {
          await interaction.reply({ content: "❌ No hay nada reproduciéndose.", ephemeral: true });
          break;
        }

        const posStr     = formatDuration(info.position);
        const durStr     = formatDuration(info.duration);
        const bar        = info.duration > 0 ? buildProgressBar(info.position, info.duration) : "─────────────────";
        const statusIcon = info.paused ? "⏸" : "▶️";
        const titleLine  = info.uri ? `**[${info.title}](${info.uri})**` : `**${info.title}**`;

        await interaction.reply([
          `${statusIcon} ${titleLine}`,
          `👤 ${info.author}`,
          ``,
          `\`${bar}\``,
          `\`${posStr} / ${durStr}\``,
          ``,
          `${info.shuffle ? "🔀 ON" : "🔀 OFF"}  ${info.loop ? "🔁 ON" : "🔁 OFF"}  📋 ${info.remaining} en cola`,
        ].join("\n"));
        break;
      }

      case "shuffle": {
        const guildId = interaction.guildId!;
        const queue   = queues.get(guildId);
        const enabled = toggleShuffle(guildId);

        if (!queue) {
          await interaction.reply(
            enabled
              ? "🔀 Shuffle activado. Se aplicará cuando uses `/play`."
              : "➡️ Shuffle desactivado."
          );
          break;
        }

        if (enabled && queue.tracks.length > 1) {
          const arr = queue.tracks;
          for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
          }
          await interaction.reply(`🔀 Shuffle activado — cola reorganizada (${arr.length} canciones).`);
        } else {
          await interaction.reply(enabled ? "🔀 Shuffle activado." : "➡️ Shuffle desactivado.");
        }
        break;
      }

      case "loopplaylist": {
        const enabled = toggleLoop(interaction.guildId!);
        await interaction.reply(enabled ? "🔁 Loop infinito activado." : "⏹ Loop infinito desactivado.");
        break;
      }

    }
  } catch (err) {
    console.error("[Command Error]", err);
    if (interaction.isRepliable()) {
      const msg = { content: "❌ Ocurrió un error ejecutando el comando.", ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    }
  }
});