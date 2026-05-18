import {
  Client,
  GatewayIntentBits,
  Interaction
} from "discord.js";

import dotenv from "dotenv";
dotenv.config();

import { pingCommand } from "./commands/ping";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates
  ]
});

const commands = {
  ping: pingCommand
};

client.once("ready", () => {
  console.log(`✅ Bot listo como ${client.user?.tag}`);
});

client.on("interactionCreate", async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands[interaction.commandName as keyof typeof commands];

  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({
        content: "❌ Error ejecutando comando",
        ephemeral: true
      });
    } else {
      await interaction.reply({
        content: "❌ Error ejecutando comando",
        ephemeral: true
      });
    }
  }
});

client.login(process.env.DISCORD_TOKEN);