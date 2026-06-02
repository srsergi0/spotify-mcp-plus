import type { MaxInt } from '@spotify/web-api-ts-sdk';
import { z } from 'zod';
import type {
  SpotifyEpisode,
  SpotifyEpisodesResponse,
  SpotifyHandlerExtra,
  SpotifySearchEpisodesResponse,
  SpotifySearchShowsResponse,
  SpotifyShow,
  SpotifySimplifiedEpisode,
  SpotifyTrack,
  tool,
} from './types.js';
import {
  createSpotifyApi,
  formatDuration,
  handleSpotifyRequest,
  loadSpotifyConfig,
  spotifyFetch,
} from './utils.js';

function isTrack(item: any): item is SpotifyTrack {
  return (
    item &&
    item.type === 'track' &&
    Array.isArray(item.artists) &&
    item.album &&
    typeof item.album.name === 'string'
  );
}

const SEARCH_TYPES = [
  'track',
  'album',
  'artist',
  'playlist',
  'episode',
  'show',
] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

function formatEpisode(ep: SpotifyEpisode, i: number): string {
  const duration = formatDuration(ep.duration_ms);
  const date = ep.release_date ? `, ${ep.release_date}` : '';
  const showName = ep.show?.name ?? 'Unknown show';
  return `${i + 1}. "${ep.name}" — ${showName} (${duration}${date}) - ID: ${ep.id}`;
}

function formatShow(show: SpotifyShow, i: number): string {
  return `${i + 1}. "${show.name}" by ${show.publisher} (${show.total_episodes} episodes) - ID: ${show.id}`;
}

