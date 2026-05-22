import { Player, Track } from "shoukaku";

export interface SpotifyMeta {
  name: string;
  artist: string;
}

export interface QueueItem {
  track?: Track;
  pending?: SpotifyMeta;
}

export interface GuildQueue {
  player: Player;
  tracks: QueueItem[];
  history: QueueItem[];
  playing: boolean;
  shuffle: boolean;
  loop: boolean;

  // ── Estado de la canción actual ──────────────
  /** Track que está sonando ahora mismo */
  currentTrack: Track | null;
  /** Timestamp (Date.now()) en que arrancó la canción actual */
  startedAt: number;
  /** Milisegundos acumulados antes de la pausa actual */
  pausedAt: number;
  /** true si el player está pausado */
  paused: boolean;
}

export const queues = new Map<string, GuildQueue>();