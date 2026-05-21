import { Shoukaku, Track } from "shoukaku";
import { TextChannel, VoiceBasedChannel } from "discord.js";
import { queues } from "./queue";

const spotifyUrlInfo = require("spotify-url-info");

// ==============================
// SPOTIFY FIX WRAPPER
// ==============================
async function getSpotifyData(url: string) {
  const api = spotifyUrlInfo;

  if (typeof api === "function") {
    const result = api();
    if (result.getData) return await result.getData(url);
  }

  if (api.getData) return await api.getData(url);

  if (api.default?.getData) return await api.default.getData(url);

  throw new Error("spotify-url-info incompatible");
}

// ==============================
// NODE
// ==============================
function getNode(shoukaku: Shoukaku) {
  const node = shoukaku.nodes.get("main");
  if (!node) throw new Error("No Lavalink node available");
  return node;
}

// ==============================
// SHUFFLE
// ==============================
function shuffleArray<T>(array: T[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// ==============================
// BUILD QUERY (IMPORTANT FIX)
// ==============================
function buildQuery(trackName: string, artists: any[]) {
  let artistText = "";

  if (Array.isArray(artists)) {
    artistText = artists
      .map((a) => a?.name)
      .filter(Boolean)
      .join(" ");
  }

  if (!trackName) return "";

  return `ytsearch:${trackName} ${artistText}`.trim();
}

// ==============================
// RESOLVE TRACK
// ==============================
async function resolveTrack(shoukaku: Shoukaku, query: string): Promise<Track | null> {
  const node = getNode(shoukaku);

  const result = await node.rest.resolve(query);

  if (!result) return null;
  if (result.loadType === "empty") return null;
  if (result.loadType === "error") return null;

  if (result.loadType === "track") {
    return result.data as Track;
  }

  if (result.loadType === "search") {
    return (result.data as Track[])[0] ?? null;
  }

  if (result.loadType === "playlist") {
    return (result.data as any).tracks?.[0] ?? null;
  }

  return null;
}

// ==============================
// PLAYER
// ==============================
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

// ==============================
// MAIN FUNCTION
// ==============================
export async function playSong(
  shoukaku: Shoukaku,
  guildId: string,
  voiceChannel: VoiceBasedChannel,
  textChannel: TextChannel,
  query: string
) {
  try {
    const player = await getOrCreatePlayer(shoukaku, guildId, voiceChannel);

    let queue = queues.get(guildId);

    if (!queue) {
      queue = {
        player,
        tracks: [],
        history: [],
        playing: false,
        shuffle: false,
        loop: false,
      };

      queues.set(guildId, queue);

      player.on("end", async () => {
        queue!.playing = false;
        await playNext(shoukaku, guildId, textChannel);
      });

      player.on("exception", async (data) => {
        console.error("Player error:", data);
        queue!.playing = false;
        await playNext(shoukaku, guildId, textChannel);
      });
    }

    // ==============================
    // SPOTIFY DETECTION FIX
    // ==============================
    if (query.includes("spotify.com")) {
      await textChannel.send("🎧 Leyendo Spotify...");

      const data = await getSpotifyData(query);

      // ==============================
      // PLAYLIST HANDLING FIXED
      // ==============================
      if (Array.isArray(data?.tracks)) {
        let added = 0;

        for (const track of data.tracks) {
          if (!track) continue;

          const name = track.name;
          const artists = track.artists;

          if (!name) continue;

          const search = buildQuery(name, artists);

          console.log("🔎 Spotify -> YouTube:", search);

          const resolved = await resolveTrack(shoukaku, search);

          if (!resolved) continue;

          queue.tracks.push({ track: resolved });
          queue.history.push({ track: resolved });

          added++;
        }

        await textChannel.send(
          `✅ Playlist agregada: ${added} canciones`
        );

        if (!queue.playing) {
          await playNext(shoukaku, guildId, textChannel);
        }

        return;
      }

      // ==============================
      // SINGLE TRACK FIXED
      // ==============================
      const search = buildQuery(data.name, data.artists);

      console.log("🔎 Spotify -> YouTube:", search);

      const resolved = await resolveTrack(shoukaku, search);

      if (!resolved) {
        return textChannel.send("❌ No encontrado en YouTube.");
      }

      queue.tracks.push({ track: resolved });
      queue.history.push({ track: resolved });

      await textChannel.send(`➕ Añadido: **${resolved.info.title}**`);

      if (!queue.playing) {
        await playNext(shoukaku, guildId, textChannel);
      }

      return;
    }

    // ==============================
    // NORMAL YOUTUBE SEARCH
    // ==============================
    const identifier = /^https?:\/\//.test(query)
      ? query
      : `ytsearch:${query}`;

    const resolved = await resolveTrack(shoukaku, identifier);

    if (!resolved) {
      return textChannel.send("❌ No encontrado.");
    }

    queue.tracks.push({ track: resolved });
    queue.history.push({ track: resolved });

    await textChannel.send(`➕ Añadido: **${resolved.info.title}**`);

    if (!queue.playing) {
      await playNext(shoukaku, guildId, textChannel);
    }

  } catch (err) {
    console.error("ERROR playSong:", err);
    await textChannel.send("❌ Error reproduciendo música.");
  }
}

// ==============================
// PLAY NEXT
// ==============================
export async function playNext(
  shoukaku: Shoukaku,
  guildId: string,
  textChannel: TextChannel
) {
  const queue = queues.get(guildId);

  if (!queue) return;

  if (queue.tracks.length === 0 && queue.loop) {
    queue.tracks = [...queue.history];

    if (queue.shuffle) {
      queue.tracks = shuffleArray(queue.tracks);
    }
  }

  if (queue.shuffle) {
    queue.tracks = shuffleArray(queue.tracks);
  }

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

  await queue.player.playTrack({
    track: {
      encoded: next.track.encoded,
    },
  });

  await textChannel.send(
    `🎵 Reproduciendo: **${next.track.info.title}**`
  );
}

// ==============================
// SKIP
// ==============================
export async function skipSong(
  shoukaku: Shoukaku,
  guildId: string,
  textChannel: TextChannel
) {
  const queue = queues.get(guildId);

  if (!queue) {
    return textChannel.send("❌ Sin cola.");
  }

  queue.playing = false;
  await queue.player.stopTrack();

  await textChannel.send("⏭ Saltado.");
}

// ==============================
// STOP
// ==============================
export async function stopSong(guildId: string) {
  const queue = queues.get(guildId);

  if (!queue) return;

  queue.tracks = [];
  queue.history = [];
  queue.playing = false;

  try {
    await queue.player.destroy();
  } catch {}

  queues.delete(guildId);
}

// ==============================
// TOGGLES
// ==============================
export function toggleShuffle(guildId: string) {
  const queue = queues.get(guildId);
  if (!queue) return false;

  queue.shuffle = !queue.shuffle;
  return queue.shuffle;
}

export function toggleLoop(guildId: string) {
  const queue = queues.get(guildId);
  if (!queue) return false;

  queue.loop = !queue.loop;
  return queue.loop;
}

// ==============================
// QUEUE VIEW
// ==============================
export function getQueue(guildId: string) {
  const queue = queues.get(guildId);

  if (!queue || queue.tracks.length === 0) {
    return "📭 Cola vacía.";
  }

  return queue.tracks
    .map((t, i) => `${i + 1}. ${t.track.info.title}`)
    .join("\n");
}