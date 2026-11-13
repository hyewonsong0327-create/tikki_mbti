// Vercel 서버리스 함수: KOPIS 오픈 API에서 서울 지역의 '공연 중 / 곧 개막' 공연을 가져와요.
// 사용하려면 Vercel 프로젝트 Settings → Environment Variables 에 KOPIS_KEY 를 등록하세요.
// 키가 없으면 빈 목록을 돌려주고, 게임은 shows.json(직접 고른 공연)만으로 추천해요.

const GENRES = { GGGA: 'musical', AAAA: 'play', CCCD: 'concert', CCCA: 'classic', BBBC: 'dance' };
const PER_GENRE = 10; // 장르별로 상세(예매처 링크)까지 가져올 공연 수
const BASE = 'http://www.kopis.or.kr/openApi/restful/pblprfr';

const ymd = d => d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
const toISO = s => (s || '').trim().replace(/\./g, '-'); // 2026.11.13 → 2026-11-13
const decode = s => (s || '')
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .trim();
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ''; };
const blocks = (xml, name) => xml.match(new RegExp(`<${name}>[\\s\\S]*?</${name}>`, 'g')) || [];

async function getText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? await r.text() : '';
  } catch (e) { return ''; } finally { clearTimeout(t); }
}

async function listGenre(key, code, st, ed) {
  const url = `${BASE}?service=${key}&stdate=${st}&eddate=${ed}&cpage=1&rows=100&shcate=${code}&signgucode=11`;
  const xml = await getText(url);
  return blocks(xml, 'db').map(b => ({
    kopisId: tag(b, 'mt20id'),
    title: tag(b, 'prfnm'),
    start: toISO(tag(b, 'prfpdfrom')),
    end: toISO(tag(b, 'prfpdto')),
    venue: tag(b, 'fcltynm'),
    poster: tag(b, 'poster').replace(/^http:/, 'https:'),
    state: tag(b, 'prfstate'),
    openrun: tag(b, 'openrun') === 'Y',
    genre: GENRES[code],
  })).filter(s => s.kopisId && s.title);
}

async function detail(key, s) {
  const xml = await getText(`${BASE}/${s.kopisId}?service=${key}`);
  const rel = blocks(xml, 'relate').map(r => ({ name: tag(r, 'relatenm'), url: tag(r, 'relateurl') }))
    .filter(r => /^https?:\/\//.test(r.url));
  return {
    ...s,
    url: rel[0] ? rel[0].url : '',
    booking: rel[0] ? rel[0].name : '',
    age: tag(xml, 'prfage'),
    runtime: tag(xml, 'prfruntime'),
    kids: tag(xml, 'child') === 'Y',
  };
}

module.exports = async (req, res) => {
  const key = process.env.KOPIS_KEY;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!key) { res.status(200).send(JSON.stringify({ source: 'none', shows: [] })); return; }

  const today = new Date(Date.now() + 9 * 3600 * 1000); // 한국 시간 기준
  const st = ymd(today), ed = ymd(new Date(today.getTime() + 30 * 86400000)); // KOPIS는 최대 31일 구간

  try {
    const lists = await Promise.all(Object.keys(GENRES).map(c => listGenre(key, c, st, ed)));
    const picked = [];
    for (const list of lists) {
      // 오래 공연하는 작품(대표 프로덕션)과 포스터가 있는 공연을 우선으로 골라요
      const span = s => (new Date(s.end) - new Date(s.start)) || 0;
      list.sort((a, b) => (b.poster ? 1 : 0) - (a.poster ? 1 : 0) || span(b) - span(a));
      picked.push(...list.slice(0, PER_GENRE));
    }
    const detailed = [];
    for (let i = 0; i < picked.length; i += 8) { // 한 번에 8개씩 상세 조회
      detailed.push(...await Promise.all(picked.slice(i, i + 8).map(s => detail(key, s))));
    }
    const shows = detailed.filter(s => !s.kids);
    // 6시간 동안 CDN 캐시 → KOPIS 호출을 아껴요
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.status(200).send(JSON.stringify({ source: 'kopis', updated: st, shows }));
  } catch (e) {
    res.status(200).send(JSON.stringify({ source: 'error', shows: [] }));
  }
};
