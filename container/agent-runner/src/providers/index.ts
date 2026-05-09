// Provider self-registration barrel.
// Each import triggers the provider module's registerProvider() call at top
// level. Skills add a new provider by appending one import line below.
//
// AgentMesh fork: openai-compat + google providers added so the runtime
// can drive its conversation loop with non-Anthropic models.

import './claude.js';
import './mock.js';
import './openai.js';
import './google.js';
