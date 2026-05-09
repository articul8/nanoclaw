// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude on api.anthropic.com, mock) don't appear here.
//
// AgentMesh fork additions: openai-compat + google providers forward the
// provider-specific env (OPENAI_*/GOOGLE_*) into the per-session container.
import './openai.js';
import './google.js';
