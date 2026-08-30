<?php
declare(strict_types=1);

/**
 * tools.itmatzip.com 사이트맵.
 * assets/tools-registry.js 의 TOOLS 배열을 읽어 공개 도구 URL을 자동 반영합니다.
 */

header('Content-Type: application/xml; charset=UTF-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: public, max-age=600');

const REGISTRY_FILE = __DIR__ . DIRECTORY_SEPARATOR . 'assets' . DIRECTORY_SEPARATOR . 'tools-registry.js';
const DEFAULT_CONFIG_FILE = __DIR__ . DIRECTORY_SEPARATOR . 'admin' . DIRECTORY_SEPARATOR . 'site-config.json';
const RUNTIME_CONFIG_FILE = __DIR__ . DIRECTORY_SEPARATOR . 'admin' . DIRECTORY_SEPARATOR . 'data' . DIRECTORY_SEPARATOR . 'site-config.json';

function xml_escape($value) {
  return htmlspecialchars((string) $value, ENT_XML1 | ENT_QUOTES, 'UTF-8');
}

function request_is_https() {
  if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
    return true;
  }
  $forwarded = isset($_SERVER['HTTP_X_FORWARDED_PROTO'])
    ? strtolower((string) $_SERVER['HTTP_X_FORWARDED_PROTO'])
    : '';
  if ($forwarded === 'https') {
    return true;
  }
  return (isset($_SERVER['SERVER_PORT']) ? (int) $_SERVER['SERVER_PORT'] : 0) === 443;
}

function public_base_url() {
  $host = isset($_SERVER['HTTP_HOST']) && is_string($_SERVER['HTTP_HOST'])
    ? $_SERVER['HTTP_HOST']
    : 'tools.itmatzip.com';
  if (preg_match('/(^|\.)tools\.itmatzip\.com$/i', $host)) {
    return 'https://tools.itmatzip.com';
  }
  $scheme = request_is_https() ? 'https' : 'http';
  return $scheme . '://' . $host;
}

function read_json_file($path) {
  if (!is_file($path)) {
    return null;
  }
  $raw = file_get_contents($path);
  if (!is_string($raw) || $raw === '') {
    return null;
  }
  $data = json_decode($raw, true);
  return is_array($data) ? $data : null;
}

function hidden_tool_ids() {
  $cfg = read_json_file(RUNTIME_CONFIG_FILE);
  if (!is_array($cfg)) {
    $cfg = read_json_file(DEFAULT_CONFIG_FILE);
  }
  $hidden = array();
  if (is_array($cfg) && isset($cfg['hiddenToolIds']) && is_array($cfg['hiddenToolIds'])) {
    foreach ($cfg['hiddenToolIds'] as $id) {
      if (is_string($id) && $id !== '') {
        $hidden[$id] = true;
      }
    }
  }
  return $hidden;
}

function parse_tools_registry($path) {
  $tools = array();
  if (!is_file($path)) {
    return $tools;
  }
  $raw = file_get_contents($path);
  if (!is_string($raw) || !preg_match('/export const TOOLS = \[(.*)\];/s', $raw, $m)) {
    return $tools;
  }
  if (!preg_match_all('/\{([^{}]+)\}/', $m[1], $blocks)) {
    return $tools;
  }
  foreach ($blocks[1] as $block) {
    if (!preg_match('/\bid:\s*"([^"]+)"/', $block, $id)) {
      continue;
    }
    if (!preg_match('/\bhref:\s*"([^"]+)"/', $block, $href)) {
      continue;
    }
    $available = true;
    if (preg_match('/\bavailable:\s*(true|false)/', $block, $av)) {
      $available = $av[1] === 'true';
    }
    $tools[] = array(
      'id' => $id[1],
      'href' => $href[1],
      'available' => $available,
    );
  }
  return $tools;
}

function iso_date($timestamp) {
  return gmdate('Y-m-d', (int) $timestamp);
}

