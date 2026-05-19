import { queues } from "./queue";
import { Shoukaku } from "shoukaku";
import { TextChannel } from "discord.js";
import { playNext } from "./player";

/**
 * ⏭ Skip de canción
 */
export async function skipSong(
  shoukaku: Shoukaku,
  guildId: string,
  textChannel: TextChannel
) {
  const queue = queues.get(guildId);

  if (!queue) {
    return textChannel.send("📭 No hay nada reproduciéndose.");
  }

  // 🧠 Si no hay más canciones en cola
  if (queue.tracks.length === 0) {
    try {
      await queue.player.stopTrack();
    } catch {}

    queue.playing = false;

    await textChannel.send("📭 No hay más canciones en la cola.");

    // opcional: desconectar
    try {
      await queue.player.destroy();
    } catch {}

    queues.delete(guildId);
    return;
  }

  await textChannel.send("⏭ Saltando canción...");

  // 🔥 fuerza terminar la canción actual
  try {
    await queue.player.stopTrack();
  } catch {}

  // 🔁 reproduce la siguiente
  await playNext(shoukaku, guildId, textChannel);
}