import { Track } from "shoukaku";

export interface QueueItem {
  track: Track;
}

export interface GuildQueue {
  player: any;
  tracks: QueueItem[];
  playing: boolean;
}

export const queues = new Map<string, GuildQueue>();