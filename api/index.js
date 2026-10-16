(function () {
  const KKPHIM_BASE = 'https://phimapi.com';
  const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
  const TMDB_API_BASE = 'https://api.themoviedb.org/3';

  const cache = new Map();
  const CACHE_TTL = 15 * 60 * 1000;

  function getCache(key) {
    const item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      cache.delete(key);
      return null;
    }
    return item.value;
  }

  function setCache(key, value, ttl = CACHE_TTL) {
    if (cache.size > 500) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(key, { value, expiry: Date.now() + ttl });
  }

  async function fetchJson(url, timeoutMs = 7000) {
    const cached = getCache(url);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Nuvio-KKPhim-Addon/1.2'
        },
        signal: controller.signal
      });
      if (!res.ok) return null;
      const data = await res.json();
      setCache(url, data);
      return data;
    } catch (err) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  const MANIFEST = {
    id: 'vn.nuvio.kkphim.streams',
    version: '1.2.1',
    name: 'KKPhim Streams (Vietsub • Thuyết Minh • Lồng Tiếng)',
    description: 'Addon lấy nguồn phim chuẩn TMDB ID từ KKPhim (phimapi.com) cho Cinemeta Catalog mặc định trên Nuvio. Chuẩn Season/Tập, đầy đủ Vietsub, Thuyết Minh, Lồng Tiếng.',
    logo: 'https://kkphim.com/favicon.ico',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'tmdb:'],
    catalogs: [],
    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };

  function parseStremioId(rawId) {
    const decoded = decodeURIComponent(String(rawId || '').trim());

    if (decoded.startsWith('tmdb:')) {
      const parts = decoded.split(':');
      return {
        source: 'tmdb',
        tmdbId: parts[1],
        imdbId: null,
        season: parts[2] ? parseInt(parts[2], 10) : null,
        episode: parts[3] ? parseInt(parts[3], 10) : null
      };
    }

    const parts = decoded.split(':');
    return {
      source: 'imdb',
      imdbId: parts[0],
      tmdbId: null,
      season: parts[1] ? parseInt(parts[1], 10) : null,
      episode: parts[2] ? parseInt(parts[2], 10) : null
    };
  }

  async function resolveMetadata(type, parsedId) {
    const tmdbType = type === 'series' ? 'tv' : 'movie';
    const result = {
      tmdbId: parsedId.tmdbId || null,
      imdbId: parsedId.imdbId || null,
      tmdbType,
      title: null,
      originalTitle: null,
      year: null,
      genres: [],
      absoluteEpisode: null
    };

    if (result.imdbId) {
      const cinemetaUrl = `${CINEMETA_BASE}/meta/${type}/${result.imdbId}.json`;
      const cinemetaData = await fetchJson(cinemetaUrl);
      const meta = cinemetaData && cinemetaData.meta ? cinemetaData.meta : null;

      if (meta) {
        if (meta.moviedb_id && !result.tmdbId) {
          result.tmdbId = String(meta.moviedb_id);
        }
        result.title = meta.name || null;
        result.originalTitle = meta.name || null;
        if (meta.year) {
          result.year = parseInt(String(meta.year).slice(0, 4), 10);
        } else if (meta.releaseInfo) {
          result.year = parseInt(String(meta.releaseInfo).slice(0, 4), 10);
        }
        if (Array.isArray(meta.genres)) {
          result.genres = meta.genres;
        }

        if (type === 'series' && Array.isArray(meta.videos) && parsedId.season && parsedId.episode) {
          const regularVideos = meta.videos
            .filter(v => Number(v.season) > 0 && Number(v.episode || v.number) > 0)
            .sort((a, b) => {
              if (Number(a.season) !== Number(b.season)) return Number(a.season) - Number(b.season);
              return Number(a.episode || a.number) - Number(b.episode || b.number);
            });

          let absCount = 0;
          for (const v of regularVideos) {
            absCount++;
            const epNum = Number(v.episode || v.number);
            if (Number(v.season) === parsedId.season && epNum === parsedId.episode) {
              result.absoluteEpisode = absCount;
              break;
            }
          }
        }
      }
    }

    const tmdbApiKey = process.env.TMDB_API_KEY;
    if (tmdbApiKey) {
      if (!result.tmdbId && result.imdbId) {
        const findUrl = `${TMDB_API_BASE}/find/${result.imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id&language=vi-VN`;
        const findData = await fetchJson(findUrl);
        if (findData) {
          const matchList = tmdbType === 'tv'
            ? ((findData.tv_results && findData.tv_results.length) ? findData.tv_results : findData.movie_results)
            : ((findData.movie_results && findData.movie_results.length) ? findData.movie_results : findData.tv_results);

          if (matchList && matchList.length > 0) {
            const item = matchList[0];
            result.tmdbId = String(item.id);
            result.title = item.title || item.name || result.title;
            result.originalTitle = item.original_title || item.original_name || result.originalTitle;
            const dateStr = item.release_date || item.first_air_date;
            if (dateStr) result.year = parseInt(dateStr.slice(0, 4), 10);
          }
        }
      } else if (result.tmdbId && !result.originalTitle) {
        const detailUrl = `${TMDB_API_BASE}/${tmdbType}/${result.tmdbId}?api_key=${tmdbApiKey}&language=vi-VN`;
        const detailData = await fetchJson(detailUrl);
        if (detailData) {
          result.title = detailData.title || detailData.name || result.title;
          result.originalTitle = detailData.original_title || detailData.original_name || result.originalTitle;
          const dateStr = detailData.release_date || detailData.first_air_date;
          if (dateStr) result.year = parseInt(dateStr.slice(0, 4), 10);
        }
      }
    }

    return result;
  }

  function normalizeText(str) {
    return String(str || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractSeasonFromTitleOrSlug(name, originName, slug) {
    const combined = `${normalizeText(name)} | ${normalizeText(originName)} | ${String(slug || '').toLowerCase()}`;
    const patterns = [
      /\b(?:phan|season|ss|mua)\s*0*(\d+)\b/i,
      /\bs0*(\d+)\b/i,
      /-phan-0*(\d+)\b/i,
      /-season-0*(\d+)\b/i
    ];
    for (const regex of patterns) {
      const match = combined.match(regex);
      if (match && match[1]) {
        return parseInt(match[1], 10);
      }
    }
    return null;
  }

  function isSeasonMatch(movieObj, targetSeason) {
    if (!targetSeason) return true;

    const rawTmdbSeason = movieObj && movieObj.tmdb ? movieObj.tmdb.season : null;
    const tmdbSeason = rawTmdbSeason !== null && rawTmdbSeason !== undefined
      ? parseInt(rawTmdbSeason, 10)
      : null;

    if (tmdbSeason !== null && !Number.isNaN(tmdbSeason)) {
      return tmdbSeason === targetSeason;
    }

    const detectedSeason = extractSeasonFromTitleOrSlug(
      movieObj ? movieObj.name : '',
      movieObj ? movieObj.origin_name : '',
      movieObj ? movieObj.slug : ''
    );

    if (detectedSeason !== null) {
      return detectedSeason === targetSeason;
    }

    return targetSeason === 1;
  }

  function isTypeCompatible(movieObj, requestedType) {
    if (!movieObj) return false;
    const kkTmdbType = movieObj.tmdb ? movieObj.tmdb.type : null;
    const kkType = movieObj.type;

    if (requestedType === 'movie') {
      if (kkTmdbType === 'movie') return true;
      if (kkType === 'single') return true;
      if (kkType === 'hoathinh' && (!movieObj.tmdb || !movieObj.tmdb.season)) return true;
      return false;
    }

    if (requestedType === 'series') {
      if (kkTmdbType === 'tv') return true;
      if (kkType === 'series' || kkType === 'tvshows' || kkType === 'hoathinh') return true;
      return false;
    }

    return true;
  }

  function extractMoviePayload(apiResponse) {
    if (!apiResponse) return null;
    if (apiResponse.movie && Array.isArray(apiResponse.episodes)) {
      return { movie: apiResponse.movie, episodes: apiResponse.episodes };
    }
    if (apiResponse.data && apiResponse.data.item) {
      return {
        movie: apiResponse.data.item,
        episodes: apiResponse.data.item.episodes || apiResponse.episodes || []
      };
    }
    return null;
  }

  async function findKKPhimMovieData(type, parsedId, meta) {
    const targetSeason = parsedId.season;
    const candidateSlugs = new Set();
    let fallbackSingleSeasonPayload = null;

    if (meta.tmdbId) {
      const directUrl = `${KKPHIM_BASE}/tmdb/${meta.tmdbType}/${meta.tmdbId}`;
      const directRes = await fetchJson(directUrl);

      if (directRes) {
        const payload = extractMoviePayload(directRes);
        if (payload && isTypeCompatible(payload.movie, type)) {
          if (type === 'movie' || isSeasonMatch(payload.movie, targetSeason)) {
            if (payload.episodes && payload.episodes.length > 0) {
              return payload;
            }
            if (payload.movie && payload.movie.slug) candidateSlugs.add(payload.movie.slug);
          } else if (type === 'series' && targetSeason > 1) {
            if (!meta.originalTitle && payload.movie && payload.movie.origin_name) {
              meta.originalTitle = payload.movie.origin_name;
            }
            if (!meta.title && payload.movie && payload.movie.name) {
              meta.title = payload.movie.name;
            }
            fallbackSingleSeasonPayload = payload;
          }
        }

        const listItems = directRes.items || (directRes.data && directRes.data.items) || (Array.isArray(directRes.data) ? directRes.data : null);
        if (Array.isArray(listItems)) {
          for (const item of listItems) {
            if (isTypeCompatible(item, type) && (type === 'movie' || isSeasonMatch(item, targetSeason))) {
              if (item.slug) candidateSlugs.add(item.slug);
            }
          }
        }
      }
    }

    if (candidateSlugs.size === 0 && meta.imdbId) {
      const imdbUrl = `${KKPHIM_BASE}/imdb/title/${meta.imdbId}`;
      const imdbRes = await fetchJson(imdbUrl);
      const payload = extractMoviePayload(imdbRes);
      if (payload && isTypeCompatible(payload.movie, type)) {
        if (type === 'movie' || isSeasonMatch(payload.movie, targetSeason)) {
          if (payload.episodes && payload.episodes.length > 0) {
            return payload;
          }
          if (payload.movie && payload.movie.slug) candidateSlugs.add(payload.movie.slug);
        } else if (type === 'series' && targetSeason > 1) {
          if (!meta.originalTitle && payload.movie && payload.movie.origin_name) {
            meta.originalTitle = payload.movie.origin_name;
          }
          fallbackSingleSeasonPayload = fallbackSingleSeasonPayload || payload;
        }
      }
    }

    if (candidateSlugs.size === 0) {
      const searchKeywords = [];
      if (meta.originalTitle) {
        const cleanOrigin = meta.originalTitle.replace(/\s*\((?:Phần|Season)\s*\d+\)/i, '').trim();
        searchKeywords.push(cleanOrigin);
      }
      if (meta.title && meta.title !== meta.originalTitle) {
        const cleanTitle = meta.title.replace(/\s*\((?:Phần|Season)\s*\d+\)/i, '').trim();
        searchKeywords.push(cleanTitle);
      }

      for (const kw of searchKeywords) {
        if (!kw) continue;
        const searchUrl = `${KKPHIM_BASE}/v1/api/tim-kiem?keyword=${encodeURIComponent(kw)}&limit=32`;
        const searchRes = await fetchJson(searchUrl);
        const items = (searchRes && searchRes.data && searchRes.data.items) || (searchRes && searchRes.items) || [];

        if (!Array.isArray(items) || items.length === 0) continue;

        for (const item of items) {
          const itemTmdbId = (item && item.tmdb && item.tmdb.id) ? String(item.tmdb.id) : null;
          if (meta.tmdbId && itemTmdbId === String(meta.tmdbId)) {
            if (type === 'movie' || isSeasonMatch(item, targetSeason)) {
              if (item.slug) candidateSlugs.add(item.slug);
            } else if (type === 'series' && !fallbackSingleSeasonPayload && item.slug) {
              const detailRes = await fetchJson(`${KKPHIM_BASE}/phim/${item.slug}`);
              fallbackSingleSeasonPayload = extractMoviePayload(detailRes);
            }
          }
        }

        if (candidateSlugs.size > 0) break;

        const normOrigin = normalizeText(meta.originalTitle);
        for (const item of items) {
          if (!isTypeCompatible(item, type)) continue;
          const itemOrigin = normalizeText(item.origin_name)
            .replace(/\b(?:phan|season|ss)\s*0*\d+\b/g, '')
            .trim();

          const isExactName = normOrigin && itemOrigin === normOrigin;
          const isYearClose = !meta.year || !item.year || Math.abs(Number(item.year) - Number(meta.year)) <= 1;

          if (isExactName && (type === 'series' || isYearClose)) {
            if (type === 'movie' || isSeasonMatch(item, targetSeason)) {
              if (item.slug) candidateSlugs.add(item.slug);
            }
          }
        }

        if (candidateSlugs.size > 0) break;
      }
    }

    for (const slug of candidateSlugs) {
      const detailUrl = `${KKPHIM_BASE}/phim/${slug}`;
      const detailRes = await fetchJson(detailUrl);
      const payload = extractMoviePayload(detailRes);
      if (payload && Array.isArray(payload.episodes) && payload.episodes.length > 0) {
        return payload;
      }
    }

    if (type === 'series' && fallbackSingleSeasonPayload && meta.absoluteEpisode) {
      return {
        movie: fallbackSingleSeasonPayload.movie,
        episodes: fallbackSingleSeasonPayload.episodes,
        useAbsoluteEpisode: true
      };
    }

    return null;
  }

  function findMatchingEpisodeItem(serverData, targetEpisode, absoluteEpisode = null, isMovie = false) {
    if (!Array.isArray(serverData) || serverData.length === 0) return null;

    if (isMovie) {
      const fullMatch = serverData.find(ep => {
        const s = String(ep.slug || '').toLowerCase();
        const n = String(ep.name || '').toLowerCase();
        return s === 'full' || n === 'full' || s === 'hd' || n === 'hd' || s === '1' || s === 'tap-1' || s === 'tap-01';
      });
      return fullMatch || serverData[0];
    }

    const extractEpNumbers = (ep) => {
      const numbers = [];
      const slug = String(ep.slug || '').toLowerCase().trim();
      const name = String(ep.name || '').toLowerCase().trim();

      const slugMatch = slug.match(/^(?:tap-|ep-|episode-|t-)?0*(\d+)(?:[-_][a-z]+)?$/i);
      if (slugMatch) numbers.push(parseInt(slugMatch[1], 10));

      const nameMatch = name.match(/(?:tập|tap|ep|episode|^)\s*0*(\d+)(?:\b|$)/i);
      if (nameMatch) numbers.push(parseInt(nameMatch[1], 10));

      return numbers;
    };

    if (targetEpisode !== null && targetEpisode !== undefined) {
      for (const ep of serverData) {
        const epNums = extractEpNumbers(ep);
        if (epNums.includes(Number(targetEpisode))) {
          return ep;
        }
      }
    }

    if (absoluteEpisode !== null && absoluteEpisode !== undefined) {
      for (const ep of serverData) {
        const epNums = extractEpNumbers(ep);
        if (epNums.includes(Number(absoluteEpisode))) {
          return ep;
        }
      }
    }

    return null;
  }

  function classifyAudioType(serverName) {
    const norm = normalizeText(serverName);

    if (norm.includes('long tieng') || norm.includes('longtieng')) {
      return {
        key: 'long-tieng',
        badge: '🔊 Lồng Tiếng',
        shortLabel: 'Lồng Tiếng',
        priority: 1
      };
    }
    if (norm.includes('thuyet minh') || norm.includes('thuyetminh')) {
      return {
        key: 'thuyet-minh',
        badge: '🎙️ Thuyết Minh',
        shortLabel: 'Thuyết Minh',
        priority: 2
      };
    }
    if (norm.includes('vietsub') || norm.includes('phu de') || norm.includes('sub')) {
      return {
        key: 'vietsub',
        badge: '🇻🇳 Vietsub',
        shortLabel: 'Vietsub',
        priority: 3
      };
    }

    return {
      key: 'other',
      badge: `🎬 ${serverName || 'Server KKPhim'}`,
      shortLabel: serverName || 'Mặc định',
      priority: 4
    };
  }

  async function getStreamsForStremio(type, rawId) {
    const parsedId = parseStremioId(rawId);
    const meta = await resolveMetadata(type, parsedId);
    const kkData = await findKKPhimMovieData(type, parsedId, meta);

    if (!kkData || !kkData.movie || !Array.isArray(kkData.episodes)) {
      return [];
    }

    const { movie, episodes, useAbsoluteEpisode } = kkData;
    const isMovie = type === 'movie';

    const categories = Array.isArray(movie.category)
      ? movie.category.map(c => c.name).filter(Boolean).join(', ')
      : (meta.genres || []).join(', ');

    const qualityBadge = movie.quality || 'FHD';
    const movieTitleVi = movie.name || meta.title || '';
    const movieTitleEn = movie.origin_name || meta.originalTitle || '';
    const yearStr = movie.year || meta.year || '';

    const rawStreams = [];

    for (const server of episodes) {
      const serverName = server.server_name || 'Vietsub';
      const serverData = server.server_data || [];
      const audioInfo = classifyAudioType(serverName);

      const matchedEp = findMatchingEpisodeItem(
        serverData,
        useAbsoluteEpisode ? meta.absoluteEpisode : parsedId.episode,
        meta.absoluteEpisode,
        isMovie
      );

      if (!matchedEp || !matchedEp.link_m3u8) continue;

      const epLabel = isMovie
        ? `Tập ${matchedEp.name || 'Full'}`
        : `S${String(parsedId.season || 1).padStart(2, '0')}E${String(parsedId.episode || 1).padStart(2, '0')} (${matchedEp.name || `Tập ${parsedId.episode}`})`;

      const titleLines = [
        `🎬 ${movieTitleVi}${movieTitleEn ? ` (${movieTitleEn})` : ''} ${yearStr ? `[${yearStr}]` : ''}`,
        `📺 ${epLabel} • 🎞️ ${qualityBadge} • ${audioInfo.badge}`,
        `🏷️ Thể loại: ${categories || 'Đang cập nhật'} • 🌐 Máy chủ: ${serverName}`
      ];

      rawStreams.push({
        _priority: audioInfo.priority,
        name: `KKPhim\n${audioInfo.shortLabel} (${qualityBadge})`,
        title: titleLines.join('\n'),
        url: matchedEp.link_m3u8,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: `kkphim-${audioInfo.key}-${qualityBadge}`
        }
      });
    }

    rawStreams.sort((a, b) => a._priority - b._priority);

    return rawStreams.map(({ _priority, ...streamObj }) => streamObj);
  }

  const NUVIO_PLUGIN_MANIFEST = [
    {
      id: 'kkphim-vn',
      name: 'KKPhim (Vietsub • Thuyết Minh • Lồng Tiếng)',
      description: 'Nguồn phim chất lượng cao từ KKPhim (phimapi.com) chuẩn TMDB ID',
      version: '1.2.1',
      author: 'KKPhim Nuvio Addon',
      supportedTypes: ['movie', 'tv'],
      filename: 'providers/kkphim.js',
      enabled: true,
      contentLanguage: ['vi']
    }
  ];

  function generateNuvioProviderScript(baseUrl) {
    return `function getStreams(tmdbId, mediaType, season, episode) {
  var stremioType = mediaType === 'tv' ? 'series' : 'movie';
  var stremioId = mediaType === 'tv'
    ? 'tmdb:' + tmdbId + ':' + (season || 1) + ':' + (episode || 1)
    : 'tmdb:' + tmdbId;
  var url = '${baseUrl}/stream/' + stremioType + '/' + encodeURIComponent(stremioId) + '.json';

  return fetch(url)
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (!data || !Array.isArray(data.streams)) return [];
      return data.streams.map(function(s) {
        return {
          name: (s.name || 'KKPhim').replace(/\\n/g, ' - '),
          title: s.title || 'KKPhim Stream',
          url: s.url,
          quality: '1080p'
        };
      });
    })
    .catch(function(err) {
      return [];
    });
}
module.exports = { getStreams: getStreams };
`;
  }

  module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      return res.end();
    }

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const baseUrl = `${proto}://${host}`;

    let urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/api/index.js' || urlPath === '/api/index' || urlPath === '/api') {
      urlPath = '/';
    } else if (urlPath.startsWith('/api/')) {
      urlPath = urlPath.slice(4);
    }

    if (urlPath === '/' || urlPath === '/index.html') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      return res.end(JSON.stringify({
        status: 'online',
        addon: MANIFEST.name,
        version: MANIFEST.version,
        install_addon_url: `${baseUrl}/manifest.json`,
        nuvio_plugin_manifest_url: `${baseUrl}/nuvio-manifest.json`
      }, null, 2));
    }

    if (urlPath === '/manifest.json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
      res.statusCode = 200;
      return res.end(JSON.stringify(MANIFEST));
    }

    if (urlPath === '/nuvio-manifest.json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      return res.end(JSON.stringify(NUVIO_PLUGIN_MANIFEST));
    }

    if (urlPath === '/providers/kkphim.js') {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.statusCode = 200;
      return res.end(generateNuvioProviderScript(baseUrl));
    }

    const streamMatch = urlPath.match(/^\/stream\/(movie|series)\/(.+?)\.json$/);
    if (streamMatch) {
      const type = streamMatch[1];
      const rawId = streamMatch[2];

      try {
        const streams = await getStreamsForStremio(type, rawId);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=900');
        res.statusCode = 200;
        return res.end(JSON.stringify({ streams }));
      } catch (error) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 200;
        return res.end(JSON.stringify({ streams: [] }));
      }
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'Endpoint not found', manifest: `${baseUrl}/manifest.json` }));
  };
})();
