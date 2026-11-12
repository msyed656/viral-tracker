// Viral Studio tracker: one reading. Runs every 15 min (GitHub Actions, or locally).
// Official APIs only: YouTube Data API v3 (OAuth refresh token) and the Instagram Graph API hashtag search.
// No scraping. TikTok and Facebook Reels are not tracked (operator decision 12 Nov 2026).
//
// env: YOUTUBE_OAUTH_CLIENT_ID, YOUTUBE_OAUTH_CLIENT_SECRET, YOUTUBE_OAUTH_REFRESH_TOKEN, META_ACCESS_TOKEN (optional)
//      STATE (default studio/tracker/state.json)
// usage: node studio/tracker/track.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const STATE = process.env.STATE || 'studio/tracker/state.json';
const YT = 'https://www.googleapis.com/youtube/v3';
const GRAPH = 'https://graph.facebook.com/' + (process.env.META_GRAPH_VERSION || 'v23.0');
const DISCOVER_EVERY_MIN = 360;      // every 6 h (was 3 h) to leave quota room for the 7- and 30-day sweeps          // search.list costs 100 quota units per query
const YT_QUERIES = [                     // [query, videoDuration]
  ['shorts', 'short'], ['iphone', 'any'], ['scam', 'any'], ['hacked', 'any'], ['viral', 'short'],
  ['samsung', 'short'], ['mystery', 'short'], ['ai robot', 'short'], // more small-channel breakouts in our lanes (+2,400 units/day)
];
const YT_CHART_CATEGORIES = ['', '28', '24', '25']; // all, Science & Tech, Entertainment, News (1 unit each)
const IG_HASHTAGS = ['viral', 'iphone', 'tech', 'scam', 'news', 'funny'];
const KEEP_DAYS = 7, MAX_ITEMS = 300;

const nowMin = Math.floor(Date.now() / 60000);
let st = { v: 1, updated: null, lastDiscovery: 0, hashtagIds: {}, items: {}, log: [] };
try { st = { ...st, ...JSON.parse(readFileSync(STATE, 'utf8')) }; } catch {}
const note = (m) => { console.log(m); st.log = [...(st.log || []).slice(-30), `${new Date().toISOString()} ${m}`]; };

