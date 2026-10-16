(function () {
  var KKPHIM_BASE = 'https://phimapi.com';
  var CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
  var TMDB_API_BASE = 'https://api.themoviedb.org/3';

  var cache = new Map();
  var CACHE_TTL = 15 * 60 * 1000;

  function getCache(key) {
    var item = cache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
      cache.delete(key);
      return null;
    }
    return item.value;
  }

  function setCache(key, value, ttl) {
    var effectiveTtl = ttl || CACHE_TTL;
    if (cache.size > 500) {
      var firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(key, { value: value, expiry: Date.now() + effectiveTtl });
  }

  async function fetchJson(url, timeoutMs) {
    var timeout = timeoutMs || 7000;
    var cached = getCache(url);
    if (cached) return cached;

    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeout);

    try {
      var res = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Nuvio-KKPhim-Addon/1.0'
        },
        signal: controller.signal
      });
      if (!res.ok) return null;
      var data = await res.json();
      setCache(url, data);
      return data;
    } catch (err) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  var MANIFEST = {
    id: 'vn.nuvio.kkphim.streams',
    version: '1.0.0',
    name: 'KKPhim',
    description: 'Addon lấy nguồn phim chuẩn TMDB ID từ KKPhim. Chuẩn Mùa/Tập, đầy đủ Vietsub, Thuyết Minh, Lồng Tiếng.',
    logo: 'https://raw.githubusercontent.com/regodfather91/kkp/main/logo.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'tmdb:', 'tmdb'],
    catalogs: [],
    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };

  function parseStremioId(rawId) {
    var decoded = decodeURIComponent(String(rawId || '').trim());

    if (decoded.startsWith('tmdb:')) {
      var parts = decoded.split(':');
      return {
        source: 'tmdb',
        tmdbId: parts[1],
        imdbId: null,
        season: parts[2] ? parseInt(parts[2], 10) : null,
        episode: parts[3] ? parseInt(parts[3], 10) : null
      };
    }

    if (decoded.startsWith('tmdb-')) {
      var dashParts = decoded.replace('tmdb-', '').split(':');
      return {
        source: 'tmdb',
        tmdbId: dashParts[0],
        imdbId: null,
        season: dashParts[1] ? parseInt(dashParts[1], 10) : null,
        episode: dashParts[2] ? parseInt(dashParts[2], 10) : null
      };
    }

    var imdbParts = decoded.split(':');
    return {
      source: 'imdb',
      imdbId: imdbParts[0],
      tmdbId: null,
      season: imdbParts[1] ? parseInt(imdbParts[1], 10) : null,
      episode: imdbParts[2] ? parseInt(imdbParts[2], 10) : null
    };
  }

  async function resolveMetadata(type, parsedId) {
    var tmdbType = type === 'series' ? 'tv' : 'movie';
    var result = {
      tmdbId: parsedId.tmdbId || null,
      imdbId: parsedId.imdbId || null,
      tmdbType: tmdbType,
      title: null,
      originalTitle: null,
      year: null,
      absoluteEpisode: null
    };

    if (result.imdbId) {
      var cinemetaUrl = CINEMETA_BASE + '/meta/' + type + '/' + result.imdbId + '.json';
      var cinemetaData = await fetchJson(cinemetaUrl);
      var meta = cinemetaData && cinemetaData.meta ? cinemetaData.meta : null;

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

        if (type === 'series' && Array.isArray(meta.videos) && parsedId.season && parsedId.episode) {
          var regularVideos = meta.videos
            .filter(function (v) { return Number(v.season) > 0 && Number(v.episode || v.number) > 0; })
            .sort(function (a, b) {
              if (Number(a.season) !== Number(b.season)) return Number(a.season) - Number(b.season);
              return Number(a.episode || a.number) - Number(b.episode || b.number);
            });

          var absCount = 0;
          for (var i = 0; i < regularVideos.length; i++) {
            var v = regularVideos[i];
            absCount++;
            var epNum = Number(v.episode || v.number);
            if (Number(v.season) === parsedId.season && epNum === parsedId.episode) {
              result.absoluteEpisode = absCount;
              break;
            }
          }
        }
      }
    }

    var tmdbApiKey = process.env.TMDB_API_KEY;
    if (tmdbApiKey) {
      if (!result.tmdbId && result.imdbId) {
        var findUrl = TMDB_API_BASE + '/find/' + result.imdbId + '?api_key=' + tmdbApiKey + '&external_source=imdb_id&language=vi-VN';
        var findData = await fetchJson(findUrl);
        if (findData) {
          var matchList = tmdbType === 'tv'
            ? ((findData.tv_results && findData.tv_results.length) ? findData.tv_results : findData.movie_results)
            : ((findData.movie_results && findData.movie_results.length) ? findData.movie_results : findData.tv_results);

          if (matchList && matchList.length > 0) {
            var item = matchList[0];
            result.tmdbId = String(item.id);
            result.title = item.title || item.name || result.title;
            result.originalTitle = item.original_title || item.original_name || result.originalTitle;
            var dateStr = item.release_date || item.first_air_date;
            if (dateStr) result.year = parseInt(dateStr.slice(0, 4), 10);
          }
        }
      } else if (result.tmdbId && !result.originalTitle) {
        var detailUrl = TMDB_API_BASE + '/' + tmdbType + '/' + result.tmdbId + '?api_key=' + tmdbApiKey + '&language=vi-VN';
        var detailData = await fetchJson(detailUrl);
        if (detailData) {
          result.title = detailData.title || detailData.name || result.title;
          result.originalTitle = detailData.original_title || detailData.original_name || result.originalTitle;
          var dStr = detailData.release_date || detailData.first_air_date;
          if (dStr) result.year = parseInt(dStr.slice(0, 4), 10);
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

  function toSlug(str) {
    return normalizeText(str).replace(/\s+/g, '-');
  }

  function cleanTitleForMatch(rawTitle, yearToStrip) {
    var cleaned = String(rawTitle || '')
      .replace(/[\(\[\{]\s*(?:19|20)\d{2}\s*[\)\]\}]/g, ' ')
      .replace(/[\(\[\{]\s*(?:phần|phan|season|ss|mùa|mua|part)\s*\d+\s*[\)\]\}]/gi, ' ');

    var norm = normalizeText(cleaned)
      .replace(/\b(?:phan|season|ss|mua|part)\s*0*\d+\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (yearToStrip) {
      var yearRegex = new RegExp('\\b' + yearToStrip + '$');
      var stripped = norm.replace(yearRegex, '').trim();
      if (stripped.length > 0) {
        norm = stripped;
      }
    }

    return norm;
  }

  function extractYearFromItem(item) {
    if (item && item.year && !Number.isNaN(parseInt(item.year, 10))) {
      return parseInt(item.year, 10);
    }
    var combined = ((item && item.name) || '') + ' ' + ((item && item.origin_name) || '') + ' ' + ((item && item.slug) || '');
    var match = combined.match(/(?:[\(\[\-\s])((?:19|20)\d{2})(?:[\)\]\s]|$)/);
    if (match && match[1]) {
      return parseInt(match[1], 10);
    }
    return null;
  }

  function extractSeasonFromTitleOrSlug(name, originName, slug) {
    var combined = normalizeText(name) + ' | ' + normalizeText(originName) + ' | ' + String(slug || '').toLowerCase();
    var patterns = [
      /\b(?:phan|season|ss|mua)\s*0*(\d+)\b/i,
      /\bs0*(\d+)\b/i,
      /-phan-0*(\d+)\b/i,
      /-season-0*(\d+)\b/i
    ];
    for (var i = 0; i < patterns.length; i++) {
      var match = combined.match(patterns[i]);
      if (match && match[1]) {
        return parseInt(match[1], 10);
      }
    }
    return null;
  }

  function isSeasonMatch(movieObj, targetSeason) {
    if (!targetSeason) return true;

    var rawTmdbSeason = movieObj && movieObj.tmdb ? movieObj.tmdb.season : null;
    var tmdbSeason = rawTmdbSeason !== null && rawTmdbSeason !== undefined
      ? parseInt(rawTmdbSeason, 10)
      : null;

    if (tmdbSeason !== null && !Number.isNaN(tmdbSeason)) {
      return tmdbSeason === targetSeason;
    }

    var detectedSeason = extractSeasonFromTitleOrSlug(
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
    var kkTmdbType = movieObj.tmdb ? movieObj.tmdb.type : null;
    var kkType = movieObj.type;

    if (requestedType === 'movie') {
      if (kkTmdbType === 'movie') return true;
      if (kkType === 'single' || kkType === 'chieurap') return true;
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

  function isTitleAndYearMatch(item, meta, requestedType, targetSeason) {
    if (!isTypeCompatible(item, requestedType)) return false;

    var itemYear = extractYearFromItem(item);
    var refYear = meta.year || itemYear;

    var targetTitles = [
      cleanTitleForMatch(meta.originalTitle, refYear),
      cleanTitleForMatch(meta.title, refYear)
    ].filter(Boolean);

    if (targetTitles.length === 0) return false;

    var itemTitles = [
      cleanTitleForMatch(item.origin_name, refYear),
      cleanTitleForMatch(item.name, refYear)
    ].filter(Boolean);

    var isExactTitle = itemTitles.some(function (t) { return targetTitles.includes(t); });
    if (!isExactTitle) return false;

    if (requestedType === 'movie') {
      if (meta.year && itemYear && Math.abs(itemYear - meta.year) > 1) {
        return false;
      }
      return true;
    }

    return isSeasonMatch(item, targetSeason);
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
    var targetSeason = parsedId.season;
    var candidateSlugs = new Set();
    var fallbackSingleSeasonPayload = null;

    if (meta.tmdbId) {
      var directUrl = KKPHIM_BASE + '/tmdb/' + meta.tmdbType + '/' + meta.tmdbId;
      var directRes = await fetchJson(directUrl);

      if (directRes) {
        var payload = extractMoviePayload(directRes);
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

        var listItems = directRes.items || (directRes.data && directRes.data.items) || (Array.isArray(directRes.data) ? directRes.data : null);
        if (Array.isArray(listItems)) {
          for (var i = 0; i < listItems.length; i++) {
            var listItem = listItems[i];
            if (isTypeCompatible(listItem, type) && (type === 'movie' || isSeasonMatch(listItem, targetSeason))) {
              if (listItem.slug) candidateSlugs.add(listItem.slug);
            }
          }
        }
      }
    }

    if (candidateSlugs.size === 0 && meta.imdbId) {
      var imdbUrl = KKPHIM_BASE + '/imdb/title/' + meta.imdbId;
      var imdbRes = await fetchJson(imdbUrl);
      var imdbPayload = extractMoviePayload(imdbRes);
      if (imdbPayload && isTypeCompatible(imdbPayload.movie, type)) {
        if (type === 'movie' || isSeasonMatch(imdbPayload.movie, targetSeason)) {
          if (imdbPayload.episodes && imdbPayload.episodes.length > 0) {
            return imdbPayload;
          }
          if (imdbPayload.movie && imdbPayload.movie.slug) candidateSlugs.add(imdbPayload.movie.slug);
        } else if (type === 'series' && targetSeason > 1) {
          if (!meta.originalTitle && imdbPayload.movie && imdbPayload.movie.origin_name) {
            meta.originalTitle = imdbPayload.movie.origin_name;
          }
          fallbackSingleSeasonPayload = fallbackSingleSeasonPayload || imdbPayload;
        }
      }
    }

    if (candidateSlugs.size === 0) {
      var searchKeywords = [];
      var baseOrigin = meta.originalTitle
        ? meta.originalTitle.replace(/\s*\((?:Phần|Season|\d{4})\s*\d*\)/gi, '').trim()
        : '';
      var baseTitle = (meta.title && meta.title !== meta.originalTitle)
        ? meta.title.replace(/\s*\((?:Phần|Season|\d{4})\s*\d*\)/gi, '').trim()
        : '';

      if (type === 'movie' && baseOrigin && meta.year && baseOrigin.length <= 12) {
        searchKeywords.push(baseOrigin + ' ' + meta.year);
      }
      if (baseOrigin) searchKeywords.push(baseOrigin);
      if (baseTitle) searchKeywords.push(baseTitle);
      if (type === 'movie' && baseOrigin && meta.year && baseOrigin.length > 12) {
        searchKeywords.push(baseOrigin + ' ' + meta.year);
      }

      for (var k = 0; k < searchKeywords.length; k++) {
        var kw = searchKeywords[k];
        if (!kw) continue;
        var searchUrl = KKPHIM_BASE + '/v1/api/tim-kiem?keyword=' + encodeURIComponent(kw) + '&limit=32';
        var searchRes = await fetchJson(searchUrl);
        var items = (searchRes && searchRes.data && searchRes.data.items) || (searchRes && searchRes.items) || [];

        if (!Array.isArray(items) || items.length === 0) continue;

        for (var j = 0; j < items.length; j++) {
          var item = items[j];
          var itemTmdbId = (item && item.tmdb && item.tmdb.id) ? String(item.tmdb.id) : null;
          if (meta.tmdbId && itemTmdbId === String(meta.tmdbId)) {
            if (type === 'movie' || isSeasonMatch(item, targetSeason)) {
              if (item.slug) candidateSlugs.add(item.slug);
            } else if (type === 'series' && !fallbackSingleSeasonPayload && item.slug) {
              var detailRes = await fetchJson(KKPHIM_BASE + '/phim/' + item.slug);
              fallbackSingleSeasonPayload = extractMoviePayload(detailRes);
            }
          }
        }

        if (candidateSlugs.size > 0) break;

        for (var mIdx = 0; mIdx < items.length; mIdx++) {
          var candidate = items[mIdx];
          if (isTitleAndYearMatch(candidate, meta, type, targetSeason)) {
            if (candidate.slug) candidateSlugs.add(candidate.slug);
          }
        }

        if (candidateSlugs.size > 0) break;
      }
    }

    if (candidateSlugs.size === 0 && (meta.originalTitle || meta.title)) {
      var baseSlug = toSlug(cleanTitleForMatch(meta.originalTitle || meta.title, meta.year));
      var directSlugsToTry = [];

      if (baseSlug) {
        if (type === 'movie') {
          if (meta.year) directSlugsToTry.push(baseSlug + '-' + meta.year);
          directSlugsToTry.push(baseSlug);
        } else if (type === 'series') {
          if (targetSeason && targetSeason > 1) {
            directSlugsToTry.push(baseSlug + '-phan-' + targetSeason);
            directSlugsToTry.push(baseSlug + '-season-' + targetSeason);
          }
          directSlugsToTry.push(baseSlug);
        }
      }

      for (var sIdx = 0; sIdx < directSlugsToTry.length; sIdx++) {
        var testSlug = directSlugsToTry[sIdx];
        var directDetailRes = await fetchJson(KKPHIM_BASE + '/phim/' + testSlug);
        var directPayload = extractMoviePayload(directDetailRes);
        if (directPayload && directPayload.movie && Array.isArray(directPayload.episodes) && directPayload.episodes.length > 0) {
          var m = directPayload.movie;
          var tmdbMatched = meta.tmdbId && m.tmdb && m.tmdb.id && String(m.tmdb.id) === String(meta.tmdbId);
          if (tmdbMatched || isTitleAndYearMatch(m, meta, type, targetSeason)) {
            return directPayload;
          }
        }
      }
    }

    var slugArray = Array.from(candidateSlugs);
    for (var cIdx = 0; cIdx < slugArray.length; cIdx++) {
      var slug = slugArray[cIdx];
      var slugDetailRes = await fetchJson(KKPHIM_BASE + '/phim/' + slug);
      var slugPayload = extractMoviePayload(slugDetailRes);
      if (slugPayload && Array.isArray(slugPayload.episodes) && slugPayload.episodes.length > 0) {
        return slugPayload;
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

  function findMatchingEpisodeItem(serverData, targetEpisode, absoluteEpisode, isMovie) {
    if (!Array.isArray(serverData) || serverData.length === 0) return null;

    if (isMovie) {
      var fullMatch = serverData.find(function (ep) {
        var s = String(ep.slug || '').toLowerCase();
        var n = String(ep.name || '').toLowerCase();
        return s === 'full' || n === 'full' || s === 'hd' || n === 'hd' || s === 'fhd' || n === 'fhd' || s === '1' || s === 'tap-1' || s === 'tap-01';
      });
      return fullMatch || serverData[0];
    }

    var extractEpNumbers = function (ep) {
      var numbers = [];
      var slug = String(ep.slug || '').toLowerCase().trim();
      var name = String(ep.name || '').toLowerCase().trim();

      var slugMatch = slug.match(/^(?:tap-|ep-|episode-|t-)?0*(\d+)(?:[-_][a-z]+)?$/i);
      if (slugMatch) numbers.push(parseInt(slugMatch[1], 10));

      var nameMatch = name.match(/(?:tập|tap|ep|episode|^)\s*0*(\d+)(?:\b|$)/i);
      if (nameMatch) numbers.push(parseInt(nameMatch[1], 10));

      return numbers;
    };

    if (targetEpisode !== null && targetEpisode !== undefined) {
      for (var i = 0; i < serverData.length; i++) {
        var ep = serverData[i];
        var epNums = extractEpNumbers(ep);
        if (epNums.includes(Number(targetEpisode))) {
          return ep;
        }
      }
    }

    if (absoluteEpisode !== null && absoluteEpisode !== undefined) {
      for (var j = 0; j < serverData.length; j++) {
        var absEp = serverData[j];
        var absNums = extractEpNumbers(absEp);
        if (absNums.includes(Number(absoluteEpisode))) {
          return absEp;
        }
      }
    }

    return null;
  }

  function classifyAudioType(serverName) {
    var norm = normalizeText(serverName);

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
    if (norm.includes('vietsub') || norm.includes('phu de') || norm.includes('sub viet')) {
      return {
        key: 'vietsub',
        badge: '🇻🇳 Vietsub',
        shortLabel: 'Vietsub',
        priority: 3
      };
    }
    if (norm.includes('engsub') || norm.includes('sub anh')) {
      return {
        key: 'engsub',
        badge: '🇬🇧 Engsub',
        shortLabel: 'Engsub',
        priority: 4
      };
    }

    return {
      key: 'other',
      badge: '🎬 ' + (serverName || 'Server KKPhim'),
      shortLabel: serverName || 'Mặc định',
      priority: 5
    };
  }

  async function getStreamsForStremio(type, rawId) {
    var parsedId = parseStremioId(rawId);
    var meta = await resolveMetadata(type, parsedId);
    var kkData = await findKKPhimMovieData(type, parsedId, meta);

    if (!kkData || !kkData.movie || !Array.isArray(kkData.episodes)) {
      return [];
    }

    var movie = kkData.movie;
    var episodes = kkData.episodes;
    var useAbsoluteEpisode = kkData.useAbsoluteEpisode;
    var isMovie = type === 'movie';

    var qualityBadge = movie.quality || 'FHD';
    var movieTitleVi = movie.name || meta.title || '';
    var movieTitleEn = movie.origin_name || meta.originalTitle || '';
    var yearStr = movie.year || meta.year || '';

    var rawStreams = [];

    for (var i = 0; i < episodes.length; i++) {
      var server = episodes[i];
      var serverName = server.server_name || 'Vietsub';
      var serverData = server.server_data || [];
      var audioInfo = classifyAudioType(serverName);

      var matchedEp = findMatchingEpisodeItem(
        serverData,
        useAbsoluteEpisode ? meta.absoluteEpisode : parsedId.episode,
        meta.absoluteEpisode,
        isMovie
      );

      if (!matchedEp || !matchedEp.link_m3u8) continue;

      var epLabel = isMovie
        ? 'Tập ' + (matchedEp.name || 'Full')
        : 'S' + String(parsedId.season || 1).padStart(2, '0') + 'E' + String(parsedId.episode || 1).padStart(2, '0') + ' (' + (matchedEp.name || ('Tập ' + parsedId.episode)) + ')';

      var titleLines = [
        ('🎬 ' + movieTitleVi + (movieTitleEn && movieTitleEn !== movieTitleVi ? ' (' + movieTitleEn + ')' : '') + (yearStr ? ' [' + yearStr + ']' : '')).trim(),
        '📺 ' + epLabel + ' • 🎞️ ' + qualityBadge + ' • ' + audioInfo.badge,
        '🌐 Máy chủ: ' + serverName
      ];

      rawStreams.push({
        _priority: audioInfo.priority,
        name: 'KKPhim\n' + audioInfo.shortLabel + ' (' + qualityBadge + ')',
        title: titleLines.join('\n'),
        url: matchedEp.link_m3u8,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: 'kkphim-' + audioInfo.key + '-' + qualityBadge
        }
      });
    }

    rawStreams.sort(function (a, b) { return a._priority - b._priority; });

    return rawStreams.map(function (item) {
      return {
        name: item.name,
        title: item.title,
        url: item.url,
        behaviorHints: item.behaviorHints
      };
    });
  }

  var NUVIO_PLUGIN_MANIFEST = [
    {
      id: 'kkphim-vn',
      name: 'KKPhim Streams',
      description: 'Addon lấy nguồn phim chuẩn TMDB ID từ KKPhim. Chuẩn Season/Tập, đầy đủ Vietsub, Thuyết Minh, Lồng Tiếng.',
      version: '1.0.0',
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

    var host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    var proto = req.headers['x-forwarded-proto'] || 'https';
    var baseUrl = proto + '://' + host;

    var urlPath = (req.url || '/').split('?')[0];
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
        install_addon_url: baseUrl + '/manifest.json',
        nuvio_plugin_manifest_url: baseUrl + '/nuvio-manifest.json'
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

    var debugMatch = urlPath.match(/^\/debug\/(movie|series)\/(.+?)$/);
    if (debugMatch) {
      var dType = debugMatch[1];
      var dRawId = debugMatch[2].replace(/\.json$/, '');
      var parsedId = parseStremioId(dRawId);
      var meta = await resolveMetadata(dType, parsedId);
      var kkData = await findKKPhimMovieData(dType, parsedId, meta);
      var streams = await getStreamsForStremio(dType, dRawId);

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.statusCode = 200;
      return res.end(JSON.stringify({
        input: { type: dType, rawId: dRawId, parsedId: parsedId },
        resolved_meta: meta,
        kkphim_matched_movie: kkData && kkData.movie ? {
          name: kkData.movie.name,
          origin_name: kkData.movie.origin_name,
          slug: kkData.movie.slug,
          year: kkData.movie.year,
          type: kkData.movie.type,
          tmdb: kkData.movie.tmdb
        } : null,
        servers_found: kkData && Array.isArray(kkData.episodes) ? kkData.episodes.map(function (s) {
          return {
            server_name: s.server_name,
            episode_count: Array.isArray(s.server_data) ? s.server_data.length : 0
          };
        }) : [],
        streams_returned: streams
      }, null, 2));
    }

    var streamMatch = urlPath.match(/^\/stream\/(movie|series)\/(.+?)\.json$/);
    if (streamMatch) {
      var type = streamMatch[1];
      var rawId = streamMatch[2];

      try {
        var streamList = await getStreamsForStremio(type, rawId);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=900, s-maxage=900');
        res.statusCode = 200;
        return res.end(JSON.stringify({ streams: streamList }));
      } catch (error) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.statusCode = 200;
        return res.end(JSON.stringify({ streams: [] }));
      }
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: 'Endpoint not found', manifest: baseUrl + '/manifest.json' }));
  };
})();
