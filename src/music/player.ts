import { Shoukaku, Track, Player } from "shoukaku";
import { TextChannel, VoiceBasedChannel } from "discord.js";
import { queues, GuildQueue, QueueItem, SpotifyMeta } from "./queue";

const nodeFetch = require("node-fetch");

const { getData: spotifyGetData, getTracks: spotifyGetTracks } =
  require("spotify-url-info")(nodeFetch);

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

/**
 * Límite real de spotify-url-info: usa la API pública de Spotify
 * que devuelve máximo 100 tracks por playlist sin credenciales.
 * Para superar esto necesitarías la Spotify Web API oficial con
 * CLIENT_ID + CLIENT_SECRET y paginación manual.
 */
const SPOTIFY_MAX_TRACKS = 100;

const ARTIST_BLACKLIST = [
  "playlist", "spotify", "album", "single", "ep",
  "compilation", "various artists", "varios artistas",
];

const LOOKS_LIKE_USERNAME = /^[A-Z][a-z]+[A-Z][a-z]+\d*$|^\w{3,}\d{3,}$/;

// ─────────────────────────────────────────────
// SPOTIFY WRAPPER
// ─────────────────────────────────────────────

async function getSpotifyInfo(
  url: string
): Promise<{ name: string; tracks: any[]; total: number }> {
  const [tracks, meta] = await Promise.all([
    spotifyGetTracks(url),
    spotifyGetData(url).catch(() => ({})),
  ]);

  const arr = Array.isArray(tracks) ? tracks : [];

  return {
    name: meta?.name ?? meta?.title ?? "Spotify",
    tracks: arr,
    // total real de la playlist (puede ser >100, solo informativo)
    total: meta?.tracks?.total ?? meta?.total ?? arr.length,
  };
}

// ─────────────────────────────────────────────
// METADATA HELPERS
// ─────────────────────────────────────────────

function isValidArtist(value: unknown): value is string {
  if (!value || typeof value !== "string") return false;
  const s = value.trim();
  if (s.length < 2) return false;
  const lower = s.toLowerCase();
  if (ARTIST_BLACKLIST.some((bad) => lower.includes(bad))) return false;
  if (LOOKS_LIKE_USERNAME.test(s)) return false;
  return true;
}

function extractArtist(trackData: any): string {
  if (Array.isArray(trackData?.artists)) {
    const names = trackData.artists
      .map((a: any) => (typeof a === "string" ? a : a?.name))
      .filter(isValidArtist) as string[];
    if (names.length > 0) return names.slice(0, 2).join(" ");
  }
  if (isValidArtist(trackData?.artist)) return trackData.artist.trim();
  if (isValidArtist(trackData?.subtitle)) return trackData.subtitle.trim();
  return "";
}

function extractMeta(trackData: any): SpotifyMeta | null {
  const name = (trackData?.name ?? trackData?.title ?? "").trim();
  if (!name) return null;
  return { name, artist: extractArtist(trackData) };
}

function buildSearchQuery(meta: SpotifyMeta): string {
  const combined = meta.artist ? `${meta.name} ${meta.artist}` : meta.name;
  return `ytsearch:${combined}`;
}

// ─────────────────────────────────────────────
// LAVALINK RESOLUTION
// ─────────────────────────────────────────────

function getNode(shoukaku: Shoukaku) {
  const node = shoukaku.nodes.get("main");
  if (!node) throw new Error("No hay nodo Lavalink disponible.");
  return node;
}

async function resolveQuery(
  shoukaku: Shoukaku,
  query: string,
  fallback?: string
): Promise<Track | null> {
  const node = getNode(shoukaku);

  const attempt = async (q: string): Promise<Track | null> => {
    try {
      const result = await node.rest.resolve(q);
      if (!result) return null;
      if (result.loadType === "empty" || result.loadType === "error") return null;
      if (result.loadType === "track") return result.data as Track;
      if (result.loadType === "search") return (result.data as Track[])[0] ?? null;
      if (result.loadType === "playlist") return (result.data as any).tracks?.[0] ?? null;
    } catch (err) {
      console.error(`[resolveQuery] Error con "${q}":`, err);
    }
    return null;
  };

  const track = await attempt(query);
  if (track) return track;

  if (fallback && fallback !== query) {
    console.warn(`[resolveQuery] Fallback: ${fallback}`);
    return attempt(fallback);
  }

  return null;
}

