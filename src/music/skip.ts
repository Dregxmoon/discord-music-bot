import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("skip")
  .setDescription("Salta la canción actual");

export async function execute(
  interaction: ChatInputCommandInteraction,
  skipSong: any,
  shoukaku: any
) {
  const guildId = interaction.guildId;

  if (!guildId) {
    return interaction.reply({
      content: "❌ Este comando solo funciona en servidores.",
      ephemeral: true,
    });
  }

  await skipSong(
    shoukaku,
    guildId,
    interaction.channel as any
  );

  await interaction.reply("⏭ Saltando canción...");
}