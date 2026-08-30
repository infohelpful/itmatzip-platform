<?php
declare(strict_types=1);

/**
 * 언어 prefix URL의 HTML 응답에 site-config 메타를 넣어 크롤러가 JS 없이 읽게 합니다.
 */

require_once __DIR__ . DIRECTORY_SEPARATOR . 'admin' . DIRECTORY_SEPARATOR . 'site-config-lib.php';

$root = realpath(__DIR__);
if ($root === false) {
  http_response_code(500);
  exit;
}

function seo_request_path() {
  $path = parse_url(isset($_SERVER['REQUEST_URI']) ? (string) $_SERVER['REQUEST_URI'] : '/', PHP_URL_PATH);
  return is_string($path) && $path !== '' ? $path : '/';
}

function seo_parse_request($path) {
  $parts = array_values(array_filter(explode('/', $path), function ($p) {
    return $p !== '';
  }));
  $lang = 'ko';
  if (isset($parts[0])) {
    $first = strtolower($parts[0]);
    if ($first === 'kr' || $first === 'ko') {
      $lang = 'ko';
      array_shift($parts);
    } elseif ($first === 'en' || $first === 'ja' || $first === 'zh') {
      $lang = $first;
      array_shift($parts);
    }
  }
  $rel = implode('/', $parts);
  return array($lang, $rel);
}

function seo_resolve_file($root, $rel) {
  $rel = str_replace('\\', '/', $rel);
  $rel = ltrim($rel, '/');
  if (strpos($rel, '..') !== false) {
    return null;
  }
  if ($rel === '') {
    $rel = 'index.html';
  }
  $candidates = array(
    $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel),
  );
  if (!preg_match('/\.html$/i', $rel)) {
    $candidates[] = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel) . DIRECTORY_SEPARATOR . 'index.html';
    $candidates[] = $root . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel) . '.html';
  }
  foreach ($candidates as $full) {
    if (is_file($full) && preg_match('/\.html$/i', $full)) {
      $real = realpath($full);
      if ($real === false) {
        continue;
      }
      if (strpos($real, $root) !== 0) {
        return null;
      }
      return $real;
    }
  }
  return null;
}

function seo_page_kind($rel, $html) {
  $norm = str_replace('\\', '/', $rel);
  $norm = ltrim($norm, '/');
  if ($norm === '' || $norm === 'index.html') {
    return array('hub', '');
  }
  if (preg_match('#^legal/([a-z]+)\.html$#i', $norm, $m)) {
    return array('legal', strtolower($m[1]));
  }
  if (preg_match('#^([a-z0-9-]+)/download\.html$#i', $norm, $m)) {
    return array('download', $m[1]);
  }
  if (preg_match('#^([a-z0-9-]+)(?:/index\.html)?$#i', $norm, $m)) {
    return array('tool', $m[1]);
  }
  if (preg_match('/data-tool-id=["\']([^"\']+)["\']/', $html, $m)) {
    return array('tool', $m[1]);
  }
  return array('other', '');
}

function seo_public_base() {
  $host = isset($_SERVER['HTTP_HOST']) && is_string($_SERVER['HTTP_HOST'])
    ? $_SERVER['HTTP_HOST']
    : 'tools.itmatzip.com';
  if (preg_match('/(^|\.)tools\.itmatzip\.com$/i', $host)) {
    return 'https://tools.itmatzip.com';
  }
  $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
    || ((isset($_SERVER['SERVER_PORT']) ? (int) $_SERVER['SERVER_PORT'] : 0) === 443);
  return ($https ? 'https' : 'http') . '://' . $host;
}

function seo_content_path($rel) {
  $rel = str_replace('\\', '/', $rel);
  $rel = ltrim($rel, '/');
  if ($rel === '' || $rel === 'index.html') {
    return '/';
  }
  if (preg_match('/\.html$/i', $rel) && !preg_match('/download\.html$/i', $rel) && !preg_match('#^legal/#', $rel)) {
    $rel = preg_replace('/index\.html$/i', '', $rel);
  }
  if ($rel !== '' && substr($rel, -1) !== '/' && !preg_match('/\.html$/i', $rel)) {
    $rel .= '/';
  }
  return '/' . ltrim($rel, '/');
}