/** Resuelve un QueueItem pendiente contra Lavalink */
async function resolveItem(
  shoukaku: Shoukaku,
  item: QueueItem
): Promise<Track | null> {
  if (item.track) return item.track;
  if (!item.pending) return null;
  return resolveQuery(
    shoukaku,
    buildSearchQuery(item.pending),
    `ytsearch:${item.pending.name}`
  );
}

// ─────────────────────────────────────────────
// SHUFFLE UTILS
// ─────────────────────────────────────────────

function shuffleArray<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function randomIndex(max: number): number {
  return Math.floor(Math.random() * max);
}

// ─────────────────────────────────────────────
// PLAYER + QUEUE INIT
// ─────────────────────────────────────────────

async function getOrCreatePlayer(
  shoukaku: Shoukaku,
  guildId: string,
  voiceChannel: VoiceBasedChannel
): Promise<Player> {
  const existing = shoukaku.players.get(guildId);
  if (existing) return existing;
  return shoukaku.joinVoiceChannel({
    guildId,
    shardId: 0,
    channelId: voiceChannel.id,
    deaf: true,
  });
}

function initQueue(
  shoukaku: Shoukaku,
  guildId: string,
  player: Player,
  textChannel: TextChannel
): GuildQueue {
  const existing = queues.get(guildId);
  if (existing) return existing;

  const queue: GuildQueue = {
    player,
    tracks: [],
    history: [],
    playing: false,
    shuffle: false,
    loop: false,
  };

  queues.set(guildId, queue);

  // Eventos registrados UNA sola vez por guild
  player.on("end", async () => {
    const q = queues.get(guildId);
    if (!q) return;
    q.playing = false;
    await playNext(shoukaku, guildId, textChannel);
  });

  player.on("exception", async (data) => {
    console.error(`[Player:${guildId}] Exception:`, data);
    const q = queues.get(guildId);
    if (!q) return;
    q.playing = false;
    await playNext(shoukaku, guildId, textChannel);
  });

  return queue;
}

// ─────────────────────────────────────────────
// PLAY SONG — ENTRY POINT
// ─────────────────────────────────────────────

