import { Player, Track } from "shoukaku";

export interface QueueTrack {
  track: Track;
}

export interface GuildQueue {
  player: Player;

  tracks: QueueTrack[];

  history: QueueTrack[];

  playing: boolean;

  shuffle: boolean;

  loop: boolean;
}

export const queues = new Map<string, GuildQueue>();