function seo_lang_url($base, $lang, $contentPath) {
  $prefix = lang_url_prefix($lang);
  if ($contentPath === '/' || $contentPath === '') {
    return $base . '/' . $prefix . '/';
  }
  return $base . '/' . $prefix . $contentPath;
}

function seo_abs_url($base, $path) {
  if ($path === '') {
    return '';
  }
  if (preg_match('#^https?://#i', $path)) {
    return $path;
  }
  return $base . $path;
}

function seo_set_html_lang($html, $htmlLang) {
  if (preg_match('/<html\b([^>]*)>/i', $html, $m)) {
    $attrs = $m[1];
    if (preg_match('/\blang=/i', $attrs)) {
      $attrs = preg_replace('/\blang=(["\'])[^"\']*\1/i', 'lang="' . $htmlLang . '"', $attrs);
    } else {
      $attrs .= ' lang="' . htmlspecialchars($htmlLang, ENT_QUOTES, 'UTF-8') . '"';
    }
    return preg_replace('/<html\b[^>]*>/i', '<html' . $attrs . '>', $html, 1);
  }
  return $html;
}

function seo_replace_title($html, $title) {
  $safe = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
  if (preg_match('/<title\b[^>]*>.*?<\/title>/is', $html)) {
    return preg_replace('/<title\b[^>]*>.*?<\/title>/is', '<title>' . $safe . '</title>', $html, 1);
  }
  return preg_replace('/<\/head>/i', "  <title>{$safe}</title>\n</head>", $html, 1);
}

function seo_set_meta($html, $attr, $key, $content) {
  $safe = htmlspecialchars($content, ENT_QUOTES, 'UTF-8');
  $keyQ = preg_quote($key, '/');
  $attrQ = preg_quote($attr, '/');
  $pattern = '/<meta\s+[^>]*' . $attrQ . '=["\']' . $keyQ . '["\'][^>]*>/i';
  $tag = '<meta ' . $attr . '="' . $key . '" content="' . $safe . '">';
  if (preg_match($pattern, $html)) {
    return preg_replace($pattern, $tag, $html, 1);
  }
  return preg_replace('/<\/head>/i', "  {$tag}\n</head>", $html, 1);
}

function seo_set_link($html, $rel, $href, $hreflang = '') {
  $hrefSafe = htmlspecialchars($href, ENT_QUOTES, 'UTF-8');
  if ($hreflang !== '') {
    $hl = htmlspecialchars($hreflang, ENT_QUOTES, 'UTF-8');
    $pattern = '/<link\s+[^>]*rel=["\']' . preg_quote($rel, '/') . '["\'][^>]*hreflang=["\']' . preg_quote($hreflang, '/') . '["\'][^>]*>/i';
    $pattern2 = '/<link\s+[^>]*hreflang=["\']' . preg_quote($hreflang, '/') . '["\'][^>]*rel=["\']' . preg_quote($rel, '/') . '["\'][^>]*>/i';
    $tag = '<link rel="' . $rel . '" hreflang="' . $hl . '" href="' . $hrefSafe . '">';
    if (preg_match($pattern, $html)) {
      return preg_replace($pattern, $tag, $html, 1);
    }
    if (preg_match($pattern2, $html)) {
      return preg_replace($pattern2, $tag, $html, 1);
    }
    return preg_replace('/<\/head>/i', "  {$tag}\n</head>", $html, 1);
  }
  $pattern = '/<link\s+[^>]*rel=["\']' . preg_quote($rel, '/') . '["\'](?![^>]*hreflang)[^>]*>/i';
  $tag = '<link rel="' . $rel . '" href="' . $hrefSafe . '">';
  if (preg_match($pattern, $html)) {
    return preg_replace($pattern, $tag, $html, 1);
  }
  return preg_replace('/<\/head>/i', "  {$tag}\n</head>", $html, 1);
}

