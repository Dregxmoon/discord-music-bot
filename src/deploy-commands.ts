import dotenv from "dotenv";
dotenv.config();

import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Responde con Pong!"),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Reproduce una canción")
    .addStringOption((opt) =>
      opt.setName("query")
        .setDescription("URL o nombre de la canción")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Salta la canción actual"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Para la música y desconecta el bot"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Muestra la cola de canciones"),

].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);

async function deployCommands() {
  try {
    console.log("🔄 Registrando comandos...");

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID!,
        process.env.GUILD_ID!
      ),
      { body: commands }
    );

    console.log("✅ Comandos registrados:", commands.map((c) => `/${c.name}`).join(", "));
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

deployCommands();