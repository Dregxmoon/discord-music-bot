import SpotifyWebApi from "spotify-web-api-node";
import { SpotifyMeta } from "./queue";

const nodeFetch = require("node-fetch");

// ─────────────────────────────────────────────
// CLIENTES
// ─────────────────────────────────────────────

// Cliente oficial (Web API) — para playlists completas sin límite de 100
const spotifyApi = new SpotifyWebApi({
  clientId:     process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
});

// Fallback scraping — para cuando la Web API devuelve 403
const { getData: scrapGetData, getTracks: scrapGetTracks } =
  require("spotify-url-info")(nodeFetch);

let tokenExpiresAt = 0;

async function ensureToken(): Promise<void> {
  if (Date.now() < tokenExpiresAt - 30_000) return;
  const data = await spotifyApi.clientCredentialsGrant();
  spotifyApi.setAccessToken(data.body.access_token);
  tokenExpiresAt = Date.now() + data.body.expires_in * 1000;
  console.log("[Spotify] Token renovado, válido por", data.body.expires_in, "s");
}

// ─────────────────────────────────────────────
// VALIDACIÓN DE ARTISTAS
// ─────────────────────────────────────────────

const ARTIST_BLACKLIST = [
  "playlist", "spotify", "album", "single", "ep",
  "compilation", "various artists", "varios artistas",
];
const LOOKS_LIKE_USERNAME = /^[A-Z][a-z]+[A-Z][a-z]+\d*$|^\w{3,}\d{3,}$/;

function isValidArtist(value: unknown): value is string {
  if (!value || typeof value !== "string") return false;
  const s = value.trim();
  if (s.length < 2) return false;
  if (ARTIST_BLACKLIST.some((b) => s.toLowerCase().includes(b))) return false;
  if (LOOKS_LIKE_USERNAME.test(s)) return false;
  return true;
}

function extractArtistFromObjects(artists: Array<{ name: string }>): string {
  return artists
    .map((a) => a.name)
    .filter(isValidArtist)
    .slice(0, 2)
    .join(" ");
}

// ─────────────────────────────────────────────
// RESULTADO PÚBLICO
// ─────────────────────────────────────────────

export interface SpotifyResult {
  name: string;
  total: number;
  tracks: SpotifyMeta[];
}

// ─────────────────────────────────────────────
// EXTRAE ID Y TIPO DE URL
// ─────────────────────────────────────────────

function parseUrl(url: string): { type: "track" | "playlist" | "album"; id: string } | null {
  // Soporta URLs con y sin prefijo de idioma:
  //   open.spotify.com/track/ID
  //   open.spotify.com/intl-es/track/ID
  //   open.spotify.com/intl-pt/playlist/ID
  //   spotify:track:ID
  // También limpia el query string (?si=xxx) antes de parsear
  const clean = url.split("?")[0];
  const match = clean.match(
    /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?)?(track|playlist|album)[/:]([A-Za-z0-9]+)/
  );
  if (!match) return null;
  return { type: match[1] as "track" | "playlist" | "album", id: match[2] };
}

// ─────────────────────────────────────────────
// WEB API — TRACK
// ─────────────────────────────────────────────

async function apiGetTrack(id: string): Promise<SpotifyResult> {
  await ensureToken();
  const res    = await spotifyApi.getTrack(id);
  const track  = res.body;
  const name   = track.name?.trim();
  if (!name) throw new Error("Track sin nombre");
  const artist = extractArtistFromObjects(track.artists ?? []);
  return { name, total: 1, tracks: [{ name, artist }] };
}

// ─────────────────────────────────────────────
// WEB API — PLAYLIST (paginación completa)
// ─────────────────────────────────────────────

async function apiGetPlaylist(id: string): Promise<SpotifyResult> {
  await ensureToken();

  const [playlistRes, firstPage] = await Promise.all([
    spotifyApi.getPlaylist(id, { fields: "name,tracks.total" } as any),
    spotifyApi.getPlaylistTracks(id, { limit: 100, offset: 0 }),
  ]);

  const playlistName = playlistRes.body.name ?? "Playlist";
  const total        = firstPage.body.total;
  const metas: SpotifyMeta[] = [];

  for (const item of firstPage.body.items) {
    const t = item?.track as any;
    if (!t || t.type !== "track" || !t.name?.trim()) continue;
    metas.push({
      name:   t.name.trim(),
      artist: extractArtistFromObjects(t.artists ?? []),
    });
  }

  // Paginación: Spotify devuelve máx 100 por request
  let offset = 100;
  while (offset < total) {
    await ensureToken();
    const page = await spotifyApi.getPlaylistTracks(id, { limit: 100, offset });
    for (const item of page.body.items) {
      const t = item?.track as any;
      if (!t || t.type !== "track" || !t.name?.trim()) continue;
      metas.push({
        name:   t.name.trim(),
        artist: extractArtistFromObjects(t.artists ?? []),
      });
    }
    offset += 100;
    console.log(`[Spotify API] Playlist ${id}: ${metas.length}/${total}`);
  }

  return { name: playlistName, total, tracks: metas };
}

