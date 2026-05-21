// NOTA: Ya NO se necesita el polyfill global de node-fetch aquí.
// player.ts importa node-fetch directamente y lo pasa a spotify-url-info.

import {
  Client,
  GatewayIntentBits,
  Interaction,
  TextChannel,
} from "discord.js";

import dotenv from "dotenv";
dotenv.config();

import { createLavalinkClient } from "./lavalink/client";

import {
  playSong,
  skipSong,
  stopSong,
  getQueue,
} from "./music/player";

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
        const member = interaction.guild?.members.cache.get(interaction.user.id);
        const voiceChannel = member?.voice.channel;

        if (!voiceChannel) {
          await interaction.reply({ content: "❌ Debes estar en un canal de voz.", ephemeral: true });
          return;
        }

        const query = interaction.options.get("query")?.value as string;
        if (!query) {
          await interaction.reply({ content: "❌ Debes indicar una canción.", ephemeral: true });
          return;
        }

        await interaction.deferReply();
        await interaction.editReply(`🔎 Buscando: ${query}`);

        await playSong(
          lavalink,
          interaction.guildId!,
          voiceChannel,
          interaction.channel as TextChannel,
          query
        );

        break;
      }

      case "skip": {
        await skipSong(
          lavalink,
          interaction.guildId!,
          interaction.channel as TextChannel
        );
        await interaction.reply("⏭ Saltando canción...");
        break;
      }

      case "stop": {
        await stopSong(interaction.guildId!);
        await interaction.reply("⏹ Detenido.");
        break;
      }

      case "queue": {
        const list = getQueue(interaction.guildId!);
        await interaction.reply(list);
        break;
      }
    }
  } catch (err) {
    console.error(err);

    if (interaction.isRepliable()) {
      const msg = { content: "❌ Error ejecutando comando.", ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(msg);
      } else {
        await interaction.reply(msg);
      }
    }
  }
});