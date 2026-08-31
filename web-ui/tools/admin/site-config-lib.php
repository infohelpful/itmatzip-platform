<?php
declare(strict_types=1);

const ITZ_ADMIN_DIR = __DIR__;
const DEFAULT_CONFIG_FILE = ITZ_ADMIN_DIR . DIRECTORY_SEPARATOR . 'site-config.json';
const DATA_DIR = ITZ_ADMIN_DIR . DIRECTORY_SEPARATOR . 'data';
const RUNTIME_CONFIG_FILE = DATA_DIR . DIRECTORY_SEPARATOR . 'site-config.json';
const OG_PUBLIC_DIR = 'assets/og';
const OG_FS_DIR = ITZ_ADMIN_DIR . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . 'assets' . DIRECTORY_SEPARATOR . 'og';
const DEFAULT_OG_IMAGE = '/assets/og-image.png';
const DEFAULT_ADS_CLIENT = 'ca-pub-2088466558007407';

const ALLOWED_TOOL_IDS = array(
  'silence-remover',
  'auto-subtitle',
  'vocal-remover',
  'audio-join',
  'image-enhancer',
  'background-remover',
  'create-music',
  'magic-eraser',
  'voice-changer',
  'watermark-remover',
  'thumbnail-grabber',
  'ico-maker',
  'image-combiner',
  'unattend-maker',
  'online-clock',
  'json-formatter',
  'currency-calculator',
);

const ALLOWED_AD_UNITS = array(
  'dashboardBanner',
  'editorAboveWorkspace',
  'editorBelowExport',
  'downloadTop',
  'downloadBottom',
);

const TOOL_AD_UNITS = array(
  'editorAboveWorkspace',
  'editorBelowExport',
  'downloadTop',
  'downloadBottom',
);

const ALLOWED_LANGS = array('ko', 'en', 'ja', 'zh');

const ALLOWED_LEGAL_IDS = array(
  'about',
  'policy',
  'email',
  'copyright',
  'disclaimer',
);

const SEO_HTML_LANG = array(
  'ko' => 'ko',
  'en' => 'en',
  'ja' => 'ja',
  'zh' => 'zh-CN',
);

const SEO_OG_LOCALE = array(
  'ko' => 'ko_KR',
  'en' => 'en_US',
  'ja' => 'ja_JP',
  'zh' => 'zh_CN',
);