async function getJson(url, init, tries = 3) {
  let r;
  for (let i = 1; ; i++) { try { r = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) }); break; } catch (err) { if (i >= tries) throw err; await new Promise((ok) => setTimeout(ok, 3000 * i)); } } const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(j.error?.message ?? j).slice(0, 200)}`);
  return j;
}
const secs = (iso) => { const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || ''); return m ? (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0) : 0; };
const FILLER = new Set('the a an and or but of to in on for with at by from is are was were be been it its this that you your my our we they he she his her i me what who how why when where which not no so if do just can will one all out up get new more most very than then there here about into over after before like off still make vs official video videos shorts short ytshorts youtubeshorts shortsfeed shortvideo viral trending fyp foryou reels tiktok funny wait end part full live watch subscribe music 2026 2025 de la el en que los las un una por con para hai ka ki ke se ko'.split(' '));
const titleWords = (t) => { const w = (String(t || '').toLowerCase().replace(/[#@]/g, ' ').match(/[\p{L}\p{N}]+/gu) || []).filter((x) => x.length >= 3 && !FILLER.has(x) && !/^\d+$/.test(x)); return [...new Set(w)].slice(0, 12); };
const push = (it, val) => { if (val == null || Number.isNaN(val)) return; const s = it.s || (it.s = []); if (s.length && s[s.length - 1][0] === nowMin) s[s.length - 1][1] = val; else s.push([nowMin, val]); };

/* ---------- YouTube ---------- */
async function youtube() {
  const e = Object.fromEntries(Object.entries(process.env).map(([k, v]) => [k, String(v).trim()]));
  if (!e.YOUTUBE_OAUTH_REFRESH_TOKEN) { note('youtube: NOT_CONFIGURED'); return; }
  const tok = (await getJson('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: e.YOUTUBE_OAUTH_CLIENT_ID, client_secret: e.YOUTUBE_OAUTH_CLIENT_SECRET, refresh_token: e.YOUTUBE_OAUTH_REFRESH_TOKEN, grant_type: 'refresh_token' }) })).access_token;
  const get = (path) => getJson(`${YT}/${path}`, { headers: { Authorization: `Bearer ${tok}` } });
  const found = new Set();
  // charts every reading (cheap)
  for (const c of YT_CHART_CATEGORIES) {
    try { const j = await get(`videos?part=id&chart=mostPopular&regionCode=US&maxResults=50${c ? '&videoCategoryId=' + c : ''}`); j.items.forEach((v) => found.add(v.id)); }
    catch (err) { note(`youtube chart ${c || 'all'}: ${err.message}`); }
  }
  // searches every 3 h
  if (nowMin - (st.lastDiscovery || 0) >= DISCOVER_EVERY_MIN) {
    const after = new Date(Date.now() - 24 * 3600e3).toISOString();
    for (const [q, dur] of YT_QUERIES) {
      try { const j = await get(`search?part=id&type=video&order=viewCount&maxResults=25&publishedAfter=${after}&videoDuration=${dur}&q=${encodeURIComponent(q)}`); j.items.forEach((i) => found.add(i.id.videoId)); }
      catch (err) { note(`youtube search "${q}": ${err.message}`); }
    }
    st.lastDiscovery = nowMin;
  }
  const ids = new Set([...Object.keys(st.items).filter((k) => k.startsWith('yt:')).map((k) => k.slice(3)), ...found]);
  const list = [...ids];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    try {
      const j = await get(`videos?part=snippet,statistics,contentDetails&id=${chunk.join(',')}`);
      for (const v of j.items) {
        const k = 'yt:' + v.id, it = st.items[k] || (st.items[k] = {});
        Object.assign(it, { platform: secs(v.contentDetails?.duration) <= 180 ? 'yt_short' : 'yt_long', title: v.snippet.title, channel: v.snippet.channelTitle,
          url: secs(v.contentDetails?.duration) <= 180 ? `https://www.youtube.com/shorts/${v.id}` : `https://youtu.be/${v.id}`, published: v.snippet.publishedAt, metric: 'views' });
        const hs = [...new Set(((v.snippet.title || '') + ' ' + (v.snippet.description || '')).match(/#[p{L}p{N}_]+/gu) || [])].slice(0, 15);
        it.channelId = v.snippet.channelId; it.tags = (v.snippet.tags || []).slice(0, 15); it.hashtags = hs; // SEO: what the video is labelled with
        push(it, Number(v.statistics?.viewCount));
      }
    } catch (err) { note(`youtube videos.list: ${err.message}`); }
  }
  // channel size + age (1 unit per 50 channels), refreshed once a day; plus our own channel
  st.channels = st.channels || {};
  const need = [...new Set(Object.values(st.items).map((it) => it.channelId).filter(Boolean))].filter((c) => !st.channels[c] || nowMin - st.channels[c].at > 1440);
  for (let i = 0; i < need.length; i += 50) {
    try {
      const j = await get('channels?part=statistics,snippet&id=' + need.slice(i, i + 50).join(','));
      for (const c of j.items) st.channels[c.id] = { subs: c.statistics.hiddenSubscriberCount ? null : Number(c.statistics.subscriberCount), videos: Number(c.statistics.videoCount), created: c.snippet.publishedAt, at: nowMin };
    } catch (err) { note('youtube channels.list: ' + err.message); }
  }
  try { const me = (await get('channels?part=statistics&mine=true')).items?.[0]; if (me) st.me = { subs: Number(me.statistics.subscriberCount), views: Number(me.statistics.viewCount), videos: Number(me.statistics.videoCount), at: nowMin }; } catch (err) { note('youtube mine: ' + err.message); }
  const live = new Set(Object.values(st.items).map((it) => it.channelId)); for (const c of Object.keys(st.channels)) if (!live.has(c)) delete st.channels[c];
  // ---- daily 7-day sweep (for "next big topic"): what got uploaded in our lanes over the last 7 days, and each
  // video's views once a day. ~1,000 units/day for the searches + ~10 for the daily view refresh.
  const SWEEP_Q = ['shorts', 'iphone', 'samsung', 'phone', 'scam', 'hacked', 'mystery', 'ai', 'tech', 'viral'];
  const day = Math.floor(nowMin / 1440);
  // one sweep per window: 7 days (fast waves) and 30 days (slow builds); each ~1,000 units, once a day
  for (const [key, back, keep, dKeep, nTags] of [['sweep', 7, 10, 10, 8]]) { // 30-day keeps only the latest views + 3 tags (page data limit)
    const sw = st[key] = st[key] || { at: 0, items: {} };
    if (nowMin - (sw.at || 0) < 1440) continue;
    const after = new Date(Date.now() - back * 864e5).toISOString();
    for (const q of SWEEP_Q) {
      try {
        const j = await get('search?part=snippet&type=video&order=viewCount&maxResults=50&publishedAfter=' + after + '&q=' + encodeURIComponent(q));
        for (const it of j.items) { const id = it.id.videoId; if (!sw.items[id]) sw.items[id] = { title: it.snippet.title, channel: it.snippet.channelTitle, channelId: it.snippet.channelId, published: it.snippet.publishedAt, q: [], d: [] }; const x = sw.items[id]; if (!x.q.includes(q)) x.q.push(q); }
      } catch (err) { note(key + ' "' + q + '": ' + err.message); }
    }
    const sids = Object.keys(sw.items);
    for (let i = 0; i < sids.length; i += 50) {
      try {
        const j = await get('videos?part=statistics,contentDetails,snippet&id=' + sids.slice(i, i + 50).join(','));
        for (const v of j.items) { const x = sw.items[v.id]; x.len = secs(v.contentDetails?.duration); x.tags = (v.snippet.tags || []).slice(0, nTags); const views = Number(v.statistics?.viewCount || 0); const last = x.d[x.d.length - 1]; if (last && last[0] === day) last[1] = views; else x.d.push([day, views]); if (x.d.length > dKeep) x.d = x.d.slice(-dKeep); }
      } catch (err) { note(key + ' videos.list: ' + err.message); }
    }
    for (const [id, x] of Object.entries(sw.items)) if (Date.now() - Date.parse(x.published) > keep * 864e5) delete sw.items[id];
    sw.at = nowMin;
    note(key + ': ' + Object.keys(sw.items).length + ' videos from the last ' + back + ' days');
  }
  // ---- unbiased daily panel (for the 30-day model): every day, the NEWEST uploads in each lane (order=date, any
  // views), then their views ~24 h later, stored only as daily totals per title word: [uploads, views at ~24 h,
  // uploads with 10K+ views at ~24 h]. Compact, and free of the "most-viewed" selection bias. ~1,000 units/day.
  delete st.sweep30;
  st.fresh = st.fresh || {}; st.daily = st.daily || {};
  if (nowMin - (st.freshAt || 0) >= 1440) {
    const after1 = new Date(Date.now() - 864e5).toISOString();
    for (const q of SWEEP_Q) {
      try { const j = await get('search?part=snippet&type=video&order=date&maxResults=50&publishedAfter=' + after1 + '&q=' + encodeURIComponent(q));
        for (const it of j.items) if (!st.fresh[it.id.videoId]) st.fresh[it.id.videoId] = { t: it.snippet.title, p: it.snippet.publishedAt, c: it.snippet.channelId }; }
      catch (err) { note('fresh "' + q + '": ' + err.message); }
    }
    st.freshAt = nowMin;
  }
  const ripe = Object.entries(st.fresh).filter(([, x]) => Date.now() - Date.parse(x.p) >= 22 * 36e5);
  for (let i = 0; i < ripe.length; i += 50) {
    const chunk = ripe.slice(i, i + 50);
    try {
      const j = await get('videos?part=statistics&id=' + chunk.map(([id]) => id).join(','));
      const views = new Map(j.items.map((v) => [v.id, Number(v.statistics?.viewCount || 0)]));
      for (const [id, x] of chunk) {
        const d = String(Math.floor(Date.parse(x.p) / 864e5)), v = views.get(id) ?? 0, day = st.daily[d] || (st.daily[d] = {});
        for (const w of titleWords(x.t)) { const a = day[w] || (day[w] = [0, 0, 0]); a[0]++; a[1] += v; if (v >= 10000) a[2]++; }
        delete st.fresh[id];
      }
    } catch (err) { note('fresh videos.list: ' + err.message); }
  }
  for (const d of Object.keys(st.daily)) { if (Number(d) < Math.floor(Date.now() / 864e5) - 35) { delete st.daily[d]; continue; } for (const [w, a] of Object.entries(st.daily[d])) if (a[0] < 2) delete st.daily[d][w]; }
  // ---- our own uploads, once a day (the channel's personality: what OUR audience watched)
  if (!st.mine || nowMin - (st.mine.at || 0) >= 1440) {
    try {
      const ch = (await get('channels?part=contentDetails&mine=true')).items?.[0];
      const pl = await get('playlistItems?part=contentDetails&maxResults=50&playlistId=' + ch.contentDetails.relatedPlaylists.uploads);
      const ids = pl.items.map((i) => i.contentDetails.videoId);
      const j = await get('videos?part=snippet,statistics,contentDetails,status&id=' + ids.join(','));
      st.mine = { at: nowMin, videos: j.items.filter((v) => v.status?.privacyStatus === 'public').map((v) => ({ id: v.id, title: v.snippet.title, published: v.snippet.publishedAt, views: Number(v.statistics?.viewCount || 0), likes: Number(v.statistics?.likeCount || 0), len: secs(v.contentDetails?.duration), tags: (v.snippet.tags || []).slice(0, 10) })) };
      note('mine: ' + st.mine.videos.length + ' public uploads');
    } catch (err) { note('mine: ' + err.message); }
  }
  note(`youtube: ${found.size} found, ${list.length} tracked`);
}