const searchSpotify: tool<{
  query: z.ZodString;
  type: z.ZodEnum<[SearchType, ...SearchType[]]>;
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'searchSpotify',
  description:
    'Search for tracks, albums, artists, playlists, podcast episodes, or shows on Spotify. ' +
    'For episodes and shows, the query matches against title, description, and publisher. ' +
    'Use type "episode" to find individual podcast episodes by topic or guest name, ' +
    'and type "show" to find podcast series.',
  schema: {
    query: z
      .string()
      .describe(
        'The search query. Matches title, description, and publisher for podcasts.',
      ),
    type: z
      .enum(SEARCH_TYPES)
      .describe(
        'The type of item to search for: track, album, artist, playlist, episode (podcast episode), or show (podcast series)',
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of results to return (default: 10, max: 50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { query, type, limit } = args;
    const limitValue = limit ?? 10;

    try {
      let formattedResults = '';

      if (type === 'episode') {
        // Search returns SimplifiedEpisodeObject (no `show` field).
        // Batch-fetch full episode objects to include show info.
        const searchResults = await spotifyFetch<SpotifySearchEpisodesResponse>(
          'search',
          {
            query: { q: query, type, limit: limitValue, market: 'from_token' },
          },
        );
        const ids = searchResults.episodes.items
          .filter((ep): ep is SpotifySimplifiedEpisode => ep !== null)
          .map((ep) => ep.id)
          .join(',');
        if (!ids) {
          formattedResults = '';
        } else {
          const full = await spotifyFetch<SpotifyEpisodesResponse>('episodes', {
            query: { ids, market: 'from_token' },
          });
          formattedResults = full.episodes
            .filter((ep): ep is SpotifyEpisode => ep !== null)
            .map(formatEpisode)
            .join('\n');
        }
      } else if (type === 'show') {
        const results = await spotifyFetch<SpotifySearchShowsResponse>(
          'search',
          {
            query: { q: query, type, limit: limitValue, market: 'from_token' },
          },
        );
        formattedResults = results.shows.items
          .filter((show): show is SpotifyShow => show !== null)
          .map(formatShow)
          .join('\n');
      } else {
        const results = await handleSpotifyRequest(async (spotifyApi) => {
          return await spotifyApi.search(
            query,
            [type],
            undefined,
            limitValue as MaxInt<50>,
          );
        });

        if (type === 'track' && results.tracks) {
          formattedResults = results.tracks.items
            .map((track, i) => {
              const artists = track.artists.map((a) => a.name).join(', ');
              const duration = formatDuration(track.duration_ms);
              return `${i + 1}. "${track.name}" by ${artists} (${duration}) - ID: ${track.id}`;
            })
            .join('\n');
        } else if (type === 'album' && results.albums) {
          formattedResults = results.albums.items
            .map((album, i) => {
              const artists = album.artists.map((a) => a.name).join(', ');
              return `${i + 1}. "${album.name}" by ${artists} - ID: ${album.id}`;
            })
            .join('\n');
        } else if (type === 'artist' && results.artists) {
          formattedResults = results.artists.items
            .map((artist, i) => `${i + 1}. ${artist.name} - ID: ${artist.id}`)
            .join('\n');
        } else if (type === 'playlist' && results.playlists) {
          formattedResults = results.playlists.items
            .map((playlist, i) => {
              return `${i + 1}. "${playlist?.name ?? 'Unknown Playlist'} (${
                playlist?.description ?? 'No description'
              } tracks)" by ${playlist?.owner?.display_name} - ID: ${playlist?.id}`;
            })
            .join('\n');
        }
      }

      return {
        content: [
          {
            type: 'text',
            text:
              formattedResults.length > 0
                ? `# Search results for "${query}" (type: ${type})\n\n${formattedResults}`
                : `No ${type} results found for "${query}"`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error searching for ${type}s: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  },
};

const getNowPlaying: tool<Record<string, never>> = {
  name: 'getNowPlaying',
  description:
    'Get information about the currently playing track on Spotify, including device and volume info',
  schema: {},
  handler: async (_args, _extra: SpotifyHandlerExtra) => {
    try {
      const playback = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.player.getPlaybackState();
      });

      if (!playback?.item) {
        return {
          content: [
            {
              type: 'text',
              text: 'Nothing is currently playing on Spotify',
            },
          ],
        };
      }

      const item = playback.item;

      if (!isTrack(item)) {
        return {
          content: [
            {
              type: 'text',
              text: 'Currently playing item is not a track (might be a podcast episode)',
            },
          ],
        };
      }

      const artists = item.artists.map((a) => a.name).join(', ');
      const album = item.album.name;
      const duration = formatDuration(item.duration_ms);
      const progress = formatDuration(playback.progress_ms || 0);
      const isPlaying = playback.is_playing;

      const device = playback.device;
      const deviceInfo = device
        ? `${device.name} (${device.type})`
        : 'Unknown device';
      const volume =
        device?.volume_percent !== null && device?.volume_percent !== undefined
          ? `${device.volume_percent}%`
          : 'N/A';
      const shuffle = playback.shuffle_state ? 'On' : 'Off';
      const repeat = playback.repeat_state || 'off';

      return {
        content: [
          {
            type: 'text',
            text:
              `# Currently ${isPlaying ? 'Playing' : 'Paused'}\n\n` +
              `**Track**: "${item.name}"\n` +
              `**Artist**: ${artists}\n` +
              `**Album**: ${album}\n` +
              `**Progress**: ${progress} / ${duration}\n` +
              `**ID**: ${item.id}\n\n` +
              `**Device**: ${deviceInfo}\n` +
              `**Volume**: ${volume}\n` +
              `**Shuffle**: ${shuffle} | **Repeat**: ${repeat}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting current track: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getMyPlaylists: tool<{
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getMyPlaylists',
  description: "Get a list of the current user's playlists on Spotify",
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of playlists to return (1-50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { limit = 50 } = args;

    const playlists = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.currentUser.playlists.playlists(
        limit as MaxInt<50>,
      );
    });

    if (playlists.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "You don't have any playlists on Spotify",
          },
        ],
      };
    }

    const formattedPlaylists = playlists.items
      .map((playlist, i) => {
        const tracksTotal = playlist.tracks?.total ? playlist.tracks.total : 0;
        return `${i + 1}. "${playlist.name}" (${tracksTotal} tracks) - ID: ${
          playlist.id
        }`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Your Spotify Playlists\n\n${formattedPlaylists}`,
        },
      ],
    };
  },
};

const getPlaylistTracks: tool<{
  playlistId: z.ZodString;
  limit: z.ZodOptional<z.ZodNumber>;
  offset: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getPlaylistTracks',
  description: 'Get a list of tracks in a Spotify playlist',
  schema: {
    playlistId: z.string().describe('The Spotify ID of the playlist'),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of tracks to return (1-50)'),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe('Offset for pagination (0-based index)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { playlistId, limit = 50, offset = 0 } = args;

    // Hit /items directly: see spotifyFetch JSDoc for context.
    // Response wraps each entry's track under `item` (new) or `track` (legacy).
    // additional_types=episode is required for Spotify to return episode objects.
    type PlaylistItemEntry = {
      item?: SpotifyTrack | SpotifyEpisode | null;
      track?: SpotifyTrack | SpotifyEpisode | null;
    };
    const playlistTracks = await spotifyFetch<{
      items: PlaylistItemEntry[];
      total: number;
    }>(`playlists/${playlistId}/items`, {
      query: { limit, offset, additional_types: 'track,episode' },
    });

    if ((playlistTracks.items?.length ?? 0) === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "This playlist doesn't have any tracks",
          },
        ],
      };
    }

    const formattedTracks = playlistTracks.items
      .map((entry, i) => {
        const track = entry.item ?? entry.track;
        if (!track) return `${offset + i + 1}. [Removed track]`;

        if (isTrack(track)) {
          const artists = track.artists.map((a) => a.name).join(', ');
          const duration = formatDuration(track.duration_ms);
          return `${offset + i + 1}. "${track.name}" by ${artists} (${duration}) - ID: ${track.id}`;
        }

        if (track.type === 'episode') {
          return formatEpisode(track as SpotifyEpisode, offset + i);
        }

        return `${offset + i + 1}. Unknown item`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Tracks in Playlist (${offset + 1}-${offset + playlistTracks.items.length} of ${playlistTracks.total})\n\n${formattedTracks}`,
        },
      ],
    };
  },
};

const getRecentlyPlayed: tool<{
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getRecentlyPlayed',
  description: 'Get a list of recently played tracks on Spotify',
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of tracks to return (1-50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { limit = 50 } = args;

    const history = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.player.getRecentlyPlayedTracks(
        limit as MaxInt<50>,
      );
    });

    if (history.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "You don't have any recently played tracks on Spotify",
          },
        ],
      };
    }

    const formattedHistory = history.items
      .map((item, i) => {
        const track = item.track;
        if (!track) return `${i + 1}. [Removed track]`;

        if (isTrack(track)) {
          const artists = track.artists.map((a) => a.name).join(', ');
          const duration = formatDuration(track.duration_ms);
          const playedAt = item.played_at
            ? new Date(item.played_at).toLocaleString()
            : 'Unknown time';
          return `${i + 1}. "${track.name}" by ${artists} (${duration}) - ID: ${track.id} - Played at: ${playedAt}`;
        }

        return `${i + 1}. Unknown item`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Recently Played Tracks\n\n${formattedHistory}`,
        },
      ],
    };
  },
};

const getUsersSavedTracks: tool<{
  limit: z.ZodOptional<z.ZodNumber>;
  offset: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getUsersSavedTracks',
  description:
    'Get a list of tracks saved in the user\'s "Liked Songs" library',
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of tracks to return (1-50)'),
    offset: z
      .number()
      .min(0)
      .optional()
      .describe('Offset for pagination (0-based index)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { limit = 50, offset = 0 } = args;

    const savedTracks = await handleSpotifyRequest(async (spotifyApi) => {
      return await spotifyApi.currentUser.tracks.savedTracks(
        limit as MaxInt<50>,
        offset,
      );
    });

    if (savedTracks.items.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: "You don't have any saved tracks in your Liked Songs",
          },
        ],
      };
    }

    const formattedTracks = savedTracks.items
      .map((item, i) => {
        const track = item.track;
        if (!track) return `${i + 1}. [Removed track]`;

        if (isTrack(track)) {
          const artists = track.artists.map((a) => a.name).join(', ');
          const duration = formatDuration(track.duration_ms);
          const addedDate = new Date(item.added_at).toLocaleDateString();
          return `${offset + i + 1}. "${track.name}" by ${artists} (${duration}) - ID: ${track.id} - Added: ${addedDate}`;
        }

        return `${i + 1}. Unknown item`;
      })
      .join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `# Your Liked Songs (${offset + 1}-${offset + savedTracks.items.length} of ${savedTracks.total})\n\n${formattedTracks}`,
        },
      ],
    };
  },
};

