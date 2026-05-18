import dotenv from "dotenv";
dotenv.config();

import { REST, Routes } from "discord.js";
import { pingCommand } from "./commands/ping";

const commands = [
  pingCommand.data.toJSON()
];

const rest = new REST({ version: "10" }).setToken(
  process.env.DISCORD_TOKEN!
);

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

    console.log("✅ Comandos registrados");
  } catch (error) {
    console.error(error);
  }
}

deployCommands();