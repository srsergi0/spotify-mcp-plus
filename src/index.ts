import { McpServer, StdioServerTransport } from 'mcp-lite';
import { albumTools } from './albums.js';
import { playTools } from './play.js';
import { playlistTools } from './playlist.js';
import { readTools } from './read.js';
import { createSpotifyApi } from './utils.js';

const server = new McpServer({
  name: 'spotify-controller',
  version: '1.0.0',
});

[...readTools, ...playTools, ...albumTools, ...playlistTools].forEach(
  (tool) => {
    server.tool(tool.name, tool.description, tool.schema, tool.handler);
  },
);

// Proactively refresh the Spotify token so it never expires mid-session.
// The SDK's internal refresh uses PKCE (no client_secret) so it fails for
// Authorization Code flow. Instead, our createSpotifyApi() refreshes via
// Basic Auth and sets expires=MAX_SAFE_INTEGER on the SDK instance to
// prevent it from ever attempting its own refresh.
// Interval of 25 minutes ensures we always catch the 60-minute expiry.
setInterval(
  async () => {
    try {
      await createSpotifyApi();
    } catch {
      // Errors will surface on the next tool call; nothing actionable here.
    }
  },
  25 * 60 * 1000,
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
