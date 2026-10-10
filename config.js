// Nothing in this file is secret. A Spotify client ID is safe to publish;
// the login uses PKCE, which needs no client secret.
window.DASH_CONFIG = {
  title: 'Dashboard',
  // Shown in the greeting ("Good evening, Luis"). Leave '' for no name.
  name: 'Luis',
  // Background videos: every .mp4 or .webm file uploaded to the repo is picked up
  // automatically and shuffled. Nothing to list here.
  // How long each video stays up before fading to the next one, in seconds.
  sceneSeconds: 60,
  // Client ID from https://developer.spotify.com/dashboard
  spotifyClientId: '7c14e2b7fae742eeb1a5a91b69883df6',
};
