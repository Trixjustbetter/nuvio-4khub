const provider = require('./providers/4khdhub.js');
const internal = provider._internal;

if (process.env.TMDB_KEY) {
  internal.configure({ tmdbApiKey: process.env.TMDB_KEY });
  console.log('TMDB key loaded from env — full getStreams() path will be tested.');
} else {
  console.log('No TMDB_KEY env var — testing scrape pipeline directly (title/year path).');
}

function summarize(label, streams) {
  console.log('\n=== ' + label + ' ===');
  if (!streams || !streams.length) { console.log('NO STREAMS'); return; }
  console.log(streams.length + ' stream(s):');
  streams.forEach(function (s) {
    console.log('  [' + s.quality + '] ' + s.title);
    console.log('        url: ' + s.url.slice(0, 110) + (s.url.length > 110 ? '...' : ''));
  });
}

async function run() {
  try {
    const cards = await internal.searchSite('Hacksaw Ridge', 'movie');
    console.log('\nSearch sanity check: ' + cards.length + ' movie card(s)');
    cards.slice(0, 3).forEach(function (c) { console.log('  ' + c.title + ' (' + c.year + ') -> ' + c.url); });

    summarize('Movie: Hacksaw Ridge (2016)', await internal.getStreamsByMeta('Hacksaw Ridge', 2016, 'movie'));
  } catch (e) {
    console.error('MOVIE TEST FAILED:', e.message);
  }

  try {
    summarize('Series: Outer Banks S05E01 (2020)', await internal.getStreamsByMeta('Outer Banks', 2020, 'tv', 5, 1));
  } catch (e) {
    console.error('SERIES TEST FAILED:', e.message);
  }

  if (process.env.TMDB_KEY) {
    try {
      summarize('getStreams(tmdbId=324786 movie)', await provider.getStreams('324786', 'movie'));
    } catch (e) {
      console.error('TMDB MOVIE PATH FAILED:', e.message);
    }
    try {
      summarize('getStreams(tmdbId=100757 tv s5e1)', await provider.getStreams('100757', 'tv', 5, 1));
    } catch (e) {
      console.error('TMDB TV PATH FAILED:', e.message);
    }
  }

  console.log('\nDone.');
}

run();
