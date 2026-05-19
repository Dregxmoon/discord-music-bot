import { Client, GatewayIntentBits, Interaction } from "discord.js";
import dotenv from "dotenv";

dotenv.config();

import { createLavalinkClient } from "./lavalink/client";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

let lavalink: any;

client.once("ready", () => {
  console.log(`✅ Bot listo como ${client.user?.tag}`);
  lavalink = createLavalinkClient(client);
});

client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    switch (commandName) {
      case "ping":
        await interaction.reply("🏓 Pong!");
        break;

      case "play":
        await interaction.reply("🎵 /play aún no conectado a lógica (siguiente paso)");
        break;

      case "skip":
        await interaction.reply("⏭ Skip aún no implementado");
        break;

      case "stop":
        await interaction.reply("⏹ Stop aún no implementado");
        break;

      default:
        await interaction.reply("❓ Comando desconocido");
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      await interaction.reply({
        content: "❌ Error ejecutando comando",
        ephemeral: true,
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);