// ─────────────────────────────────────────────
// WEB API — ALBUM (paginación completa)
// ─────────────────────────────────────────────

async function apiGetAlbum(id: string): Promise<SpotifyResult> {
  await ensureToken();
  const res         = await spotifyApi.getAlbum(id);
  const album       = res.body;
  const total       = album.tracks.total;
  const albumArtist = extractArtistFromObjects(album.artists ?? []);
  const metas: SpotifyMeta[] = [];

  for (const t of album.tracks.items) {
    if (!t.name?.trim()) continue;
    metas.push({
      name:   t.name.trim(),
      artist: extractArtistFromObjects(t.artists ?? []) || albumArtist,
    });
  }

  let offset = album.tracks.items.length;
  while (offset < total) {
    await ensureToken();
    const page = await spotifyApi.getAlbumTracks(id, { limit: 50, offset });
    for (const t of page.body.items) {
      if (!t.name?.trim()) continue;
      metas.push({
        name:   t.name.trim(),
        artist: extractArtistFromObjects(t.artists ?? []) || albumArtist,
      });
    }
    offset += 50;
    console.log(`[Spotify API] Album ${id}: ${metas.length}/${total}`);
  }

  return { name: album.name, total, tracks: metas };
}

// ─────────────────────────────────────────────
// FALLBACK — spotify-url-info (scraping)
// Úsase cuando la Web API devuelve 403 (playlist privada
// o usuario no añadido en Development Mode)
// ─────────────────────────────────────────────

async function scrapingFallback(url: string): Promise<SpotifyResult> {
  console.warn("[Spotify] Web API falló con 403 → usando scraping como fallback");

  const [rawTracks, meta] = await Promise.all([
    scrapGetTracks(url),
    scrapGetData(url).catch(() => ({})),
  ]);

  const tracks = Array.isArray(rawTracks) ? rawTracks : [];
  const metas: SpotifyMeta[] = [];

  for (const t of tracks) {
    const name = (t?.name ?? t?.title ?? "").trim();
    if (!name) continue;

    let artist = "";
    if (Array.isArray(t?.artists)) {
      artist = t.artists
        .map((a: any) => (typeof a === "string" ? a : a?.name))
        .filter(isValidArtist)
        .slice(0, 2)
        .join(" ");
    } else if (isValidArtist(t?.artist)) {
      artist = t.artist.trim();
    } else if (isValidArtist(t?.subtitle)) {
      artist = t.subtitle.trim();
    }

    metas.push({ name, artist });
  }

  return {
    name:   meta?.name ?? meta?.title ?? "Spotify",
    total:  meta?.tracks?.total ?? metas.length,
    tracks: metas,
  };
}

// ─────────────────────────────────────────────
// ENTRY POINT PÚBLICO
// ─────────────────────────────────────────────

/**
 * Resuelve cualquier URL de Spotify.
 *
 * Estrategia:
 * 1. Intenta con la Web API oficial (paginación completa, sin límite de 100)
 * 2. Si falla con 403 (playlist privada / dev mode) → cae a scraping
 * 3. Si falla por otro motivo → lanza el error
 */
export async function resolveSpotifyUrl(url: string): Promise<SpotifyResult> {
  const parsed = parseUrl(url);
  if (!parsed) throw new Error(`URL de Spotify no reconocida: ${url}`);

  try {
    switch (parsed.type) {
      case "track":    return await apiGetTrack(parsed.id);
      case "playlist": return await apiGetPlaylist(parsed.id);
      case "album":    return await apiGetAlbum(parsed.id);
    }
  } catch (err: any) {
    // 403 = Development Mode sin acceso → fallback a scraping
    if (err?.statusCode === 403 || err?.body?.error?.status === 403) {
      return scrapingFallback(url);
    }
    throw err;
  }
}