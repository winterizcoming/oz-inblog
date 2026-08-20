# Privacy

oz-inblog runs on the user's Mac. Conversation history, state, and Writing Preview content are stored in `~/Library/Application Support/oz-inblog/data` unless `OZ_DATA_DIR` is set.

The application does not operate an account system, analytics service, telemetry collector, or remote application database. It does not send manuscripts to the project maintainer.

Prompts and selected content are sent through the locally authenticated Codex CLI to provide search and generation. That processing is governed by the user's Codex/OpenAI account and its applicable terms and settings.

Debug trace is off by default. When the user enables `OZ_BRUNCH_DEBUG_TRACE=1`, prompts and model outputs may be written to the local debug directory. API keys, cookies, authorization headers, and environment variable values are redacted or excluded.

Deleting an application release does not delete user data. Data deletion must target the data directory explicitly.