function ensure_data_dir() {
  if (!is_dir(DATA_DIR)) {
    mkdir(DATA_DIR, 0700, true);
  }
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

function write_json_file($path, array $data) {
  $dir = dirname($path);
  if (!is_dir($dir)) {
    mkdir($dir, 0700, true);
  }
  $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
  if ($json === false) {
    return false;
  }
  $json .= "\n";
  $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
  if (file_put_contents($tmp, $json, LOCK_EX) === false) {
    return false;
  }
  if (@rename($tmp, $path)) {
    return true;
  }
  $copied = @copy($tmp, $path);
  @unlink($tmp);
  if ($copied) {
    return true;
  }
  return file_put_contents($path, $json, LOCK_EX) !== false;
}

function itz_clip($value, $max) {
  $s = trim((string) $value);
  if ($s === '') {
    return '';
  }
  $s = strip_tags($s);
  $normalized = @preg_replace('/\s+/u', ' ', $s);
  if (is_string($normalized)) {
    $s = trim($normalized);
  } else {
    $s = trim($s);
  }
  if ($s === '') {
    return '';
  }
  if (function_exists('mb_substr') && function_exists('mb_strlen')) {
    if (mb_strlen($s, 'UTF-8') > $max) {
      return mb_substr($s, 0, $max, 'UTF-8');
    }
    return $s;
  }
  return strlen($s) > $max ? substr($s, 0, $max) : $s;
}

function parse_tool_id_list($raw) {
  $out = array();
  if (!is_array($raw)) {
    return $out;
  }
  foreach ($raw as $id) {
    if (is_string($id) && in_array($id, ALLOWED_TOOL_IDS, true)) {
      $out[] = $id;
    }
  }
  return array_values(array_unique($out));
}

function default_mobile_enabled_tool_ids() {
  return parse_tool_id_list(array(
    'thumbnail-grabber',
    'ico-maker',
    'image-combiner',
    'online-clock',
    'unattend-maker',
    'json-formatter',
    'currency-calculator',
  ));
}

function normalize_ads_client($value, $required) {
  $client = is_string($value) ? trim($value) : '';
  if ($client === '' || !preg_match('/^ca-pub-\d{8,22}$/', $client)) {
    return $required ? DEFAULT_ADS_CLIENT : '';
  }
  return $client;
}

function normalize_slot($value) {
  $slot = is_string($value) ? trim($value) : '';
  if ($slot !== '' && !preg_match('/^\d{6,20}$/', $slot)) {
    return '';
  }
  return $slot;
}

function empty_lang_map() {
  $out = array();
  foreach (ALLOWED_LANGS as $lang) {
    $out[$lang] = '';
  }
  return $out;
}

function normalize_lang_map($raw, $max) {
  $out = empty_lang_map();
  if (!is_array($raw)) {
    return $out;
  }
  foreach (ALLOWED_LANGS as $lang) {
    if (!array_key_exists($lang, $raw)) {
      continue;
    }
    $v = $raw[$lang];
    if (is_string($v)) {
      $out[$lang] = itz_clip($v, $max);
    } elseif (is_int($v) || is_float($v)) {
      $out[$lang] = itz_clip((string) $v, $max);
    }
  }
  return $out;
}

function empty_meta() {
  return array(
    'title' => '',
    'description' => '',
    'keywords' => '',
  );
}

function normalize_meta_fields($raw) {
  $src = is_array($raw) ? $raw : array();
  return array(
    'title' => itz_clip($src['title'] ?? '', 80),
    'description' => itz_clip($src['description'] ?? '', 320),
    'keywords' => itz_clip($src['keywords'] ?? '', 500),
  );
}

function fill_empty_meta_langs($meta, $fallback) {
  $out = normalize_meta_langs($meta);
  $fb = is_array($fallback) ? $fallback : array();
  foreach (ALLOWED_LANGS as $lang) {
    $src = (isset($fb[$lang]) && is_array($fb[$lang])) ? $fb[$lang] : array();
    foreach (array('title' => 80, 'description' => 320, 'keywords' => 500) as $field => $max) {
      if (($out[$lang][$field] ?? '') === '') {
        $out[$lang][$field] = itz_clip($src[$field] ?? '', $max);
      }
    }
  }
  return $out;
}

function normalize_meta_langs($raw) {
  $out = array();
  $src = is_array($raw) ? $raw : array();
  foreach (ALLOWED_LANGS as $lang) {
    $out[$lang] = normalize_meta_fields($src[$lang] ?? null);
  }
  return $out;
}

function normalize_og_image($value) {
  $s = is_string($value) ? trim($value) : '';
  if ($s === '') {
    return '';
  }
  if (!preg_match('#^/assets/og/[a-zA-Z0-9._-]+\.(png|jpe?g|webp)$#i', $s)) {
    return '';
  }
  return $s;
}

function normalize_global_units($in_units, $base_units) {
  $units = array();
  foreach (ALLOWED_AD_UNITS as $key) {
    $src = array();
    if (isset($base_units[$key]) && is_array($base_units[$key])) {
      $src = $base_units[$key];
    }
    if (isset($in_units[$key]) && is_array($in_units[$key])) {
      $src = array_merge($src, $in_units[$key]);
    }
    $units[$key] = array(
      'enabled' => !isset($src['enabled']) || (bool) $src['enabled'],
      'slot' => normalize_slot($src['slot'] ?? ''),
      'adFormat' => isset($src['adFormat']) && is_string($src['adFormat']) ? $src['adFormat'] : 'horizontal',
      'fullWidthResponsive' => !isset($src['fullWidthResponsive']) || (bool) $src['fullWidthResponsive'],
    );
  }
  return $units;
}

function normalize_tool_ad_units($raw) {
  $out = array();
  if (!is_array($raw)) {
    return $out;
  }
  foreach (TOOL_AD_UNITS as $key) {
    if (!isset($raw[$key]) || !is_array($raw[$key])) {
      continue;
    }
    $src = $raw[$key];
    $has_enabled = array_key_exists('enabled', $src);
    $slot = normalize_slot($src['slot'] ?? '');
    if (!$has_enabled && $slot === '') {
      continue;
    }
    $out[$key] = array(
      'enabled' => $has_enabled ? (bool) $src['enabled'] : true,
      'slot' => $slot,
      'adFormat' => 'horizontal',
      'fullWidthResponsive' => true,
    );
  }
  return $out;
}

function normalize_tool_entry($raw) {
  $src = is_array($raw) ? $raw : array();
  $ads = (isset($src['adsense']) && is_array($src['adsense'])) ? $src['adsense'] : array();
  return array(
    'title' => normalize_lang_map($src['title'] ?? null, 80),
    'subtitle' => normalize_lang_map($src['subtitle'] ?? null, 80),
    'description' => normalize_lang_map($src['description'] ?? null, 200),
    'badge' => normalize_lang_map($src['badge'] ?? null, 48),
    'meta' => normalize_meta_langs($src['meta'] ?? null),
    'ogImage' => normalize_og_image($src['ogImage'] ?? ''),
    'adsense' => array(
      'client' => normalize_ads_client($ads['client'] ?? '', false),
      'units' => normalize_tool_ad_units($ads['units'] ?? null),
    ),
  );
}

function default_config() {
  $cfg = read_json_file(DEFAULT_CONFIG_FILE);
  if (!is_array($cfg)) {
    $cfg = array(
      'hiddenToolIds' => array(),
      'mobileEnabledToolIds' => default_mobile_enabled_tool_ids(),
      'adsense' => array(
        'enabled' => true,
        'client' => DEFAULT_ADS_CLIENT,
        'units' => array(),
      ),
    );
  }
  return $cfg;
}

function fill_empty_lang_map($current, $fallback, $max, $retired = null) {
  $out = normalize_lang_map($current, $max);
  $fb = normalize_lang_map($fallback, $max);
  $retired_set = array();
  if (is_array($retired)) {
    foreach ($retired as $item) {
      $retired_set[$item] = true;
    }
  }
  foreach (ALLOWED_LANGS as $lang) {
    $cur = $out[$lang];
    if (($cur === '' || isset($retired_set[$cur])) && $fb[$lang] !== '') {
      $out[$lang] = $fb[$lang];
    }
  }
  return $out;
}

function retired_watermark_display($field) {
  if ($field === 'title') {
    return array('Watermark Remover');
  }
  if ($field === 'subtitle') {
    return array(
      '고정 워터마크 제거 · ProPainter',
      'Fixed watermark · ProPainter',
      '固定ウォーターマーク除去 · ProPainter',
      '固定水印去除 · ProPainter',
    );
  }
  if ($field === 'description') {
    return array(
      '영상에서 워터마크 영역을 칠하면 ProPainter가 해당 부분만 지우고 일반 재생 가능한 영상으로 저장합니다.',
      'Paint the watermark region; ProPainter fills that area and saves a normal playable video.',
      '映像の透かし範囲を塗るとProPainterがその部分だけ消し、再生できる動画として保存します。',
      '涂出视频水印区域后，ProPainter 只修那一块并保存可播放的视频。',
    );
  }
  return array();
}

function merge_default_tool_display(array $tools, array $defaults, $raw_tools = null) {
  $def_tools = (isset($defaults['tools']) && is_array($defaults['tools'])) ? $defaults['tools'] : array();
  foreach (ALLOWED_TOOL_IDS as $id) {
    $row = (isset($tools[$id]) && is_array($tools[$id])) ? $tools[$id] : normalize_tool_entry(null);
    $def = (isset($def_tools[$id]) && is_array($def_tools[$id])) ? $def_tools[$id] : array();
    $retired_title = $id === 'watermark-remover' ? retired_watermark_display('title') : array();
    $retired_sub = $id === 'watermark-remover' ? retired_watermark_display('subtitle') : array();
    $retired_desc = $id === 'watermark-remover' ? retired_watermark_display('description') : array();
    $row['title'] = fill_empty_lang_map($row['title'] ?? null, $def['title'] ?? null, 80, $retired_title);
    $row['subtitle'] = fill_empty_lang_map($row['subtitle'] ?? null, $def['subtitle'] ?? null, 80, $retired_sub);
    $row['description'] = fill_empty_lang_map($row['description'] ?? null, $def['description'] ?? null, 200, $retired_desc);
    $raw_row = (is_array($raw_tools) && isset($raw_tools[$id]) && is_array($raw_tools[$id])) ? $raw_tools[$id] : null;
    if ($raw_row === null || !array_key_exists('badge', $raw_row)) {
      $row['badge'] = fill_empty_lang_map($row['badge'] ?? null, $def['badge'] ?? null, 48);
    } else {
      $row['badge'] = normalize_lang_map($raw_row['badge'], 48);
    }
    $tools[$id] = $row;
  }
  return $tools;
}

function apply_hub_description_limits(array $cfg, array $defaults) {
  $fb = $defaults['hub']['meta']['ko']['description'] ?? '';
  if (!is_string($fb) || trim($fb) === '') {
    return $cfg;
  }
  $cur = (string) ($cfg['hub']['meta']['ko']['description'] ?? '');
  $len = function_exists('mb_strlen') ? mb_strlen($cur, 'UTF-8') : strlen($cur);
  $mentions_caption = function_exists('mb_strpos')
    ? (mb_strpos($cur, '자막') !== false)
    : (strpos($cur, '자막') !== false);
  if ($len > 80 || $mentions_caption) {
    $cfg['hub']['meta']['ko']['description'] = itz_clip($fb, 80);
  }
  return $cfg;
}

function public_config() {
  $runtime = read_json_file(RUNTIME_CONFIG_FILE);
  $base = default_config();
  if (is_array($runtime)) {
    if (!isset($runtime['hub']) && isset($base['hub'])) {
      $runtime['hub'] = $base['hub'];
    }
    if (!isset($runtime['legal']) && isset($base['legal'])) {
      $runtime['legal'] = $base['legal'];
    }
    $cfg = normalize_config($runtime);
  } else {
    $cfg = normalize_config($base);
  }
  $raw_tools = (is_array($runtime) && isset($runtime['tools']) && is_array($runtime['tools']))
    ? $runtime['tools']
    : null;
  $cfg['tools'] = merge_default_tool_display($cfg['tools'], normalize_config($base), $raw_tools);
  $cfg = apply_hub_description_limits($cfg, $base);
  return $cfg;
}

function normalize_config(array $cfg) {
  $hidden = parse_tool_id_list($cfg['hiddenToolIds'] ?? null);
  if (array_key_exists('mobileEnabledToolIds', $cfg)) {
    $mobile = parse_tool_id_list($cfg['mobileEnabledToolIds']);
  } else {
    $mobile = default_mobile_enabled_tool_ids();
  }

  $ads = (isset($cfg['adsense']) && is_array($cfg['adsense'])) ? $cfg['adsense'] : array();
  $client = normalize_ads_client($ads['client'] ?? '', true);

  $base_units = array();
  $defaults = default_config();
  if (isset($defaults['adsense']['units']) && is_array($defaults['adsense']['units'])) {
    $base_units = $defaults['adsense']['units'];
  }
  $in_units = (isset($ads['units']) && is_array($ads['units'])) ? $ads['units'] : array();
  $units = normalize_global_units($in_units, $base_units);

  $hub_src = (isset($cfg['hub']) && is_array($cfg['hub'])) ? $cfg['hub'] : array();
  $hub = array(
    'meta' => normalize_meta_langs($hub_src['meta'] ?? null),
    'ogImage' => normalize_og_image($hub_src['ogImage'] ?? ''),
  );

  $legal_src = (isset($cfg['legal']) && is_array($cfg['legal'])) ? $cfg['legal'] : array();
  $legal = array();
  foreach (ALLOWED_LEGAL_IDS as $id) {
    $row = (isset($legal_src[$id]) && is_array($legal_src[$id])) ? $legal_src[$id] : array();
    $legal[$id] = array(
      'meta' => normalize_meta_langs($row['meta'] ?? null),
    );
  }

  $tools_src = (isset($cfg['tools']) && is_array($cfg['tools'])) ? $cfg['tools'] : array();
  $tools = array();
  foreach (ALLOWED_TOOL_IDS as $id) {
    $tools[$id] = normalize_tool_entry($tools_src[$id] ?? null);
  }

  $updated = 0;
  if (isset($cfg['updatedAt'])) {
    $updated = (int) $cfg['updatedAt'];
  }

  return array(
    'hiddenToolIds' => $hidden,
    'mobileEnabledToolIds' => $mobile,
    'adsense' => array(
      'enabled' => !isset($ads['enabled']) || (bool) $ads['enabled'],
      'client' => $client,
      'units' => $units,
    ),
    'hub' => $hub,
    'legal' => $legal,
    'tools' => $tools,
    'updatedAt' => $updated,
  );
}

function lang_url_prefix($lang) {
  return $lang === 'ko' ? 'kr' : $lang;
}

function meta_lang_value(array $meta_langs, $lang, $field) {
  if (!isset($meta_langs[$lang]) || !is_array($meta_langs[$lang])) {
    return '';
  }
  $v = $meta_langs[$lang][$field] ?? '';
  return is_string($v) ? trim($v) : '';
}

function bundled_og_path($kind, $id) {
  $name = 'hub';
  if ($kind === 'tool' && is_string($id) && preg_match('/^[a-z0-9-]+$/', $id)) {
    $name = $id;
  }
  $rel = '/assets/og/' . $name . '.png';
  $fs = OG_FS_DIR . DIRECTORY_SEPARATOR . $name . '.png';
  if (is_file($fs)) {
    return $rel;
  }
  if ($name !== 'hub' && is_file(OG_FS_DIR . DIRECTORY_SEPARATOR . 'hub.png')) {
    return '/assets/og/hub.png';
  }
  return DEFAULT_OG_IMAGE;
}

function resolve_og_path(array $cfg, $kind, $id) {
  if ($kind === 'tool' && $id !== '') {
    $tool = $cfg['tools'][$id] ?? null;
    if (is_array($tool) && !empty($tool['ogImage'])) {
      return $tool['ogImage'];
    }
    return bundled_og_path('tool', $id);
  }
  $hub = $cfg['hub']['ogImage'] ?? '';
  if (is_string($hub) && $hub !== '') {
    return $hub;
  }
  return bundled_og_path('hub', 'hub');
}

function page_seo_fields(array $cfg, $kind, $id, $lang) {
  $title = '';
  $description = '';
  $keywords = '';
  if ($kind === 'hub') {
    $title = meta_lang_value($cfg['hub']['meta'], $lang, 'title');
    $description = meta_lang_value($cfg['hub']['meta'], $lang, 'description');
    $keywords = meta_lang_value($cfg['hub']['meta'], $lang, 'keywords');
  } elseif ($kind === 'legal' && isset($cfg['legal'][$id])) {
    $title = meta_lang_value($cfg['legal'][$id]['meta'], $lang, 'title');
    $description = meta_lang_value($cfg['legal'][$id]['meta'], $lang, 'description');
    $keywords = meta_lang_value($cfg['legal'][$id]['meta'], $lang, 'keywords');
  } elseif (($kind === 'tool' || $kind === 'download') && isset($cfg['tools'][$id])) {
    $title = meta_lang_value($cfg['tools'][$id]['meta'], $lang, 'title');
    $description = meta_lang_value($cfg['tools'][$id]['meta'], $lang, 'description');
    $keywords = meta_lang_value($cfg['tools'][$id]['meta'], $lang, 'keywords');
  }
  return array(
    'title' => $title,
    'description' => $description,
    'keywords' => $keywords,
    'ogImage' => resolve_og_path($cfg, $kind === 'download' ? 'tool' : $kind, $id),
    'displayTitle' => ($kind === 'tool' && isset($cfg['tools'][$id]))
      ? trim((string) ($cfg['tools'][$id]['title'][$lang] ?? ''))
      : '',
  );
}

function ensure_og_dir() {
  if (!is_dir(OG_FS_DIR)) {
    mkdir(OG_FS_DIR, 0755, true);
  }
}
