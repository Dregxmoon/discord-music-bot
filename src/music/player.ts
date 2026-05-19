import { Shoukaku, Track } from "shoukaku";
import { TextChannel, VoiceBasedChannel } from "discord.js";
import { queues } from "./queue";

function getNode(shoukaku: Shoukaku) {
  const node = shoukaku.nodes.get("main");
  if (!node) throw new Error("No Lavalink node available");
  return node;
}

/**
 * 🎧 SOLO crea player si no existe
 */
async function getOrCreatePlayer(
  shoukaku: Shoukaku,
  guildId: string,
  voiceChannel: VoiceBasedChannel
) {
  let player = shoukaku.players.get(guildId);

  if (!player) {
    player = await shoukaku.joinVoiceChannel({
      guildId,
      shardId: 0,
      channelId: voiceChannel.id,
      deaf: true,
    });
  }

  return player;
}

export async function playSong(
  shoukaku: Shoukaku,
  guildId: string,
  voiceChannel: VoiceBasedChannel,
  textChannel: TextChannel,
  query: string
) {
  try {
    const node = getNode(shoukaku);

    const identifier = /^https?:\/\//.test(query)
      ? query
      : `ytsearch:${query}`;

    console.log("🎵 Buscando:", identifier);

    const result = await node.rest.resolve(identifier);

    if (!result || result.loadType === "empty") {
      return textChannel.send("❌ No se encontró la canción.");
    }

    if (result.loadType === "error") {
      console.error(result.data);
      return textChannel.send("❌ Error buscando la canción.");
    }

    let track: Track | null = null;

    switch (result.loadType) {
      case "track":
        track = result.data as Track;
        break;

      case "search":
        track = (result.data as Track[])[0] ?? null;
        break;

      case "playlist":
        track = (result.data as any).tracks?.[0] ?? null;
        break;
    }

    if (!track) {
      return textChannel.send("❌ Track inválido.");
    }

    const player = await getOrCreatePlayer(
      shoukaku,
      guildId,
      voiceChannel
    );

    let queue = queues.get(guildId);

    if (!queue) {
      queue = {
        player,
        tracks: [],
        playing: false,
      };

      queues.set(guildId, queue);

      player.on("closed", () => {
        console.log("⚠ Player cerrado");
        queues.delete(guildId);
      });

      player.on("exception", (data) => {
        console.error("❌ Player exception:", data);
      });
    }

    queue.tracks.push({ track });

    await textChannel.send(`➕ Añadido: **${track.info.title}**`);

    // 🎯 si no está reproduciendo → iniciar
    if (!queue.playing) {
      await playNext(shoukaku, guildId, textChannel);
    }
  } catch (err) {
    console.error("❌ playSong error:", err);
    await textChannel.send("❌ Error reproduciendo música.");
  }
}

/**
 * 🔥 LOOP ESTABLE DE REPRODUCCIÓN
 */
export async function playNext(
  shoukaku: Shoukaku,
  guildId: string,
  textChannel: TextChannel
) {
  const queue = queues.get(guildId);
  if (!queue) return;

  const next = queue.tracks.shift();

  if (!next) {
    queue.playing = false;

    await textChannel.send("📭 Cola vacía.");

    try {
      await queue.player.destroy();
    } catch {}

    queues.delete(guildId);
    return;
  }

  queue.playing = true;

  try {
    console.log("▶ Reproduciendo:", next.track.info.title);

    await queue.player.playTrack({
      track: {
        encoded: next.track.encoded,
      },
    });

    await textChannel.send(
      `🎵 Reproduciendo: **${next.track.info.title}**`
    );

    // 🔥 CLAVE: esperar fin REAL del track
    await new Promise<void>((resolve) => {
      const onEnd = () => {
        queue.player.removeListener("end", onEnd as any);
        resolve();
      };

      queue.player.on("end", onEnd as any);
    });

    // 🔁 siguiente canción automáticamente
    await playNext(shoukaku, guildId, textChannel);

  } catch (err) {
    console.error("❌ playNext error:", err);

    queue.playing = false;
    await playNext(shoukaku, guildId, textChannel);
  }
}

export async function skipSong(guildId: string) {
  const queue = queues.get(guildId);
  if (!queue) return;

  await queue.player.stopTrack();
}

export async function stopSong(guildId: string) {
  const queue = queues.get(guildId);
  if (!queue) return;

  queue.tracks = [];
  queue.playing = false;

  try {
    await queue.player.destroy();
  } catch {}

  queues.delete(guildId);
}

export function getQueue(guildId: string) {
  const queue = queues.get(guildId);

  if (!queue || queue.tracks.length === 0) {
    return "📭 Cola vacía.";
  }

  return queue.tracks
    .map((t, i) => `${i + 1}. ${t.track.info.title}`)
    .join("\n");
}