// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import. Providers with no host
// needs (claude on api.anthropic.com, mock) don't appear here.
//
// AgentMesh fork: all three providers (claude, openai-compat, google)
// register a host-side container config that forwards both the provider-
// specific SDK env AND the AgentMesh platform context (tenant, user,
// connection state, platform URLs) into each per-session container.
//
// Upstream's claude.ts was conditional (only loaded for OneCLI proxy
// pattern); we override it with a fork variant that always passes the
// API key + platform env through.
import './claude.js';
import './openai.js';
import './google.js';
