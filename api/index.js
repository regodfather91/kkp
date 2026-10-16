```javascript
/**
 * Nuvio / Stremio Stream Addon - KKPhim (phimapi.com)
 * Chạy trên Vercel Serverless Functions (api/index.js)
 *
 * Tính năng cốt lõi:
 * 1. Không tạo Catalog rác (catalogs: []), lấy trực tiếp nguồn khi bấm vào phim từ Cinemeta Catalog mặc định.
 * 2. Ánh xạ chuẩn xác IMDb ID (tt...) từ Cinemeta sang TMDB ID (qua Cinemeta Meta API + TMDB Find API).
 * 3. Chống lệch Season & Tập phim: Kiểm tra chéo movie.tmdb.season, tự động quét kho phim khi KKPhim tách từng Season thành từng slug riêng, hỗ trợ cả cách đánh số tập theo mùa (S01E01) và số tập tuyệt đối (Absolute Episode cho Anime/Hoạt hình).
 * 4. Xác thực đúng định dạng/thể loại phim (Movie vs Series/TV Shows/Hoạt hình) và hiển thị đầy đủ nhãn Thể loại phim.
 * 5. Trích xuất toàn bộ nhánh âm thanh: Vietsub, Thuyết Minh, Lồng Tiếng (link trực tiếp HLS .m3u8).
 */

const KKPHIM_BASE = 'https://phimapi.com';
const CINEMETA_BASE = 'https://v3-cinemeta.strem.io';
const TMDB_API_BASE = 'https://api.themoviedb.org/3';

// Bộ nhớ đệm (In-memory LRU Cache đơn giản cho Serverless Warm Instance)
const cache = new Map();
const CACHE_TTL = 15 * 60 * 1000; // 15 phút

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

// Hàm gọi HTTP JSON an toàn có timeout
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
        'User-Agent': 'Nuvio-KKPhim-Addon/1.0'
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

// 1. Cấu hình Manifest chuẩn cho Nuvio / Stremio (Chỉ cấp Stream cho Cinemeta & TMDB, KHÔNG tạo Catalog)
const MANIFEST = {
  id: 'vn.nuvio.kkphim.streams',
  version: '1.2.0',
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

// 2. Phân tích cú pháp ID đầu vào từ Nuvio / Cinemeta
// Hỗ trợ:
// - Phim lẻ: "tt0111161" hoặc "tmdb:278"
// - Phim bộ: "tt0944947:1:1" hoặc "tmdb:1399:1:1"
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

// 3. Chuyển đổi chuẩn xác từ Cinemeta (IMDb ID) -> TMDB ID + Metadata (Tên gốc, Năm, Số tập tuyệt đối)
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

  // Bước 3A: Lấy Metadata từ Cinemeta mặc định (Luôn miễn phí, cực nhanh, có sẵn moviedb_id và danh sách videos)
  if (result.imdbId) {
    const cinemetaUrl = `${CINEMETA_BASE}/meta/${type}/${result.imdbId}.json`;
    const cinemetaData = await fetchJson(cinemetaUrl);
    const meta = cinemetaData?.meta;

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

      // Tính toán số tập tuyệt đối (Absolute Episode Number) cho Anime / Series nhiều mùa bị gộp trên KKPhim
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

  // Bước 3B: Nếu có cấu hình TMDB_API_KEY trong Environment Variables của Vercel, tra cứu chéo qua TMDB API chính thức
  const tmdbApiKey = process.env.TMDB_API_KEY;
  if (tmdbApiKey) {
    if (!result.tmdbId && result.imdbId) {
      const findUrl = `${TMDB_API_BASE}/find/${result.imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id&language=vi-VN`;
      const findData = await fetchJson(findUrl);
      if (findData) {
        const matchList = tmdbType === 'tv'
          ? (findData.tv_results?.length ? findData.tv_results : findData.movie_results)
          : (findData.movie_results?.length ? findData.movie_results : findData.tv_results);

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

// 4. Chuẩn hóa chuỗi để so khớp tên phim & kiểm tra Season trong tiêu đề
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

// Trích xuất số Season từ tên phim hoặc slug của KKPhim (VD: "Phần 2", "Season 3", "Part 2", "-s3")
function extractSeasonFromTitleOrSlug(name, originName, slug) {
  const combined = `${ normalizeText(name) } | ${ normalizeText(originName) } | ${ String(slug || '').toLowerCase() }`;
  const patterns = [
    /\b(?:phan|season|ss|mùa|mua)\s*0*(\d+)\b/i,
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

// Kiểm tra một bản ghi phim từ KKPhim có khớp đúng Season yêu cầu hay không
function isSeasonMatch(movieObj, targetSeason) {
  if (!targetSeason) return true;

  const tmdbSeason = movieObj?.tmdb?.season !== null && movieObj?.tmdb?.season !== undefined
    ? parseInt(movieObj.tmdb.season, 10)
    : null;

  if (tmdbSeason !== null && !Number.isNaN(tmdbSeason)) {
    return tmdbSeason === targetSeason;
  }

  const detectedSeason = extractSeasonFromTitleOrSlug(
    movieObj?.name,
    movieObj?.origin_name,
    movieObj?.slug
  );

  if (detectedSeason !== null) {
    return detectedSeason === targetSeason;
  }

  // Nếu phim không ghi số Season ở cả tmdb.season lẫn tiêu đề -> Mặc định là Season 1
  return targetSeason === 1;
}

// Kiểm tra tương thích loại phim (Movie vs Series)
function isTypeCompatible(movieObj, requestedType) {
  if (!movieObj) return false;
  const kkTmdbType = movieObj?.tmdb?.type;
  const kkType = movieObj?.type; // "single", "series", "hoathinh", "tvshows"

  if (requestedType === 'movie') {
    if (kkTmdbType === 'movie') return true;
    if (kkType === 'single') return true;
    // Phim hoạt hình chiếu rạp (movie) đôi khi có type="hoathinh"
    if (kkType === 'hoathinh' && (!movieObj?.tmdb?.season)) return true;
    return false;
  }

  if (requestedType === 'series') {
    if (kkTmdbType === 'tv') return true;
    if (kkType === 'series' || kkType === 'tvshows' || kkType === 'hoathinh') return true;
    return false;
  }

  return true;
}

// Chuẩn hóa phản hồi từ các endpoint của KKPhim về cấu trúc thống nhất { movie, episodes }
function extractMoviePayload(apiResponse) {
  if (!apiResponse) return null;
  // Cấu trúc /phim/{slug} hoặc /tmdb/{type}/{id}
  if (apiResponse.movie && Array.isArray(apiResponse.episodes)) {
    return { movie: apiResponse.movie, episodes: apiResponse.episodes };
  }
  // Cấu trúc /v1/api/phim/{slug} hoặc /v1/api/tmdb/{id}
  if (apiResponse.data?.item) {
    return {
      movie: apiResponse.data.item,
      episodes: apiResponse.data.item.episodes || apiResponse.episodes || []
    };
  }
  return null;
}

// 5. Truy vấn dữ liệu phim từ KKPhim đảm bảo đúng TMDB ID và đúng Season
async function findKKPhimMovieData(type, parsedId, meta) {
  const targetSeason = parsedId.season;
  const candidateSlugs = new Set();
  let fallbackSingleSeasonPayload = null;

  // BƯỚC 5.1: Gọi trực tiếp Endpoint chuẩn TMDB của KKPhim: GET /tmdb/{type}/{id}
  if (meta.tmdbId) {
    const directUrl = `${KKPHIM_BASE}/tmdb/${meta.tmdbType}/${meta.tmdbId}`;
    const directRes = await fetchJson(directUrl);

    if (directRes) {
      // Trường hợp API trả về trực tiếp 1 object phim kèm episodes
      const payload = extractMoviePayload(directRes);
      if (payload && isTypeCompatible(payload.movie, type)) {
        if (type === 'movie' || isSeasonMatch(payload.movie, targetSeason)) {
          if (payload.episodes && payload.episodes.length > 0) {
            return payload;
          }
          if (payload.movie?.slug) candidateSlugs.add(payload.movie.slug);
        } else if (type === 'series' && targetSeason > 1) {
          // Lưu lại thông tin tên gốc từ kết quả TMDB để tìm kiếm đúng Season
          if (!meta.originalTitle && payload.movie?.origin_name) {
            meta.originalTitle = payload.movie.origin_name;
          }
          if (!meta.title && payload.movie?.name) {
            meta.title = payload.movie.name;
          }
          fallbackSingleSeasonPayload = payload;
        }
      }

      // Trường hợp API trả về danh sách các mùa (items / list) có cùng TMDB ID
      const listItems = directRes.items || directRes.data?.items || (Array.isArray(directRes.data) ? directRes.data : null);
      if (Array.isArray(listItems)) {
        for (const item of listItems) {
          if (isTypeCompatible(item, type) && (type === 'movie' || isSeasonMatch(item, targetSeason))) {
            if (item.slug) candidateSlugs.add(item.slug);
          }
        }
      }
    }
  }

  // BƯỚC 5.2: Thử Endpoint IMDb của KKPhim nếu có IMDb ID và chưa khớp được ở Bước 5.1
  if (candidateSlugs.size === 0 && meta.imdbId) {
    const imdbUrl = `${KKPHIM_BASE}/imdb/title/${meta.imdbId}`;
    const imdbRes = await fetchJson(imdbUrl);
    const payload = extractMoviePayload(imdbRes);
    if (payload && isTypeCompatible(payload.movie, type)) {
      if (type === 'movie' || isSeasonMatch(payload.movie, targetSeason)) {
        if (payload.episodes && payload.episodes.length > 0) {
          return payload;
        }
        if (payload.movie?.slug) candidateSlugs.add(payload.movie.slug);
      } else if (type === 'series' && targetSeason > 1) {
        if (!meta.originalTitle && payload.movie?.origin_name) {
          meta.originalTitle = payload.movie.origin_name;
        }
        fallbackSingleSeasonPayload = fallbackSingleSeasonPayload || payload;
      }
    }
  }

  // BƯỚC 5.3: Tìm kiếm thông minh qua /v1/api/tim-kiem để xử lý triệt để trường hợp KKPhim tách nhiều Season thành các slug khác nhau
  if (candidateSlugs.size === 0) {
    const searchKeywords = [];
    if (meta.originalTitle) {
      // Bỏ phần "(Phần X)" nếu có sẵn để tìm gốc tên phim
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
      const items = searchRes?.data?.items || searchRes?.items || [];

      if (!Array.isArray(items) || items.length === 0) continue;

      // Ưu tiên 1: Khớp chính xác TMDB ID VÀ khớp chính xác Season
      for (const item of items) {
        const itemTmdbId = item?.tmdb?.id ? String(item.tmdb.id) : null;
        if (meta.tmdbId && itemTmdbId === String(meta.tmdbId)) {
          if (type === 'movie' || isSeasonMatch(item, targetSeason)) {
            if (item.slug) candidateSlugs.add(item.slug);
          } else if (type === 'series' && !fallbackSingleSeasonPayload && item.slug) {
            // Lưu dự phòng nếu bộ phim gộp toàn bộ tập vào Season 1 trên KKPhim
            const detailRes = await fetchJson(`${KKPHIM_BASE}/phim/${item.slug}`);
            fallbackSingleSeasonPayload = extractMoviePayload(detailRes);
          }
        }
      }

      if (candidateSlugs.size > 0) break;

      // Ưu tiên 2: Nếu mục trên KKPhim bị khuyết tmdb.id (tmdb.id == null), đối chiếu chuẩn bằng origin_name + năm/Season
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

  // BƯỚC 5.4: Lấy chi tiết phim và danh sách tập từ các slug ứng viên
  for (const slug of candidateSlugs) {
    const detailUrl = `${KKPHIM_BASE}/phim/${slug}`;
    const detailRes = await fetchJson(detailUrl);
    const payload = extractMoviePayload(detailRes);
    if (payload && Array.isArray(payload.episodes) && payload.episodes.length > 0) {
      return payload;
    }
  }

  // BƯỚC 5.5: Trường hợp Anime/Hoạt hình dài tập (như One Piece, Conan) trên KKPhim gộp chung tất cả các tập vào 1 phần duy nhất
  if (type === 'series' && fallbackSingleSeasonPayload && meta.absoluteEpisode) {
    return {
      ...fallbackSingleSeasonPayload,
      useAbsoluteEpisode: true
    };
  }

  return null;
}

// 6. Thuật toán khớp chính xác Tập phim (Không bao giờ lệch Tập 1 sang Tập 10, Tập 11...)
function findMatchingEpisodeItem(serverData, targetEpisode, absoluteEpisode = null, isMovie = false) {
  if (!Array.isArray(serverData) || serverData.length === 0) return null;

  // Đối với Phim lẻ (Movie)
  if (isMovie) {
    const fullMatch = serverData.find(ep => {
      const s = String(ep.slug || '').toLowerCase();
      const n = String(ep.name || '').toLowerCase();
      return s === 'full' || n === 'full' || s === 'hd' || n === 'hd' || s === '1' || s === 'tap-1' || s === 'tap-01';
    });
    return fullMatch || serverData[0];
  }

  // Hàm trích xuất số tập chính xác từ slug hoặc name của KKPhim
  const extractEpNumbers = (ep) => {
    const numbers = [];
    const slug = String(ep.slug || '').toLowerCase().trim();
    const name = String(ep.name || '').toLowerCase().trim();

    // Các mẫu chuẩn trên KKPhim: "tap-01", "tap-1", "tap-1-end", "Tập 01", "Episode 1", "01", "1"
    const slugMatch = slug.match(/^(?:tap-|ep-|episode-|t-)?0*(\d+)(?:[-_][a-z]+)?$/i);
    if (slugMatch) numbers.push(parseInt(slugMatch[1], 10));

    const nameMatch = name.match(/(?:tập|tap|ep|episode|^)\s*0*(\d+)(?:\b|$)/i);
    if (nameMatch) numbers.push(parseInt(nameMatch[1], 10));

    return numbers;
  };

  // Tìm theo số tập của Season hiện tại
  if (targetEpisode !== null && targetEpisode !== undefined) {
    for (const ep of serverData) {
      const epNums = extractEpNumbers(ep);
      if (epNums.includes(Number(targetEpisode))) {
        return ep;
      }
    }
  }

  // Dự phòng: Tìm theo số tập tuyệt đối (Absolute Episode) nếu phim gộp toàn bộ tập vào 1 danh sách
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

// 7. Phân loại Nhánh Âm Thanh / Phụ Đề (Vietsub, Thuyết Minh, Lồng Tiếng) từ server_name
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

// 8. Xây dựng danh sách Streams chuẩn cho Nuvio / Stremio
async function getStreamsForStremio(type, rawId) {
  const parsedId = parseStremioId(rawId);
  const meta = await resolveMetadata(type, parsedId);
  const kkData = await findKKPhimMovieData(type, parsedId, meta);

  if (!kkData || !kkData.movie || !Array.isArray(kkData.episodes)) {
    return [];
  }

  const { movie, episodes, useAbsoluteEpisode } = kkData;
  const isMovie = type === 'movie';

  // Lấy danh sách Thể loại phim từ KKPhim (VD: "Hành Động, Viễn Tưởng, Phiêu Lưu")
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

  // Sắp xếp thứ tự ưu tiên hiển thị: Lồng Tiếng / Thuyết Minh / Vietsub rõ ràng
  rawStreams.sort((a, b) => a._priority - b._priority);

  return rawStreams.map(({ _priority, ...streamObj }) => streamObj);
}

// 9. Mã nguồn Nuvio Native Provider (/providers/kkphim.js) dành cho người dùng muốn cài qua mục Plugins của Nuvio
const NUVIO_PLUGIN_MANIFEST = [
  {
    id: 'kkphim-vn',
    name: 'KKPhim (Vietsub • Thuyết Minh • Lồng Tiếng)',
    description: 'Nguồn phim chất lượng cao từ KKPhim (phimapi.com) chuẩn TMDB ID',
    version: '1.2.0',
    author: 'KKPhim Nuvio Addon',
    supportedTypes: ['movie', 'tv'],
    filename: 'providers/kkphim.js',
    enabled: true,
    contentLanguage: ['vi']
  }
];

function generateNuvioProviderScript(baseUrl) {
  return `// Nuvio Native Provider - KKPhim (Tương thích Hermes Engine dùng Promise thuần)
function getStreams(tmdbId, mediaType, season, episode) {
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
      console.error('[KKPhim Provider] Error:', err);
      return [];
    });
}
module.exports = { getStreams: getStreams };
`;
}

// 10. Vercel Serverless Handler chính (Hỗ trợ đầy đủ CORS & định tuyến động)
module.exports = async (req, res) => {
  // Cấu hình CORS bắt buộc cho Stremio & Nuvio
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
  const urlPath = (req.url || '/').split('?')[0];

  // Route 1: Trang chủ hướng dẫn nhanh & kiểm tra trạng thái hoạt động
  if (urlPath === '/' || urlPath === '/index.html') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = 200;
    return res.end(JSON.stringify({
      status: 'online',
      addon: MANIFEST.name,
      version: MANIFEST.version,
      install_addon_url: `${baseUrl}/manifest.json`,
      nuvio_plugin_manifest_url: `${baseUrl}/nuvio-manifest.json`,
      source_api: 'https://phimapi.com (https://kkphim.com/api-document)',
      features: [
        'Không tạo Catalog rác - Tích hợp trực tiếp vào Cinemeta Catalog mặc định',
        'Ánh xạ chuẩn xác IMDb ID -> TMDB ID',
        'Chống lệch Season & Tập phim (Tự động dò tìm đúng Phần/Season trên KKPhim)',
        'Đầy đủ nguồn Vietsub, Thuyết Minh, Lồng Tiếng (.m3u8 HLS)',
        'Hiển thị rõ Thể loại phim, Năm phát hành và Chất lượng'
      ]
    }, null, 2));
  }

  // Route 2: Manifest chính cho Nuvio / Stremio Addon (/manifest.json)
  if (urlPath === '/manifest.json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    res.statusCode = 200;
    return res.end(JSON.stringify(MANIFEST));
  }

  // Route 3: Manifest & Provider cho mục Nuvio Native Plugins (/nuvio-manifest.json & /providers/kkphim.js)
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

  // Route 4: Endpoint lấy nguồn phát (/stream/:type/:id.json)
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

  // Không khớp route
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = 404;
  return res.end(JSON.stringify({ error: 'Endpoint not found', manifest: `${baseUrl}/manifest.json` }));
};