const getQueue: tool<{
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getQueue',
  description:
    'Get a list of the currently playing track and the next items in your Spotify queue',
  schema: {
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of upcoming items to show (1-50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { limit = 10 } = args;

    try {
      const queue = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.player.getUsersQueue();
      });

      const current = (queue as any)?.currently_playing;
      const upcoming = ((queue as any)?.queue ?? []) as any[];

      const header = '# Spotify Queue\n\n';

      let currentText = 'Nothing is currently playing';
      if (current) {
        const name = current?.name ?? 'Unknown';
        const artists = Array.isArray(current?.artists)
          ? (current.artists as Array<{ name: string }>)
              .map((a) => a.name)
              .join(', ')
          : 'Unknown';
        const duration =
          typeof current?.duration_ms === 'number'
            ? formatDuration(current.duration_ms)
            : 'Unknown';
        currentText = `Currently Playing: "${name}" by ${artists} (${duration})`;
      }

      if (upcoming.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `${header}${currentText}\n\nNo upcoming items in the queue`,
            },
          ],
        };
      }

      const toShow = upcoming.slice(0, limit);
      const formatted = toShow
        .map((track, i) => {
          const name = track?.name ?? 'Unknown';
          const artists = Array.isArray(track?.artists)
            ? (track.artists as Array<{ name: string }>)
                .map((a) => a.name)
                .join(', ')
            : 'Unknown';
          const duration =
            typeof track?.duration_ms === 'number'
              ? formatDuration(track.duration_ms)
              : 'Unknown';
          const id = track?.id ?? 'Unknown';
          return `${i + 1}. "${name}" by ${artists} (${duration}) - ID: ${id}`;
        })
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `${header}${currentText}\n\nNext ${toShow.length} in queue:\n\n${formatted}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error fetching queue: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getAvailableDevices: tool<Record<string, never>> = {
  name: 'getAvailableDevices',
  description:
    "Get information about the user's available Spotify Connect devices",
  schema: {},
  handler: async (_args, _extra: SpotifyHandlerExtra) => {
    try {
      const devices = await handleSpotifyRequest(async (spotifyApi) => {
        return await spotifyApi.player.getAvailableDevices();
      });

      if (!devices.devices || devices.devices.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No available devices found. Make sure Spotify is open on at least one device.',
            },
          ],
        };
      }

      const formattedDevices = devices.devices
        .map((device, i) => {
          const status = device.is_active ? '▶ Active' : '○ Inactive';
          const volume =
            device.volume_percent !== null
              ? `${device.volume_percent}%`
              : 'N/A';
          const restricted = device.is_restricted ? ' (Restricted)' : '';
          return `${i + 1}. ${device.name} (${device.type})${restricted}\n   Status: ${status} | Volume: ${volume} | ID: ${device.id}`;
        })
        .join('\n\n');

      return {
        content: [
          {
            type: 'text',
            text: `# Available Spotify Devices\n\n${formattedDevices}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting available devices: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const removeUsersSavedTracks: tool<{
  trackIds: z.ZodArray<z.ZodString>;
}> = {
  name: 'removeUsersSavedTracks',
  description:
    'Remove one or more tracks from the user\'s "Liked Songs" library (max 40 per request)',
  schema: {
    trackIds: z
      .array(z.string())
      .max(40)
      .describe('Array of Spotify track IDs to remove (max 40)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { trackIds } = args;

    if (trackIds.length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: No track IDs provided' }],
      };
    }

    try {
      // Ensure token is fresh (handles auto-refresh if needed)
      await createSpotifyApi();
      const config = loadSpotifyConfig();

      const uris = trackIds.map((id) => `spotify:track:${id}`).join(',');
      const response = await fetch(
        `https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(uris)}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
          },
        },
      );

      if (!response.ok) {
        const errorData = await response.text();
        throw new Error(`Spotify API error ${response.status}: ${errorData}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: `Successfully removed ${trackIds.length} track${trackIds.length === 1 ? '' : 's'} from your Liked Songs`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error removing tracks from Liked Songs: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getTopItems: tool<{
  type: z.ZodEnum<['artists', 'tracks']>;
  timeRange: z.ZodOptional<z.ZodEnum<['short_term', 'medium_term', 'long_term']>>;
  limit: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getTopItems',
  description:
    'Get the user\'s top artists or tracks based on calculated affinity. ' +
    'Use time_range to get data from different time periods.',
  schema: {
    type: z
      .enum(['artists', 'tracks'])
      .describe('Whether to get top artists or tracks'),
    timeRange: z
      .enum(['short_term', 'medium_term', 'long_term'])
      .optional()
      .describe(
        'Time range: short_term (~4 weeks), medium_term (~6 months, default), long_term (~years)',
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .optional()
      .describe('Maximum number of items to return (1-50)'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { type, timeRange, limit = 20 } = args;

    try {
      const results = await handleSpotifyRequest(async (spotifyApi) => {
        if (type === 'artists') {
          return await spotifyApi.currentUser.topItems(
            'artists',
            timeRange || 'medium_term',
            limit as MaxInt<50>,
          );
        }
        return await spotifyApi.currentUser.topItems(
          'tracks',
          timeRange || 'medium_term',
          limit as MaxInt<50>,
        );
      });

      if (results.items.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No top ${type} found for the selected time range`,
            },
          ],
        };
      }

      const formattedItems = results.items
        .map((item, i) => {
          if (type === 'artists') {
            const artist = item as any;
            return `${i + 1}. ${artist.name} - ID: ${artist.id}`;
          }
          const track = item as SpotifyTrack;
          const artists = track.artists.map((a) => a.name).join(', ');
          const duration = formatDuration(track.duration_ms);
          return `${i + 1}. "${track.name}" by ${artists} (${duration}) - ID: ${track.id}`;
        })
        .join('\n');

      const rangeLabel = {
        short_term: 'Last 4 weeks',
        medium_term: 'Last 6 months',
        long_term: 'All time',
      }[timeRange || 'medium_term'];

      return {
        content: [
          {
            type: 'text',
            text: `# Top ${type === 'artists' ? 'Artists' : 'Tracks'} (${rangeLabel})\n\n${formattedItems}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting top items: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getAudioFeatures: tool<{
  trackIds: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString>]>;
}> = {
  name: 'getAudioFeatures',
  description:
    'Get audio features for one or more tracks (danceability, energy, tempo, valence, etc.). ' +
    'Useful for understanding the musical characteristics of songs.',
  schema: {
    trackIds: z
      .union([z.string(), z.array(z.string()).max(100)])
      .describe(
        'A single track ID or array of track IDs (max 100)',
      ),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const { trackIds } = args;
    const ids = Array.isArray(trackIds) ? trackIds : [trackIds];

    if (ids.length === 0) {
      return {
        content: [
          { type: 'text', text: 'Error: No track IDs provided' },
        ],
      };
    }

    try {
      if (ids.length === 1) {
        const features = await handleSpotifyRequest(async (spotifyApi) => {
          return await spotifyApi.tracks.audioFeatures(ids[0]);
        });

        if (!features) {
          return {
            content: [
              { type: 'text', text: 'No audio features found for this track' },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text:
                `# Audio Features for Track ${ids[0]}\n\n` +
                `**Danceability**: ${features.danceability} (0-1)\n` +
                `**Energy**: ${features.energy} (0-1)\n` +
                `**Valence**: ${features.valence} (0-1, musical positivity)\n` +
                `**Tempo**: ${features.tempo} BPM\n` +
                `**Key**: ${features.key}\n` +
                `**Mode**: ${features.mode === 1 ? 'Major' : 'Minor'}\n` +
                `**Time Signature**: ${features.time_signature}/4\n` +
                `**Acousticness**: ${features.acousticness} (0-1)\n` +
                `**Instrumentalness**: ${features.instrumentalness} (0-1)\n` +
                `**Liveness**: ${features.liveness} (0-1)\n` +
                `**Speechiness**: ${features.speechiness} (0-1)\n` +
                `**Loudness**: ${features.loudness} dB`,
            },
          ],
        };
      }

      const features = await spotifyFetch<{ audio_features: Array<any> }>(
        'audio-features',
        { query: { ids: ids.join(',') } },
      );

      if (!features.audio_features || features.audio_features.length === 0) {
        return {
          content: [
            { type: 'text', text: 'No audio features found for the provided tracks' },
          ],
        };
      }

      const formatted = features.audio_features
        .filter((f: any) => f !== null)
        .map((f: any, i: number) =>
          `${i + 1}. Track ${f.id}: Dance=${f.danceability} Energy=${f.energy} Valence=${f.valence} Tempo=${f.tempo}BPM`
        )
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `# Audio Features (${features.audio_features.filter((f: any) => f !== null).length} tracks)\n\n${formatted}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting audio features: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

interface RecommendationParams {
  seed_artists?: string[];
  seed_genres?: string[];
  seed_tracks?: string[];
  limit?: number;
  target_danceability?: number;
  target_energy?: number;
  target_valence?: number;
  target_tempo?: number;
  target_acousticness?: number;
  target_instrumentalness?: number;
  min_energy?: number;
  max_energy?: number;
  min_tempo?: number;
  max_tempo?: number;
}

const getRecommendations: tool<{
  seedArtists: z.ZodOptional<z.ZodArray<z.ZodString>>;
  seedGenres: z.ZodOptional<z.ZodArray<z.ZodString>>;
  seedTracks: z.ZodOptional<z.ZodArray<z.ZodString>>;
  limit: z.ZodOptional<z.ZodNumber>;
  targetDanceability: z.ZodOptional<z.ZodNumber>;
  targetEnergy: z.ZodOptional<z.ZodNumber>;
  targetValence: z.ZodOptional<z.ZodNumber>;
  targetTempo: z.ZodOptional<z.ZodNumber>;
}> = {
  name: 'getRecommendations',
  description:
    'Get track recommendations based on seed artists, genres, and tracks. ' +
    'You can provide up to 5 seeds total across all types. ' +
    'Optional target values let you fine-tune the audio characteristics. ' +
    'Use getAvailableGenres tool to see valid genre seeds.',
  schema: {
    seedArtists: z
      .array(z.string())
      .max(5)
      .optional()
      .describe('Array of Spotify artist IDs to seed recommendations (max 5 total seeds)'),
    seedGenres: z
      .array(z.string())
      .max(5)
      .optional()
      .describe('Array of genre names to seed recommendations (e.g. "rock", "pop", "electronic")'),
    seedTracks: z
      .array(z.string())
      .max(5)
      .optional()
      .describe('Array of Spotify track IDs to seed recommendations (max 5 total seeds)'),
    limit: z
      .number()
      .min(1)
      .max(100)
      .optional()
      .describe('Number of recommendations to return (1-100, default: 20)'),
    targetDanceability: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Target danceability (0-1)'),
    targetEnergy: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Target energy (0-1)'),
    targetValence: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Target valence/positivity (0-1)'),
    targetTempo: z
      .number()
      .min(0)
      .optional()
      .describe('Target tempo in BPM'),
  },
  handler: async (args, _extra: SpotifyHandlerExtra) => {
    const {
      seedArtists,
      seedGenres,
      seedTracks,
      limit = 20,
      targetDanceability,
      targetEnergy,
      targetValence,
      targetTempo,
    } = args;

    const totalSeeds =
      (seedArtists?.length ?? 0) +
      (seedGenres?.length ?? 0) +
      (seedTracks?.length ?? 0);

    if (totalSeeds === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Must provide at least one seed (seed_artists, seed_genres, or seed_tracks)',
          },
        ],
      };
    }

    if (totalSeeds > 5) {
      return {
        content: [
          {
            type: 'text',
            text: 'Error: Maximum 5 total seeds allowed across all types',
          },
        ],
      };
    }

    try {
      const params: RecommendationParams = { limit };
      if (seedArtists) params.seed_artists = seedArtists;
      if (seedGenres) params.seed_genres = seedGenres;
      if (seedTracks) params.seed_tracks = seedTracks;
      if (targetDanceability !== undefined) params.target_danceability = targetDanceability;
      if (targetEnergy !== undefined) params.target_energy = targetEnergy;
      if (targetValence !== undefined) params.target_valence = targetValence;
      if (targetTempo !== undefined) params.target_tempo = targetTempo;

      const query: Record<string, string | number> = {};
      if (params.seed_artists) query.seed_artists = params.seed_artists.join(',');
      if (params.seed_genres) query.seed_genres = params.seed_genres.join(',');
      if (params.seed_tracks) query.seed_tracks = params.seed_tracks.join(',');
      if (params.limit) query.limit = params.limit;
      if (params.target_danceability !== undefined) query.target_danceability = params.target_danceability;
      if (params.target_energy !== undefined) query.target_energy = params.target_energy;
      if (params.target_valence !== undefined) query.target_valence = params.target_valence;
      if (params.target_tempo !== undefined) query.target_tempo = params.target_tempo;

      const results = await spotifyFetch<{ tracks: any[] }>(
        'recommendations',
        { query },
      );

      if (!results.tracks || results.tracks.length === 0) {
        return {
          content: [
            { type: 'text', text: 'No recommendations found for the given seeds' },
          ],
        };
      }

      const formattedTracks = results.tracks
        .map((track: any, i: number) => {
          const artists = Array.isArray(track.artists)
            ? track.artists.map((a: any) => a.name).join(', ')
            : 'Unknown';
          const duration = formatDuration(track.duration_ms);
          return `${i + 1}. "${track.name}" by ${artists} (${duration}) - ID: ${track.id}`;
        })
        .join('\n');

      const seedsUsed = [];
      if (seedArtists) seedsUsed.push(`${seedArtists.length} artist(s)`);
      if (seedGenres) seedsUsed.push(`${seedGenres.length} genre(s)`);
      if (seedTracks) seedsUsed.push(`${seedTracks.length} track(s)`);

      return {
        content: [
          {
            type: 'text',
            text: `# Recommendations\n\n**Seeds**: ${seedsUsed.join(', ')}\n\n${formattedTracks}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting recommendations: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

const getAvailableGenres: tool<Record<string, never>> = {
  name: 'getAvailableGenres',
  description: 'Get a list of available genre seeds for use with recommendations',
  schema: {},
  handler: async (_args, _extra: SpotifyHandlerExtra) => {
    try {
      const results = await spotifyFetch<{ genres: string[] }>(
        'recommendations/available-genre-seeds',
      );

      if (!results.genres || results.genres.length === 0) {
        return {
          content: [
            { type: 'text', text: 'No genre seeds available' },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: `# Available Genre Seeds (${results.genres.length} genres)\n\n${results.genres.join(', ')}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting genre seeds: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        ],
      };
    }
  },
};

export const readTools = [
  searchSpotify,
  getNowPlaying,
  getMyPlaylists,
  getPlaylistTracks,
  getRecentlyPlayed,
  getUsersSavedTracks,
  removeUsersSavedTracks,
  getQueue,
  getAvailableDevices,
  getTopItems,
  getAudioFeatures,
  getRecommendations,
  getAvailableGenres,
];