function url_lastmod($relativeHref) {
  $rel = str_replace('\\', '/', (string) $relativeHref);
  $rel = trim($rel, '/');
  $candidates = array(
    __DIR__ . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel) . DIRECTORY_SEPARATOR . 'index.html',
    __DIR__ . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $rel),
  );
  foreach ($candidates as $path) {
    if (is_file($path)) {
      return filemtime($path);
    }
  }
  if (is_file(REGISTRY_FILE)) {
    return filemtime(REGISTRY_FILE);
  }
  return time();
}

$base = public_base_url();
$hidden = hidden_tool_ids();
$homeMtime = is_file(__DIR__ . DIRECTORY_SEPARATOR . 'index.html')
  ? filemtime(__DIR__ . DIRECTORY_SEPARATOR . 'index.html')
  : time();

$urls = array(
  array(
    'loc' => $base . '/',
    'lastmod' => iso_date($homeMtime),
    'changefreq' => 'daily',
    'priority' => '1.0',
  ),
);

foreach (parse_tools_registry(REGISTRY_FILE) as $tool) {
  if (empty($tool['available'])) {
    continue;
  }
  if (isset($hidden[$tool['id']])) {
    continue;
  }
  $href = ltrim((string) $tool['href'], '/');
  if ($href === '' || strpos($href, '..') !== false || preg_match('#^[a-z][a-z0-9+.-]*:#i', $href)) {
    continue;
  }
  $urls[] = array(
    'loc' => $base . '/' . $href,
    'lastmod' => iso_date(url_lastmod($href)),
    'changefreq' => 'weekly',
    'priority' => '0.8',
  );
}

$langs = array('ko', 'en', 'ja', 'zh');

function lang_prefix($lang) {
  return $lang === 'ko' ? 'kr' : $lang;
}

function lang_url($baseLoc, $lang) {
  $host = public_base_url();
  $path = substr((string) $baseLoc, strlen($host));
  $prefix = lang_prefix($lang);
  if ($path === '' || $path === '/') {
    return $host . '/' . $prefix . '/';
  }
  return $host . '/' . $prefix . $path;
}

function emit_url($loc, $lastmod, $changefreq, $priority, $alternates) {
  echo "  <url>\n";
  echo '    <loc>' . xml_escape($loc) . "</loc>\n";
  echo '    <lastmod>' . xml_escape($lastmod) . "</lastmod>\n";
  echo '    <changefreq>' . xml_escape($changefreq) . "</changefreq>\n";
  echo '    <priority>' . xml_escape($priority) . "</priority>\n";
  foreach ($alternates as $hreflang => $href) {
    echo '    <xhtml:link rel="alternate" hreflang="' . xml_escape($hreflang) . '" href="' . xml_escape($href) . "\" />\n";
  }
  echo "  </url>\n";
}

$legal = array(
  array('loc' => $base . '/legal/about.html', 'priority' => '0.4'),
  array('loc' => $base . '/legal/policy.html', 'priority' => '0.4'),
  array('loc' => $base . '/legal/email.html', 'priority' => '0.3'),
  array('loc' => $base . '/legal/copyright.html', 'priority' => '0.3'),
  array('loc' => $base . '/legal/disclaimer.html', 'priority' => '0.4'),
);
foreach ($legal as $item) {
  $rel = str_replace($base, '', $item['loc']);
  $path = __DIR__ . str_replace('/', DIRECTORY_SEPARATOR, $rel);
  $mtime = is_file($path) ? filemtime($path) : $homeMtime;
  $urls[] = array(
    'loc' => $item['loc'],
    'lastmod' => iso_date($mtime),
    'changefreq' => 'monthly',
    'priority' => $item['priority'],
  );
}

echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n";
echo '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">' . "\n";
foreach ($urls as $url) {
  $alternates = array();
  foreach ($langs as $lang) {
    $alternates[$lang] = lang_url($url['loc'], $lang);
  }
  $alternates['x-default'] = lang_url($url['loc'], 'ko');
  foreach ($langs as $lang) {
    emit_url(lang_url($url['loc'], $lang), $url['lastmod'], $url['changefreq'], $url['priority'], $alternates);
  }
}
echo "</urlset>\n";
