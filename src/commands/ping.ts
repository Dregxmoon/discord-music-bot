import { SlashCommandBuilder, ChatInputCommandInteraction } from "discord.js";

export const pingCommand = {
  data: new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Responde con Pong!"),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply("🏓 Pong!");
  }
};