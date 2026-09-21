/**
 * Farm site — static pages only.
 *
 * Exists for one reason: html_handling = "none" keeps the hand-written
 * does.html / goats/calypso.html links working without redirects, but it also
 * turns off index.html resolution, so "/" would 404. This maps directory
 * paths to their index.html and passes everything else straight through.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/')) {
      return env.ASSETS.fetch(new Request(new URL(url.pathname + 'index.html', url), request));
    }
    return env.ASSETS.fetch(request);
  },
};
