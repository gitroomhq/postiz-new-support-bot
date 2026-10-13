import { stripeBaseCss } from "../../dashboard/html/stripeTheme";

// Navigate in the document rather than with a 3xx Location header. The public
// proxy currently replaces Location on every response, including /health.
// A 200 page keeps OAuth navigation and cookies working through that proxy.
export function renderQueueNavigation(destination: string, nonce: string): string {
  const url = destination.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${url}">
<title>Intercom Queue</title>
<style nonce="${nonce}">
${stripeBaseCss()}
body { display:grid; place-items:center; padding:24px; }
main { width:100%; max-width:460px; padding:32px; text-align:center;
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); }
h1 { font-size:20px; }
</style>
</head>
<body>
<main>
<h1>Intercom Queue</h1>
<p>Opening the next page...</p>
<a href="${url}" rel="noreferrer">Continue</a>
</main>
</body>
</html>`;
}
