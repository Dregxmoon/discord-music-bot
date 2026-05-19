import { Shoukaku, Track } from "shoukaku";
import { TextChannel, VoiceBasedChannel } from "discord.js";
import { queues } from "./queue";

function getNode(shoukaku: Shoukaku) {
  const node = shoukaku.options.nodeResolver(shoukaku.nodes);
  if (!node) throw new Error("No Lavalink node available");
  return node;
}

/**
 * 🎵 PLAY (add to queue or start)
 */
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

    const result = await node.rest.resolve(identifier);

    if (!result || result.loadType === "empty") {
      return textChannel.send("❌ No se encontró la canción.");
    }

    if (result.loadType === "error") {
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
        track = result.data.tracks?.[0] ?? null;
        break;
    }

    if (!track || !track.encoded) {
      return textChannel.send("❌ Track inválido.");
    }

    let queue = queues.get(guildId);

    // 🎧 crear player si no existe
    if (!queue) {
      const player = await shoukaku.joinVoiceChannel({
        guildId,
        channelId: voiceChannel.id,
        shardId: 0,
        deaf: true,
      });

      queue = {
        player,
        tracks: [],
        playing: false,
      };

      queues.set(guildId, queue);

      // 🔥 EVENTOS AUTO NEXT
      player.on("end", () => {
        playNext(shoukaku, guildId, textChannel);
      });

      player.on("exception", () => {
        playNext(shoukaku, guildId, textChannel);
      });
    }

    queue.tracks.push({ track });

    textChannel.send(`➕ Añadido: **${track.info?.title}**`);

    if (!queue.playing) {
      await playNext(shoukaku, guildId, textChannel);
    }
  } catch (err) {
    console.error("playSong error:", err);
    textChannel.send("❌ Error reproduciendo música.");
  }
}

/**
 * ▶ NEXT SONG (CORE ENGINE)
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
    textChannel.send("📭 Cola vacía.");
    return;
  }

  queue.playing = true;

  try {
    await queue.player.playTrack({
      track: next.track.encoded,
    });

    textChannel.send(`🎵 Reproduciendo: **${next.track.info?.title}**`);
  } catch (err) {
    console.error("playNext error:", err);
    playNext(shoukaku, guildId, textChannel);
  }
}

/**
 * ⏭ SKIP
 */
export async function skipSong(guildId: string) {
  const queue = queues.get(guildId);
  if (!queue) return;

  queue.player.stopTrack(); // dispara "end"
}

/**
 * ⏹ STOP
 */
export async function stopSong(guildId: string) {
  const queue = queues.get(guildId);
  if (!queue) return;

  queue.tracks = [];
  queue.playing = false;

  try {
    queue.player.connection.disconnect();
  } catch {}

  queues.delete(guildId);
}

/**
 * 📜 GET QUEUE
 */
export function getQueue(guildId: string) {
  const queue = queues.get(guildId);

  if (!queue || queue.tracks.length === 0) {
    return "📭 Cola vacía.";
  }

  return queue.tracks
    .map((t, i) => `${i + 1}. ${t.track.info?.title}`)
    .join("\n");
}