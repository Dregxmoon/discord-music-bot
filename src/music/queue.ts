import { Player, Track } from "shoukaku";

// ─────────────────────────────────────────────
// TIPOS
// ─────────────────────────────────────────────

/**
 * Metadata de Spotify sin resolver contra Lavalink todavía.
 * Se usa para lazy loading: encolamos la info primero,
 * resolvemos contra YouTube justo antes de reproducir.
 */
export interface SpotifyMeta {
  name: string;
  artist: string;
}

/**
 * Un item en la cola puede estar:
 * - Resuelto: { track } listo para reproducir inmediatamente
 * - Pendiente: { pending } solo metadata, se resuelve cuando le toca
 *
 * Nunca tendrá ambos a la vez.
 */
export interface QueueItem {
  track?: Track;
  pending?: SpotifyMeta;
}

/**
 * Estado completo de la cola de un servidor.
 */
export interface GuildQueue {
  player: Player;

  /** Cola de reproducción — mezcla de items resueltos y pendientes */
  tracks: QueueItem[];

  /**
   * Historial completo de lo que se agregó.
   * Se usa para recargar la cola cuando loop está activo.
   */
  history: QueueItem[];

  /** true mientras el player está reproduciendo activamente */
  playing: boolean;

  /** Modo aleatorio activo/inactivo */
  shuffle: boolean;

  /** Loop infinito activo/inactivo */
  loop: boolean;
}

// ─────────────────────────────────────────────
// MAPA GLOBAL DE COLAS
// ─────────────────────────────────────────────

/** Una cola por servidor (guildId) */
export const queues = new Map<string, GuildQueue>();