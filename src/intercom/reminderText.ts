// {team} substitution for agent-idle reminder texts (per-ticket executor +
// workspace sweeper). Operator texts that carry the token get it substituted
// in place; texts without it (including the built-in defaults) get an
// appended "assigned team" clause so every reminder round names the team.
export function applyTeam(text: string, teamName: string): string {
  if (text.includes("{team}")) return text.split("{team}").join(teamName);
  return `${text} (assigned team: ${teamName}).`;
}
