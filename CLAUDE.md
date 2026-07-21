## Rules
- This is a production instance, check with tests, builds, tsc, etc. whether it will cause any issues
- Always look through everything to find any relation to the feature you're currently implementing
- Always ask many (I mean a lot) of questions when planning a feature. Ask them in a batch once you've gathered all information, you can ask a lot (over 10 is fine, scales)
- Keep design consistent across changes (find related files for your change to get design)
- Add pagination for areas that have entries more than > 10.
- NEVER use Em-Dashes, always use alternatives like commas, colons, etc.

## Quirks
- Migrations are **not** run via prod natively,  you must change src/db/ensureSchema.ts & src/db/verifySchema.ts when changing prisma/schema.prisma
- Never create scripts directly when the user asks you to create a command, they always mean a discord command
- Assume the user doesn't have access to .env & terminal of prod, always use /config on discord, or the vault interface for secrets
- Never echo secret values back into Discord, even in ephemeral replies
- Discord commands need authz, not just registration — assume the invoker is hostile