import { Shoukaku, Track, Player } from "shoukaku";
import { Client, TextChannel, VoiceBasedChannel } from "discord.js";
import { queues, GuildQueue, QueueItem, SpotifyMeta } from "./queue";
import { resolveSpotifyUrl } from "./spotify";

// ─────────────────────────────────────────────
// CONSTANTES
// ─────────────────────────────────────────────

const MAX_QUEUE_SIZE      = 100;
const AUTO_DISCONNECT_MS  = 3 * 60 * 1000; // 3 minutos sin actividad → desconectar

// ─────────────────────────────────────────────
// CACHÉ DE RESOLUCIONES
// Evita llamar a Lavalink dos veces por la misma query.
// Clave: query string → Track resuelto
// TTL: 30 minutos (las URLs de YouTube expiran)
// ─────────────────────────────────────────────

interface CacheEntry {
  track:     Track;
  expiresAt: number;
}

const resolveCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

function cacheGet(key: string): Track | null {
  const entry = resolveCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    resolveCache.delete(key);
    return null;
  }
  return entry.track;
}

function cacheSet(key: string, track: Track): void {
  resolveCache.set(key, { track, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Limpia entradas expiradas cada 10 minutos para no acumular memoria
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of resolveCache) {
    if (now > entry.expiresAt) resolveCache.delete(key);
  }
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────
// AUTO-DISCONNECT
// Timer por servidor — se activa cuando el canal de voz
// queda vacío o la cola se vacía. Se cancela si alguien
// vuelve o se añade música.
// ─────────────────────────────────────────────

const disconnectTimers = new Map<string, NodeJS.Timeout>();

function scheduleDisconnect(
  guildId: string,
  shoukaku: Shoukaku,
  textChannel: TextChannel
): void {
  cancelDisconnect(guildId); // cancela cualquier timer anterior

  const timer = setTimeout(async () => {
    const queue = queues.get(guildId);

    // Solo desconecta si sigue sin reproducir
    if (queue && queue.playing) return;

    console.log(`[AutoDisconnect] Desconectando guild ${guildId} por inactividad`);
    await textChannel.send("💤 Sin actividad — desconectando. ¡Hasta pronto!");
    await cleanupGuild(guildId, shoukaku);
  }, AUTO_DISCONNECT_MS);

  disconnectTimers.set(guildId, timer);
}

function cancelDisconnect(guildId: string): void {
  const timer = disconnectTimers.get(guildId);
  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(guildId);
  }
}

/**
 * Llama a esto desde index.ts cuando detectes que el bot
 * quedó solo en el canal de voz (evento voiceStateUpdate).
 */
export function onVoiceChannelEmpty(
  guildId: string,
  shoukaku: Shoukaku,
  textChannel: TextChannel
): void {
  const queue = queues.get(guildId);
  if (!queue) return;

  // Pausa la reproducción si estaba sonando
  if (queue.playing && !queue.paused) {
    queue.player.setPaused(true).catch(() => {});
    queue.pausedAt = Date.now() - queue.startedAt;
    queue.paused   = true;
  }

  scheduleDisconnect(guildId, shoukaku, textChannel);
}

/**
 * Llama a esto cuando alguien vuelve al canal de voz.
 */
export function onVoiceChannelJoined(guildId: string): void {
  cancelDisconnect(guildId);

  const queue = queues.get(guildId);
  if (!queue) return;

  // Reanuda si estaba pausado por el auto-disconnect
  if (queue.paused) {
    queue.player.setPaused(false).catch(() => {});
    queue.startedAt = Date.now() - queue.pausedAt;
    queue.pausedAt  = 0;
    queue.paused    = false;
  }
}

// ─────────────────────────────────────────────
// PREFERENCIAS POR SERVIDOR
// ─────────────────────────────────────────────

const guildPrefs = new Map<string, { shuffle: boolean; loop: boolean; volume: number }>();

function getPrefs(guildId: string) {
  if (!guildPrefs.has(guildId)) {
    guildPrefs.set(guildId, { shuffle: false, loop: false, volume: 100 });
  }
  return guildPrefs.get(guildId)!;
}

// ─────────────────────────────────────────────
// METADATA HELPERS
// ─────────────────────────────────────────────

function buildSearchQuery(meta: SpotifyMeta): string {
  const combined = meta.artist ? `${meta.name} ${meta.artist}` : meta.name;
  return `ytsearch:${combined}`;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function buildProgressBar(current: number, total: number, size = 16): string {
  const pct    = Math.min(current / total, 1);
  const filled = Math.round(pct * size);
  const empty  = size - filled;
  return (
    "▬".repeat(Math.max(filled - 1, 0)) +
    (filled > 0 ? "●" : "") +
    "─".repeat(empty)
  );
}

// ─────────────────────────────────────────────
// LAVALINK RESOLUTION (con caché)
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
  // Revisar caché primero
  const cached = cacheGet(query);
  if (cached) {
    console.log(`[Cache] Hit: ${query}`);
    return cached;
  }

  const node = getNode(shoukaku);

  const attempt = async (q: string): Promise<Track | null> => {
    try {
      const result = await node.rest.resolve(q);
      if (!result) return null;
      if (result.loadType === "empty" || result.loadType === "error") return null;
      if (result.loadType === "track")    return result.data as Track;
      if (result.loadType === "search")   return (result.data as Track[])[0] ?? null;
      if (result.loadType === "playlist") return (result.data as any).tracks?.[0] ?? null;
    } catch (err) {
      console.error(`[resolveQuery] Error con "${q}":`, err);
    }
    return null;
  };

  // Hasta 3 reintentos
  for (let i = 0; i < 3; i++) {
    const track = await attempt(query);
    if (track) {
      cacheSet(query, track); // guardar en caché
      return track;
    }
    if (i < 2) await new Promise((r) => setTimeout(r, 500));
  }

  // Fallback
  if (fallback && fallback !== query) {
    const cachedFallback = cacheGet(fallback);
    if (cachedFallback) return cachedFallback;

    console.warn(`[resolveQuery] Fallback: ${fallback}`);
    for (let i = 0; i < 2; i++) {
      const track = await attempt(fallback);
      if (track) {
        cacheSet(fallback, track);
        return track;
      }
      if (i < 1) await new Promise((r) => setTimeout(r, 500));
    }
  }

  return null;
}

async function resolveItem(shoukaku: Shoukaku, item: QueueItem): Promise<Track | null> {
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
// PLAYER CREATION
// ─────────────────────────────────────────────

async function getOrCreatePlayer(
  shoukaku: Shoukaku,
  guildId: string,
  voiceChannel: VoiceBasedChannel
): Promise<Player> {
  const stale = shoukaku.players.get(guildId);

  if (stale) {
    if (queues.has(guildId)) return stale;
    console.log(`[Player] Limpiando player zombie de guild ${guildId}`);
    try { await shoukaku.leaveVoiceChannel(guildId); } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  return shoukaku.joinVoiceChannel({
    guildId,
    shardId: 0,
    channelId: voiceChannel.id,
    deaf: true,
  });
}

// ─────────────────────────────────────────────
// QUEUE INIT
// ─────────────────────────────────────────────

function initQueue(
  shoukaku: Shoukaku,
  guildId: string,
  player: Player,
  textChannel: TextChannel
): GuildQueue {
  const existing = queues.get(guildId);
  if (existing) return existing;

  const prefs = getPrefs(guildId);

  const queue: GuildQueue = {
    player,
    tracks:       [],
    history:      [],
    playing:      false,
    shuffle:      prefs.shuffle,
    loop:         prefs.loop,
    currentTrack: null,
    startedAt:    0,
    pausedAt:     0,
    paused:       false,
  };

  queues.set(guildId, queue);

  player.on("end", async () => {
    const q = queues.get(guildId);
    if (!q) return;
    q.playing      = false;
    q.currentTrack = null;
    q.paused       = false;
    cancelDisconnect(guildId);
    await playNext(shoukaku, guildId, textChannel);
  });

  player.on("exception", async (data) => {
    const q = queues.get(guildId);
    if (!q || !q.playing) return;

    const title = (data as any)?.track?.info?.title ?? "desconocida";
    console.warn(`[Player:${guildId}] Track no disponible, saltando: ${title}`);

    q.playing      = false;
    q.currentTrack = null;
    q.paused       = false;

    await playNext(shoukaku, guildId, textChannel);
  });

  return queue;
}

// ─────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────

async function cleanupGuild(
  guildId: string,
  shoukaku?: Shoukaku
): Promise<void> {
  cancelDisconnect(guildId);

  const queue = queues.get(guildId);
  queues.delete(guildId);

  if (queue) {
    queue.playing      = false;
    queue.tracks       = [];
    queue.history      = [];
    queue.currentTrack = null;
    queue.paused       = false;
  }

  if (shoukaku) {
    try { await shoukaku.leaveVoiceChannel(guildId); } catch {}
  } else if (queue) {
    try { await queue.player.destroy(); } catch {}
  }
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
    cancelDisconnect(guildId); // alguien usó /play → cancelar cualquier timer de inactividad

    const player = await getOrCreatePlayer(shoukaku, guildId, voiceChannel);
    const queue  = initQueue(shoukaku, guildId, player, textChannel);

    // ─── SPOTIFY ────────────────────────────────────────────────────────
    if (query.includes("spotify.com")) {
      await textChannel.send("🎧 Conectando con Spotify...");

      let info: Awaited<ReturnType<typeof resolveSpotifyUrl>>;
      try {
        info = await resolveSpotifyUrl(query);
      } catch (err) {
        console.error("[Spotify] Error:", err);
        await textChannel.send("❌ No se pudo leer el enlace de Spotify.");
        return;
      }

      const { name: resourceName, total, tracks: allMetas } = info;

      if (allMetas.length === 0) {
        await textChannel.send("❌ No se encontraron canciones.");
        return;
      }

      const limited    = allMetas.slice(0, MAX_QUEUE_SIZE);
      const isPlaylist = limited.length > 1;
      const wasLimited = allMetas.length > MAX_QUEUE_SIZE;

      if (queue.shuffle && isPlaylist) {
        const idx        = randomIndex(limited.length);
        const chosenMeta = limited[idx];

        await textChannel.send(
          `🔀 Shuffle ON — **${resourceName}**\n` +
          `📋 ${limited.length} canciones` +
          (wasLimited ? ` (máx. ${MAX_QUEUE_SIZE} de ${total})` : "") +
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

        const restItems: QueueItem[] = shuffleArray(
          limited.filter((_, i) => i !== idx)
        ).map((m) => ({ pending: m } as QueueItem));

        const firstItem: QueueItem = { track: firstTrack };
        queue.tracks.push(firstItem, ...restItems);
        queue.history.push(firstItem, ...restItems);

        await textChannel.send(`✅ **${chosenMeta.name}** + ${restItems.length} más en cola.`);
        if (!queue.playing) await playNext(shoukaku, guildId, textChannel);
        return;
      }

      const firstMeta = limited[0];

      await textChannel.send(
        isPlaylist
          ? `📋 **${resourceName}** — ${limited.length} canciones` +
            (wasLimited ? ` (máx. ${MAX_QUEUE_SIZE} de ${total})` : "") +
            `\n▶️ Arrancando: **${firstMeta.name}**...`
          : `🔎 Buscando: **${firstMeta.name}**...`
      );

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
        const restItems: QueueItem[] = limited
          .slice(1)
          .map((m) => ({ pending: m } as QueueItem));
        queue.tracks.push(...restItems);
        queue.history.push(...restItems);
        await textChannel.send(
          `✅ **${firstMeta.name}** reproduciéndose + ${restItems.length} más en cola.`
        );
      }

      if (!queue.playing) await playNext(shoukaku, guildId, textChannel);
      return;
    }

    // ─── YOUTUBE / BÚSQUEDA NORMAL ──────────────────────────────────────
    const identifier = /^https?:\/\//.test(query) ? query : `ytsearch:${query}`;
    const resolved   = await resolveQuery(shoukaku, identifier);

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
// PLAY NEXT
// ─────────────────────────────────────────────

export async function playNext(
  shoukaku: Shoukaku,
  guildId: string,
  textChannel: TextChannel
): Promise<void> {
  const queue = queues.get(guildId);
  if (!queue) return;

  if (queue.tracks.length === 0 && queue.loop && queue.history.length > 0) {
    queue.tracks = queue.shuffle
      ? shuffleArray([...queue.history])
      : [...queue.history];
  }

  if (queue.shuffle && queue.tracks.length > 1) {
    const idx = randomIndex(queue.tracks.length);
    const [chosen] = queue.tracks.splice(idx, 1);
    queue.tracks.unshift(chosen);
  }

  const next = queue.tracks.shift();

  if (!next) {
    await textChannel.send("📭 Cola vacía. ¡Hasta la próxima!");
    // Programa desconexión en vez de desconectar inmediatamente
    // por si el usuario quiere añadir más canciones rápidamente
    scheduleDisconnect(guildId, shoukaku, textChannel);
    return;
  }

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
      console.warn(`[Lazy] No encontrado, saltando: ${label}`);
      queue.playing = false;
      return playNext(shoukaku, guildId, textChannel);
    }
  }

  if (!track) {
    queue.playing = false;
    return playNext(shoukaku, guildId, textChannel);
  }

  queue.playing      = true;
  queue.currentTrack = track;
  queue.startedAt    = Date.now();
  queue.pausedAt     = 0;
  queue.paused       = false;

  try {
    await queue.player.playTrack({ track: { encoded: track.encoded } });

    const dur       = track.info.length ? formatDuration(track.info.length) : "?";
    const remaining = queue.tracks.length;

    await textChannel.send(
      `🎵 **${track.info.title}** \`[${dur}]\`` +
      (remaining > 0 ? ` — 📋 ${remaining} en cola` : "")
    );
  } catch (err) {
    console.error("[playNext] Error:", err);
    queue.playing      = false;
    queue.currentTrack = null;
    await playNext(shoukaku, guildId, textChannel);
  }
}

// ─────────────────────────────────────────────
// SKIP / STOP / PAUSE / RESUME / SEEK
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
}

export async function stopSong(
  guildId: string,
  shoukaku?: Shoukaku
): Promise<void> {
  await cleanupGuild(guildId, shoukaku);
}

export async function pauseSong(guildId: string): Promise<"paused" | "not_playing"> {
  const queue = queues.get(guildId);
  if (!queue || !queue.playing || queue.paused) return "not_playing";
  await queue.player.setPaused(true);
  queue.pausedAt = Date.now() - queue.startedAt;
  queue.paused   = true;
  return "paused";
}

export async function resumeSong(guildId: string): Promise<"resumed" | "not_paused"> {
  const queue = queues.get(guildId);
  if (!queue || !queue.paused) return "not_paused";
  await queue.player.setPaused(false);
  queue.startedAt = Date.now() - queue.pausedAt;
  queue.pausedAt  = 0;
  queue.paused    = false;
  return "resumed";
}

export type SeekResult = "ok" | "not_playing" | "out_of_range" | "not_seekable";

export async function seekSong(
  guildId: string,
  positionMs: number
): Promise<SeekResult> {
  const queue = queues.get(guildId);
  if (!queue || !queue.playing || !queue.currentTrack) return "not_playing";
  const track = queue.currentTrack;
  if (track.info.isStream) return "not_seekable";
  const duration = track.info.length ?? 0;
  if (positionMs < 0 || positionMs > duration) return "out_of_range";
  await queue.player.seekTo(positionMs);
  queue.startedAt = Date.now() - positionMs;
  queue.pausedAt  = 0;
  return "ok";
}

// ─────────────────────────────────────────────
// NOW PLAYING
// ─────────────────────────────────────────────

export interface NowPlayingInfo {
  title:     string;
  author:    string;
  uri:       string | null;
  duration:  number;
  position:  number;
  paused:    boolean;
  shuffle:   boolean;
  loop:      boolean;
  remaining: number;
}

export function getNowPlaying(guildId: string): NowPlayingInfo | null {
  const queue = queues.get(guildId);
  if (!queue || !queue.currentTrack) return null;
  const track   = queue.currentTrack;
  const elapsed = queue.paused
    ? queue.pausedAt
    : Date.now() - queue.startedAt;
  return {
    title:     track.info.title,
    author:    track.info.author,
    uri:       track.info.uri ?? null,
    duration:  track.info.length ?? 0,
    position:  Math.min(elapsed, track.info.length ?? elapsed),
    paused:    queue.paused,
    shuffle:   queue.shuffle,
    loop:      queue.loop,
    remaining: queue.tracks.length,
  };
}

// ─────────────────────────────────────────────
// TOGGLES
// ─────────────────────────────────────────────

export function toggleShuffle(guildId: string): boolean {
  const prefs = getPrefs(guildId);
  prefs.shuffle = !prefs.shuffle;
  const queue = queues.get(guildId);
  if (queue) queue.shuffle = prefs.shuffle;
  return prefs.shuffle;
}

export function toggleLoop(guildId: string): boolean {
  const prefs = getPrefs(guildId);
  prefs.loop = !prefs.loop;
  const queue = queues.get(guildId);
  if (queue) queue.loop = prefs.loop;
  return prefs.loop;
}

export function getShuffleState(guildId: string): boolean {
  return queues.get(guildId)?.shuffle ?? getPrefs(guildId).shuffle;
}

// ─────────────────────────────────────────────
// QUEUE VIEW
// ─────────────────────────────────────────────

export function getQueue(guildId: string): string {
  const queue = queues.get(guildId);
  if (!queue || queue.tracks.length === 0) return "📭 La cola está vacía.";

  const lines = queue.tracks.slice(0, 20).map((item, i) => {
    if (item.track) {
      const dur = item.track.info.length ? formatDuration(item.track.info.length) : "?";
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

  const extra = queue.tracks.length > 20
    ? `\n_...y ${queue.tracks.length - 20} más._`
    : "";

  return `🎶 **Cola (${queue.tracks.length} canciones):**\n${lines.join("\n")}${extra}`;
}