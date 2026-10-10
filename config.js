// Nothing in this file is secret. A Spotify client ID is safe to publish;
// the login uses PKCE, which needs no client secret.
window.DASH_CONFIG = {
  title: 'Dashboard',
  // LDB glass watermark in the top-left corner. Set to false to hide it.
  brand: true,
  // Shown in the greeting ("Good evening, Luis"). Leave '' for no name.
  name: 'Luis',
  // Background videos: every .mp4 or .webm file uploaded to the repo is picked up
  // automatically and shuffled. Nothing to list here.
  // Each video plays through once, then fades to the next. Videos longer than
  // this many seconds are cut off early so one long clip does not hog the screen.
  sceneSeconds: 60,
  // Quick-link buttons under the clock. Add, remove, or reorder as you like.
  links: [
    { name: 'Canvas', url: 'https://bryant.instructure.com' },
    { name: 'Outlook', url: 'https://outlook.office.com' },
    { name: 'Spotify', url: 'https://open.spotify.com' },
    { name: 'GitHub', url: 'https://github.com/ldiazbusquets/dashboard' },
  ],
  // Client ID from https://developer.spotify.com/dashboard
  spotifyClientId: '7c14e2b7fae742eeb1a5a91b69883df6',
};
