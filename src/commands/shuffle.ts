import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";

import { toggleShuffle } from "../music/player";

export const data = new SlashCommandBuilder()
  .setName("shuffle")
  .setDescription("Activa o desactiva el modo aleatorio");

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  const guildId = interaction.guildId!;

  const enabled = toggleShuffle(guildId);

  await interaction.reply(
    enabled
      ? "🔀 Shuffle activado."
      : "➡️ Shuffle desactivado."
  );
}