function seo_patch_jsonld($html, $name, $description, $htmlLang) {
  if (!preg_match('/<script\s+type=["\']application\/ld\+json["\']>\s*(\{.*?\})\s*<\/script>/is', $html, $m)) {
    return $html;
  }
  $data = json_decode($m[1], true);
  if (!is_array($data)) {
    return $html;
  }
  $nodes = isset($data['@graph']) && is_array($data['@graph']) ? $data['@graph'] : array($data);
  foreach ($nodes as &$node) {
    if (!is_array($node)) {
      continue;
    }
    if ($name !== '') {
      $node['name'] = $name;
    }
    $type = isset($node['@type']) ? (string) $node['@type'] : '';
    if ($description !== '' && ($type === 'WebApplication' || $type === 'WebSite' || $type === 'WebPage')) {
      $node['description'] = $description;
      $node['inLanguage'] = $htmlLang;
    }
  }
  unset($node);
  if (isset($data['@graph'])) {
    $data['@graph'] = $nodes;
  } else {
    $data = $nodes[0];
  }
  $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
  if (!is_string($json)) {
    return $html;
  }
  return preg_replace(
    '/<script\s+type=["\']application\/ld\+json["\']>\s*\{.*?\}\s*<\/script>/is',
    "<script type=\"application/ld+json\">\n" . $json . "\n</script>",
    $html,
    1
  );
}

$path = seo_request_path();
list($lang, $rel) = seo_parse_request($path);
$file = seo_resolve_file($root, $rel);
if ($file === null) {
  http_response_code(404);
  header('Content-Type: text/plain; charset=utf-8');
  echo 'Not Found';
  exit;
}

$html = file_get_contents($file);
if (!is_string($html) || $html === '') {
  http_response_code(500);
  exit;
}

$cfg = public_config();
list($kind, $id) = seo_page_kind($rel !== '' ? $rel : 'index.html', $html);
$seo = page_seo_fields($cfg, $kind, $id, $lang);
$htmlLang = SEO_HTML_LANG[$lang] ?? $lang;
$ogLocale = SEO_OG_LOCALE[$lang] ?? 'ko_KR';
$base = seo_public_base();
$contentPath = seo_content_path($rel);
$selfUrl = seo_lang_url($base, $lang, $contentPath);
$isDownload = $kind === 'download';
if ($isDownload && $id !== '') {
  $contentPath = '/' . $id . '/';
  $selfUrl = seo_lang_url($base, $lang, $contentPath);
}

$html = seo_set_html_lang($html, $htmlLang);
$html = seo_set_meta($html, 'property', 'og:locale', $ogLocale);
$html = seo_set_meta($html, 'property', 'og:url', $selfUrl);
$html = seo_set_link($html, 'canonical', $selfUrl);
foreach (ALLOWED_LANGS as $alt) {
  $html = seo_set_link($html, 'alternate', seo_lang_url($base, $alt, $contentPath), $alt);
}
$html = seo_set_link($html, 'alternate', seo_lang_url($base, 'ko', $contentPath), 'x-default');

if (!$isDownload) {
  if ($seo['title'] !== '') {
    $html = seo_replace_title($html, $seo['title']);
    $html = seo_set_meta($html, 'property', 'og:title', $seo['title']);
    $html = seo_set_meta($html, 'name', 'twitter:title', $seo['title']);
  }
  if ($seo['description'] !== '') {
    $html = seo_set_meta($html, 'name', 'description', $seo['description']);
    $html = seo_set_meta($html, 'property', 'og:description', $seo['description']);
    $html = seo_set_meta($html, 'name', 'twitter:description', $seo['description']);
  }
  if ($seo['keywords'] !== '') {
    $html = seo_set_meta($html, 'name', 'keywords', $seo['keywords']);
  }
  $ogAbs = seo_abs_url($base, $seo['ogImage']);
  if ($ogAbs !== '') {
    $html = seo_set_meta($html, 'property', 'og:image', $ogAbs);
    $html = seo_set_meta($html, 'name', 'twitter:image', $ogAbs);
    $alt = $seo['title'] !== '' ? $seo['title'] : ($seo['displayTitle'] !== '' ? $seo['displayTitle'] : 'ItMatZip Tools');
    $html = seo_set_meta($html, 'property', 'og:image:alt', $alt);
  }
  $ldName = $seo['displayTitle'] !== '' ? $seo['displayTitle'] : $seo['title'];
  $html = seo_patch_jsonld($html, $ldName, $seo['description'], $htmlLang);
}

$mtime = filemtime($file);
header('Content-Type: text/html; charset=utf-8');
header('X-Content-Type-Options: nosniff');
if ($mtime) {
  header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $mtime) . ' GMT');
}
echo $html;