/* ---------- Instagram (hashtag top media; likes only, Meta gives no views for other accounts) ---------- */
async function instagram() {
  const t = process.env.META_ACCESS_TOKEN;
  if (!t) { note('instagram: NOT_CONFIGURED'); return; }
  const g = (path, q = {}) => getJson(`${GRAPH}/${path}?${new URLSearchParams({ ...q, access_token: t })}`);
  try {
    if (!st.igUser) { const r = await g('me/accounts', { fields: 'instagram_business_account', limit: '50' }); st.igUser = r.data.map((p) => p.instagram_business_account?.id).find(Boolean) || null; }
    if (!st.igUser) { note('instagram: no business account on this token'); return; }
    let n = 0;
    for (const tag of IG_HASHTAGS) {
      try {
        let id = st.hashtagIds[tag];
        if (!id) { const r = await g('ig_hashtag_search', { user_id: st.igUser, q: tag }); id = st.hashtagIds[tag] = r.data?.[0]?.id; } // counts toward 30 unique tags / 7 days
        if (!id) continue;
        const r = await g(`${id}/top_media`, { user_id: st.igUser, fields: 'id,caption,media_type,like_count,permalink,timestamp', limit: '25' });
        for (const m of r.data || []) {
          if (m.media_type !== 'VIDEO') continue; // Meta returns reels as VIDEO here; photos are skipped
          if (m.like_count == null) continue;
          const k = 'ig:' + m.id, it = st.items[k] || (st.items[k] = {});
          it.hashtags = [...new Set((m.caption || '').match(/#[p{L}p{N}_]+/gu) || [])].slice(0, 15);
          Object.assign(it, { platform: 'ig_reel', title: (m.caption || 'Instagram reel').split('\n')[0].slice(0, 120), channel: '#' + tag, url: m.permalink, published: m.timestamp, metric: 'likes' });
          push(it, m.like_count); n++;
        }
      } catch (err) { note(`instagram #${tag}: ${err.message}`); }
    }
    note(`instagram: ${n} reels read`);
  } catch (err) { note(`instagram: ${err.message}`); }
}

try { await youtube(); } catch (err) { note(`youtube: ${err.message}`); }
try { await instagram(); } catch (err) { note(`instagram: ${err.message}`); }

/* ---------- prune: 7 days of readings, at most MAX_ITEMS, ranked by 24 h growth ---------- */
const cut = nowMin - KEEP_DAYS * 1440;
const gain24 = (s) => { const last = s[s.length - 1]; const b = [...s].reverse().find((x) => x[0] <= nowMin - 1440) || s[0]; return last[1] - b[1]; };
for (const [k, it] of Object.entries(st.items)) {
  it.s = (it.s || []).filter((x) => x[0] >= cut);
  if (!it.s.length || it.s[it.s.length - 1][0] < nowMin - 1440) delete st.items[k]; // nothing new in a day
}
const keys = Object.keys(st.items).sort((a, b) => gain24(st.items[b].s) - gain24(st.items[a].s));
for (const k of keys.slice(MAX_ITEMS)) delete st.items[k];
st.updated = new Date().toISOString();
mkdirSync(dirname(STATE), { recursive: true });
note(`saved ${Object.keys(st.items).length} items`);
writeFileSync(STATE, JSON.stringify(st));
