import dotenv from "dotenv";
dotenv.config();

import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Comprueba si el bot responde"),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription("Reproduce una canción o playlist")
    .addStringOption((opt) =>
      opt.setName("query")
        .setDescription("URL de YouTube/Spotify o nombre de canción")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Salta la canción actual"),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription("Para la música y limpia la cola"),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription("Muestra las canciones en cola"),

  new SlashCommandBuilder()
    .setName("nowplaying")
    .setDescription("Muestra la canción actual con barra de progreso"),

  new SlashCommandBuilder()
    .setName("pause")
    .setDescription("Pausa la canción actual"),

  new SlashCommandBuilder()
    .setName("resume")
    .setDescription("Reanuda la canción pausada"),

  new SlashCommandBuilder()
    .setName("seek")
    .setDescription("Salta a un momento específico de la canción")
    .addStringOption((opt) =>
      opt.setName("position")
        .setDescription("Posición en formato 1:30 o en segundos (90)")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("shuffle")
    .setDescription("Activa o desactiva el modo aleatorio 🔀"),

  new SlashCommandBuilder()
    .setName("loopplaylist")
    .setDescription("Activa o desactiva el loop infinito 🔁"),

].map((cmd) => cmd.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!);

async function deployCommands() {
  try {
    console.log("🔄 Registrando comandos slash...");

    await rest.put(
      Routes.applicationGuildCommands(
        process.env.CLIENT_ID!,
        process.env.GUILD_ID!
      ),
      { body: commands }
    );

    console.log(
      "✅ Comandos registrados:\n" +
      commands.map((c) => `   /${c.name} — ${c.description}`).join("\n")
    );
  } catch (error) {
    console.error("❌ Error registrando comandos:", error);
  }
}

deployCommands();