export async function playSong(
  shoukaku: Shoukaku,
  guildId: string,
  voiceChannel: VoiceBasedChannel,
  textChannel: TextChannel,
  query: string
): Promise<void> {
  try {
    const player = await getOrCreatePlayer(shoukaku, guildId, voiceChannel);
    const queue = initQueue(shoukaku, guildId, player, textChannel);

    // ─── SPOTIFY ────────────────────────────────────────────────────────
    if (query.includes("spotify.com")) {
      await textChannel.send("🎧 Leyendo Spotify...");

      let info: { name: string; tracks: any[]; total: number };
      try {
        info = await getSpotifyInfo(query);
      } catch (err) {
        console.error("[Spotify] Error:", err);
        await textChannel.send("❌ No se pudo leer el enlace de Spotify.");
        return;
      }

      const { name: playlistName, tracks: rawTracks, total } = info;

      if (rawTracks.length === 0) {
        await textChannel.send("❌ No se encontraron canciones.");
        return;
      }

      const isPlaylist = rawTracks.length > 1;

      // Avisa si la playlist tiene más de 100 canciones
      const limitWarning =
        total > SPOTIFY_MAX_TRACKS
          ? `\n⚠️ La playlist tiene **${total}** canciones pero solo se pueden cargar las primeras **${SPOTIFY_MAX_TRACKS}** ` +
            `(limitación de la API pública de Spotify).`
          : "";

      // ── SHUFFLE ACTIVO: elige 1 random y encola el resto aleatorio ──────
      if (queue.shuffle && isPlaylist) {
        const idx = randomIndex(rawTracks.length);
        const chosenMeta = extractMeta(rawTracks[idx]);

        if (!chosenMeta) {
          await textChannel.send("❌ No se pudo extraer la canción aleatoria.");
          return;
        }

        await textChannel.send(
          `🔀 Shuffle ON — **${playlistName}** (${rawTracks.length} cargadas de ${total} totales)` +
          limitWarning +
          `\n🎲 Eligió: **${chosenMeta.name}**...`
        );

        const firstTrack = await resolveQuery(
          shoukaku,
          buildSearchQuery(chosenMeta),
          `ytsearch:${chosenMeta.name}`
        );

        if (!firstTrack) {
          await textChannel.send("❌ No encontrado en YouTube.");
          return;
        }

        // El resto en orden aleatorio, todos lazy (pending)
        const restItems: QueueItem[] = shuffleArray(
          rawTracks.filter((_, i) => i !== idx)
        )
          .map((t) => {
            const m = extractMeta(t);
            return m ? ({ pending: m } as QueueItem) : null;
          })
          .filter(Boolean) as QueueItem[];

        const firstItem: QueueItem = { track: firstTrack };
        queue.tracks.push(firstItem, ...restItems);
        queue.history.push(firstItem, ...restItems);

        await textChannel.send(
          `✅ Reproduciendo **${chosenMeta.name}** + ${restItems.length} canciones más en cola.`
        );

        if (!queue.playing) await playNext(shoukaku, guildId, textChannel);
        return;
      }

      // ── NORMAL: reproduce la primera ahora, el resto lazy ───────────────
      const firstMeta = extractMeta(rawTracks[0]);

      if (!firstMeta) {
        await textChannel.send("❌ No se pudo extraer la primera canción.");
        return;
      }

      await textChannel.send(
        isPlaylist
          ? `📋 **${playlistName}** — ${rawTracks.length} cargadas de ${total} totales` +
            limitWarning +
            `\n▶️ Arrancando: **${firstMeta.name}**...`
          : `🔎 Buscando: **${firstMeta.name}**...`
      );

      // Resuelve solo la #1 para arrancar sin esperar
      const firstTrack = await resolveQuery(
        shoukaku,
        buildSearchQuery(firstMeta),
        `ytsearch:${firstMeta.name}`
      );

      if (!firstTrack) {
        await textChannel.send("❌ No se encontró la primera canción en YouTube.");
        return;
      }

      const firstItem: QueueItem = { track: firstTrack };
      queue.tracks.push(firstItem);
      queue.history.push(firstItem);

      if (isPlaylist) {
        // El resto va como pending — se resuelve justo antes de reproducirse
        const restItems: QueueItem[] = rawTracks
          .slice(1)
          .map((t) => {
            const m = extractMeta(t);
            return m ? ({ pending: m } as QueueItem) : null;
          })
          .filter(Boolean) as QueueItem[];

        queue.tracks.push(...restItems);
        queue.history.push(...restItems);

        await textChannel.send(
          `✅ **${firstMeta.name}** reproduciéndose + ${restItems.length} canciones más en cola.`
        );
      }

      if (!queue.playing) await playNext(shoukaku, guildId, textChannel);
      return;
    }

    // ─── YOUTUBE / BÚSQUEDA NORMAL ──────────────────────────────────────
    const identifier = /^https?:\/\//.test(query) ? query : `ytsearch:${query}`;
    const resolved = await resolveQuery(shoukaku, identifier);

    if (!resolved) {
      await textChannel.send("❌ No se encontró ningún resultado.");
      return;
    }

    const item: QueueItem = { track: resolved };
    queue.tracks.push(item);
    queue.history.push(item);

    await textChannel.send(`➕ Añadido: **${resolved.info.title}**`);
    if (!queue.playing) await playNext(shoukaku, guildId, textChannel);

  } catch (err) {
    console.error("[playSong] Error inesperado:", err);
    await textChannel.send("❌ Error inesperado reproduciendo música.");
  }
}

// ─────────────────────────────────────────────
// PLAY NEXT — con lazy resolution
// ─────────────────────────────────────────────

