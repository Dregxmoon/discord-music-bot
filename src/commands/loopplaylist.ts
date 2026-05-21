import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
} from "discord.js";

import { toggleLoop } from "../music/player";

export const data = new SlashCommandBuilder()
  .setName("loopplaylist")
  .setDescription("Activa o desactiva loop infinito");

export async function execute(
  interaction: ChatInputCommandInteraction
) {
  const guildId = interaction.guildId!;

  const enabled = toggleLoop(guildId);

  await interaction.reply(
    enabled
      ? "🔁 Loop infinito activado."
      : "⏹ Loop infinito desactivado."
  );
}