export async function playNext(
  shoukaku: Shoukaku,
  guildId: string,
  textChannel: TextChannel
): Promise<void> {
  const queue = queues.get(guildId);
  if (!queue) return;

  // Loop: recarga la cola desde el historial
  if (queue.tracks.length === 0 && queue.loop && queue.history.length > 0) {
    queue.tracks = queue.shuffle
      ? shuffleArray([...queue.history])
      : [...queue.history];
  }

  // Shuffle dinámico: elige un item random como siguiente
  if (queue.shuffle && queue.tracks.length > 1) {
    const idx = randomIndex(queue.tracks.length);
    const [chosen] = queue.tracks.splice(idx, 1);
    queue.tracks.unshift(chosen);
  }

  const next = queue.tracks.shift();

  if (!next) {
    queue.playing = false;
    await textChannel.send("📭 Cola vacía. ¡Hasta la próxima!");
    try { await queue.player.destroy(); } catch {}
    queues.delete(guildId);
    return;
  }

  // ── LAZY RESOLUTION ───────────────────────────────────────────────────
  // Si el item es pending, lo resolvemos AHORA (justo antes de reproducir)
  let track: Track | null = null;

  if (next.track) {
    track = next.track;
  } else if (next.pending) {
    const label = next.pending.artist
      ? `${next.pending.name} - ${next.pending.artist}`
      : next.pending.name;
    console.log(`[Lazy] Resolviendo: ${label}`);
    track = await resolveItem(shoukaku, next);

    if (!track) {
      // No encontrado en YouTube: salta silenciosamente al siguiente
      console.warn(`[Lazy] No encontrado, saltando: ${label}`);
      queue.playing = false;
      return playNext(shoukaku, guildId, textChannel);
    }
  }

  if (!track) {
    queue.playing = false;
    return playNext(shoukaku, guildId, textChannel);
  }

  queue.playing = true;

  try {
    await queue.player.playTrack({ track: { encoded: track.encoded } });

    const dur = track.info.length ? formatDuration(track.info.length) : "?";
    const remaining = queue.tracks.length;

    await textChannel.send(
      `🎵 **${track.info.title}** \`[${dur}]\`` +
      (remaining > 0 ? ` — 📋 ${remaining} en cola` : "")
    );
  } catch (err) {
    console.error("[playNext] Error:", err);
    queue.playing = false;
    await playNext(shoukaku, guildId, textChannel);
  }
}

// ─────────────────────────────────────────────
// SKIP
// ─────────────────────────────────────────────

export async function skipSong(
  shoukaku: Shoukaku,
  guildId: string,
  textChannel: TextChannel
): Promise<void> {
  const queue = queues.get(guildId);
  if (!queue || !queue.playing) {
    await textChannel.send("❌ No hay nada reproduciéndose.");
    return;
  }
  await queue.player.stopTrack();
  await textChannel.send("⏭ Canción saltada.");
}

// ─────────────────────────────────────────────
// STOP
// ─────────────────────────────────────────────

export async function stopSong(guildId: string): Promise<void> {
  const queue = queues.get(guildId);
  if (!queue) return;
  queue.tracks = [];
  queue.history = [];
  queue.playing = false;
  try { await queue.player.destroy(); } catch {}
  queues.delete(guildId);
}

// ─────────────────────────────────────────────
// TOGGLES
// ─────────────────────────────────────────────

export function toggleShuffle(guildId: string): boolean {
  const queue = queues.get(guildId);
  if (!queue) return false;
  queue.shuffle = !queue.shuffle;
  return queue.shuffle;
}

export function toggleLoop(guildId: string): boolean {
  const queue = queues.get(guildId);
  if (!queue) return false;
  queue.loop = !queue.loop;
  return queue.loop;
}

// ─────────────────────────────────────────────
// QUEUE VIEW
// ─────────────────────────────────────────────

export function getQueue(guildId: string): string {
  const queue = queues.get(guildId);
  if (!queue || queue.tracks.length === 0) return "📭 La cola está vacía.";

  const lines = queue.tracks.slice(0, 20).map((item, i) => {
    if (item.track) {
      const dur = item.track.info.length
        ? formatDuration(item.track.info.length)
        : "?";
      return `\`${i + 1}.\` **${item.track.info.title}** \`[${dur}]\``;
    }
    if (item.pending) {
      const label = item.pending.artist
        ? `${item.pending.name} — ${item.pending.artist}`
        : item.pending.name;
      return `\`${i + 1}.\` ⏳ ${label}`;
    }
    return `\`${i + 1}.\` *(desconocido)*`;
  });

  const extra =
    queue.tracks.length > 20
      ? `\n_...y ${queue.tracks.length - 20} más._`
      : "";

  return (
    `🎶 **Cola (${queue.tracks.length} canciones):**\n` +
    lines.join("\n") +
    extra
  );
}

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}